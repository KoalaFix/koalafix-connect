// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// How a hook talks to the hosted server project.mjs found: speak just enough MCP over HTTP (and the read API's brief
// route) to get what the hook needs, stay inside a wall-clock budget, and print without a credential.
// A server that is down gets a cool-off (offline.mjs): until it ends, a request fails at once with ServerOfflineError.
// Plain ESM, Node 22 APIs only, no dependencies.

import { ServerOfflineError, assertOnline, markOffline, markOnline, originKey } from "./offline.mjs";

export const PROTOCOL_VERSION = "2025-11-25";
/**
 * Core maps the User-Agent built from this name to the client family "claude-code". A target that carries its own
 * `clientInfo` (client.mjs, for a hook run with `--client`) is named that instead.
 */
const CLIENT_INFO = { name: "kalibrate-claude-code-hook", version: "0.2.0" };
const infoOf = (target) => target.clientInfo ?? CLIENT_INFO;
const userAgentOf = (target) => `${infoOf(target).name}/${infoOf(target).version}`;
/** The `_meta` field the server takes a replayed call's idempotency key from. */
export const IDEMPOTENCY_META = "kalibrate/idempotencyKey";
/** The `_meta` flag that keeps a recall's question out of the server's query log and gap items (KOA2-42). */
export const UNLOGGED_META = "kalibrate/unlogged";

/**
 * JSON-RPC codes that mean the server wants the handshake before the call, not that the call failed: an invalid
 * request and an unknown method. The MCP SDK's stateful "not initialized" refusal comes as HTTP 400, caught by status;
 * a bare -32000 is any server error, possibly after the tool ran, so it never triggers a second send.
 */
const HANDSHAKE_CODES = new Set([-32600, -32601]);

/**
 * The server answered, but the call failed: a tool's refusal (`isError`) or a JSON-RPC error. Not a reason to spool.
 * `code` is the JSON-RPC error code, or null for a tool's refusal.
 */
export class ToolError extends Error {
  /**
   * @param {string} message
   * @param {string | number | null} [code] the tool's refusal code (`rate_limited`), or the JSON-RPC error code
   */
  constructor(message, code = null) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

/** An HTTP answer outside 2xx: the server was reached and refused the request (or, for 5xx, is failing). */
export class HttpStatusError extends Error {
  /**
   * @param {number} status
   * @param {string} [message]
   */
  constructor(status, message = `the server answered HTTP ${status}`) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/** The hook's wall-clock budget ran out before the work finished. */
export class BudgetExpiredError extends Error {
  /** @param {number} budgetMs */
  constructor(budgetMs) {
    super(`timed out after ${budgetMs} ms`);
    this.name = "BudgetExpiredError";
  }
}

/**
 * Whether a hook's failure means the server is down rather than refusing: no connection, a 5xx, a timeout, or a
 * cool-off still running. Session start then tells the model memory is offline (offline.mjs).
 */
export function isServerDown(error) {
  if (error instanceof ServerOfflineError || error instanceof BudgetExpiredError) {
    return true;
  }
  if (error instanceof HttpStatusError) {
    return error.status >= 500;
  }
  return error instanceof Error && (error.name === "TimeoutError" || (error.name === "TypeError" && /fetch failed/i.test(error.message)));
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Takes out anything shaped like a credential: core's `kal_` tokens and whatever follows "Bearer". */
export function redact(text) {
  return text.replace(/kal_[a-z0-9]{8}_[A-Za-z0-9]+/g, "kal_<redacted>").replace(/(bearer\s+)\S+/gi, "$1<redacted>");
}

/** One line, at most 300 characters, never a credential: what a hook may print about an error. */
export function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error);
  return redact(text.split(/\r?\n/)[0] ?? "").slice(0, 300);
}

/**
 * Default wall-clock budgets in ms. Stop runs at the end of a turn with a 5 s configured timeout, room for a cold
 * connection; a hook that runs at session end must fit the client's short window (Claude Code allows about 1.5 s),
 * which is why Gemini CLI, whose stop script runs at SessionEnd, keeps `stopAtSessionEnd`.
 */
export const BUDGETS = { sessionStart: 8000, stop: 2500, stopAtSessionEnd: 1200, prompt: 1500, sessionEnd: 1200 };

/** The wall-clock budget in ms: KALIBRATE_HOOK_BUDGET_MS when it is a positive number, else the hook's default. */
export function budgetFrom(env, fallbackMs) {
  const value = Number.parseInt(env.KALIBRATE_HOOK_BUDGET_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

/** Every request in flight, by its controller, with the origin it went to. */
const aborters = new Map();
/** Origins that answered in this run: a budget that runs out after an answer does not make that server "down". */
const answered = new Set();

/**
 * Aborts every request still in flight, so a hook that ran out of budget leaves nothing open behind it. When the
 * budget `expired`, each origin still owing an answer, and silent all run, gets a cool-off: the server is hung.
 */
function abortAll(expired = false) {
  for (const [controller, origin] of aborters) {
    if (expired && !answered.has(origin)) {
      markOffline(origin, "no answer inside the hook's budget");
    }
    controller.abort();
  }
  aborters.clear();
}

function rpcFailure(error) {
  return new ToolError(`rpc error ${error.code}: ${String(error.message).slice(0, 200)}`, typeof error.code === "number" ? error.code : null);
}

/** Reads the reply to request `id` out of a Streamable HTTP response body: one JSON document, or an event stream. */
export function parseRpcBody(text, contentType, id) {
  const messages = [];
  if (/text\/event-stream/i.test(contentType)) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      try {
        messages.push(JSON.parse(data));
      } catch {
        // a comment, a ping or a partial event
      }
    }
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("the response is not JSON");
    }
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  const reply = messages.find((message) => isRecord(message) && message.id === id && ("result" in message || "error" in message));
  if (reply === undefined) {
    throw new Error("the response held no JSON-RPC reply");
  }
  if (isRecord(reply.error)) {
    throw rpcFailure(reply.error);
  }
  return reply.result;
}

/**
 * A fetch inside the budget that abortAll can abort; redirects are refused, so the token stays on its host. It fails
 * at once while the server's cool-off runs, starts one when the server is down, and clears it on any answer below 500.
 */
async function fetchWithin(url, init, deadlineAt) {
  assertOnline(url);
  const origin = originKey(url);
  const controller = new AbortController();
  aborters.set(controller, origin);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]),
    });
    if (response.status >= 500) {
      markOffline(origin, `HTTP ${response.status}`);
    } else {
      answered.add(origin);
      markOnline(origin);
    }
    return response;
  } catch (error) {
    // AbortError is abortAll's: it records a budget that ran out itself, and a plain abort after the work is no failure.
    if (!(error instanceof Error && error.name === "AbortError") && !answered.has(origin)) {
      markOffline(origin, messageOf(error));
    }
    throw error;
  } finally {
    aborters.delete(controller);
  }
}

function openHttp(target, deadlineAt, protocolVersion = null) {
  let nextId = 1;
  let sessionId = null;
  let version = protocolVersion;
  const post = async (body) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${target.token}`,
      "user-agent": userAgentOf(target),
    };
    if (sessionId !== null) {
      headers["mcp-session-id"] = sessionId;
    }
    if (version !== null) {
      headers["mcp-protocol-version"] = version;
    }
    const response = await fetchWithin(target.url, { method: "POST", headers, body: JSON.stringify(body) }, deadlineAt);
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpStatusError(response.status);
    }
    return { text: await response.text(), type: response.headers.get("content-type") ?? "" };
  };
  return {
    async request(method, params) {
      const id = nextId++;
      const { text, type } = await post({ jsonrpc: "2.0", id, method, params });
      const result = parseRpcBody(text, type, id);
      if (method === "initialize" && isRecord(result) && typeof result.protocolVersion === "string") {
        version = result.protocolVersion;
      }
      return result;
    },
    async notify(method, params) {
      await post({ jsonrpc: "2.0", method, params });
    },
  };
}

/** The full MCP handshake, `initialize` and `notifications/initialized`, for a server that wants it. */
async function handshake(target, deadlineAt) {
  const session = openHttp(target, deadlineAt);
  await session.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: infoOf(target) });
  await session.notify("notifications/initialized");
  return session;
}

/** Whether a failed request means the server wants `initialize` first: an HTTP 400 or a handshake JSON-RPC code. */
function wantsHandshake(error) {
  return (error instanceof HttpStatusError && error.status === 400) || (error instanceof ToolError && HANDSHAKE_CODES.has(error.code));
}

/**
 * The session every hook uses, with no handshake (KOA2-64): each request goes out alone with the
 * `MCP-Protocol-Version` header, which the stateless server takes in place of `initialize`, so a call costs one HTTP
 * request. A server that wants the handshake gets it once, shared by every request in flight; each refused request is
 * sent again once over it and never retried after that. `fallback` is then the one-line reason, for the hook to log.
 */
export function connect(target, deadlineAt) {
  const direct = openHttp(target, deadlineAt, PROTOCOL_VERSION);
  let handshaken = null;
  const session = {
    fallback: null,
    async request(method, params) {
      if (handshaken === null) {
        try {
          return await direct.request(method, params);
        } catch (error) {
          if (!wantsHandshake(error)) {
            throw error;
          }
          if (handshaken === null) {
            session.fallback = messageOf(error);
            handshaken = handshake(target, deadlineAt);
          }
        }
      }
      return (await handshaken).request(method, params);
    },
    async notify(method, params) {
      await (handshaken === null ? direct : await handshaken).notify(method, params);
    },
  };
  return session;
}

/**
 * One GET on the read API (`route` starts `/api/v1/`), under the budget and the breaker like every other hook request:
 * the parsed JSON body, or HttpStatusError when the server answers anything but 2xx.
 */
export async function readApi(target, route, deadlineAt) {
  const name = `GET ${route.split("?")[0]}`;
  const headers = { accept: "application/json", authorization: `Bearer ${target.token}`, "user-agent": userAgentOf(target) };
  const response = await fetchWithin(`${target.api}${route}`, { method: "GET", headers }, deadlineAt);
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpStatusError(response.status, `${name} answered HTTP ${response.status}`);
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new Error(`${name} answered something that is not JSON`);
  }
}

/**
 * The session brief (Part A 4.6) over the read API: `GET <server>/api/v1/brief` answers `{ as_of, brief, tokens }`.
 * `repo` (provenance.mjs `reportedRepo`) puts the team decisions that name it first (ADR-0041); a server from before
 * ignores it.
 */
export async function fetchBrief(target, deadlineAt, repo = null) {
  const route = repo === null ? "/api/v1/brief" : `/api/v1/brief?repo=${encodeURIComponent(repo)}`;
  const body = await readApi(target, route, deadlineAt);
  if (!isRecord(body) || typeof body.brief !== "string") {
    throw new Error("GET /api/v1/brief answered no brief");
  }
  return body.brief;
}

/**
 * Calls one tool. Core answers with one text part (`content[0].text`) and the same data as `structuredContent`.
 * Throws ToolError when the tool refuses (`isError`); its text is core's `error: <code>: <message>` line.
 */
export async function callTool(session, name, args, meta) {
  const params = { name, arguments: args };
  if (meta !== undefined) {
    params._meta = meta;
  }
  const result = await session.request("tools/call", params);
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  const text = isRecord(first) && first.type === "text" && typeof first.text === "string" ? first.text : "";
  if (isRecord(result) && result.isError === true) {
    // Core's refusal text starts `error: <code>:`; the code lets a caller tell a write limit from a bad call.
    const code = /^error: ([a-z_]+):/.exec(text)?.[1] ?? null;
    throw new ToolError(`${name} returned an error: ${text.slice(0, 200)}`, code);
  }
  return { text, structured: isRecord(result) ? result.structuredContent : undefined };
}

/**
 * Runs `work(deadlineAt)` inside a wall-clock budget. Resolves to { ok: true, value } or { ok: false, error }, and
 * always aborts any request still in flight. A late failure of work that already lost the race is swallowed.
 */
export async function runWithBudget(budgetMs, work) {
  const deadlineAt = Date.now() + budgetMs;
  let timer;
  const expired = Symbol("expired");
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(expired), budgetMs)));
  const running = Promise.resolve().then(() => work(deadlineAt));
  running.catch(() => {});
  let ranOut = false;
  try {
    const value = await Promise.race([running, timeout]);
    ranOut = value === expired;
    return ranOut ? { ok: false, error: new BudgetExpiredError(budgetMs) } : { ok: true, value };
  } catch (error) {
    // A request's own timeout ends at the same instant as the budget and can fire first: it is the same timeout.
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? new BudgetExpiredError(budgetMs) : error };
  } finally {
    clearTimeout(timer);
    abortAll(ranOut);
  }
}

/**
 * Writes both streams, then lets the process end by itself with exit code 0. A hook always exits 0: it must never
 * block the session. It does not call process.exit() straight away, because on Windows exiting while an HTTP
 * connection is still closing crashes Node (a libuv assertion); the timer is only a backstop for a stray handle.
 */
export function finish({ stdout = "", stderr = "" }) {
  process.exitCode = 0;
  process.stdin.destroy();
  const write = (stream, text) => (text === "" ? Promise.resolve() : new Promise((resolve) => stream.write(text, resolve)));
  Promise.all([write(process.stderr, redact(stderr)), write(process.stdout, stdout)]).then(() => setTimeout(() => process.exit(0), 200).unref());
}
