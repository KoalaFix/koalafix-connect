// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// How a hook talks to the server project.mjs found: speak just enough MCP over stdio or HTTP (and, hosted, the read
// API's brief route) to get what the hook needs, stay inside a wall-clock budget, and print without a credential.
// Plain ESM, Node 22 APIs only, no dependencies.

import { spawn, spawnSync } from "node:child_process";

export const PROTOCOL_VERSION = "2025-11-25";
/**
 * Core maps this name (stdio) and the User-Agent built from it (HTTP) to the client family "claude-code". A target
 * that carries its own `clientInfo` (client.mjs, for a hook run with `--client`) is named that instead.
 */
const CLIENT_INFO = { name: "kalibrate-claude-code-hook", version: "0.2.0" };
const infoOf = (target) => target.clientInfo ?? CLIENT_INFO;
const userAgentOf = (target) => `${infoOf(target).name}/${infoOf(target).version}`;
/** The session brief is this resource over MCP (Part A 4.6), and `GET /api/v1/brief` over the read API. */
export const BRIEF_URI = "kalibrate://brief";
/** The `_meta` field the server takes a replayed call's idempotency key from. */
export const IDEMPOTENCY_META = "kalibrate/idempotencyKey";
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** How long a stdio server gets to exit by itself once its stdin closes, before it is killed. */
const GRACE_MS = 300;
/** Commands that are `.cmd` shims on Windows and cannot be started without cmd.exe. */
const WINDOWS_SHIMS = new Set(["npx", "npm", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack", "bunx"]);

/** The server answered, but the call failed: a tool's refusal (`isError`) or a JSON-RPC error. Not a reason to spool. */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
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

function cmdQuote(part) {
  if (part.includes('"')) {
    throw new Error("cannot pass a double quote through cmd.exe");
  }
  return part === "" || /[\s&|<>^()%!,;=]/.test(part) ? `"${part}"` : part;
}

/**
 * How to start a command with no shell. On Windows the package-manager commands and `.cmd`/`.bat` files are shims
 * that only cmd.exe runs: those get one quoted command line after `/d /s /c`, passed verbatim, so a path with a
 * space survives cmd's quote stripping. Everything else starts directly.
 */
export function windowsWrap(command, args, platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return { command, args, viaCmd: false, verbatim: false };
  }
  const bare = !/[\\/]/.test(command);
  const name = command.toLowerCase().replace(/\.(cmd|bat|exe)$/, "");
  if (/\.(cmd|bat)$/i.test(command) || (bare && WINDOWS_SHIMS.has(name))) {
    const line = [command, ...args].map(cmdQuote).join(" ");
    return { command: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], viaCmd: true, verbatim: true };
  }
  return { command, args, viaCmd: false, verbatim: false };
}

const children = new Set();
const aborters = new Set();

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function kill(child) {
  if (exited(child)) {
    return;
  }
  if (process.platform === "win32" && child.viaCmd && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, timeout: 500 });
  } else {
    child.kill();
  }
}

/**
 * Aborts any request in flight and stops every server process this hook started: its stdin is closed (the real
 * server then closes its store and exits), and whatever is still running after `graceMs` is killed.
 */
export async function closeAll(graceMs = 0) {
  for (const controller of aborters) {
    controller.abort();
  }
  aborters.clear();
  const running = [...children];
  children.clear();
  await Promise.all(
    running.map(async (child) => {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      if (!exited(child) && graceMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      kill(child);
    }),
  );
}

function rpcFailure(error) {
  return new ToolError(`rpc error ${error.code}: ${String(error.message).slice(0, 200)}`);
}

function openStdio(target) {
  const wrapped = windowsWrap(target.command, target.args);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: target.cwd,
    env: { ...process.env, ...target.env },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    windowsVerbatimArguments: wrapped.verbatim,
  });
  child.viaCmd = wrapped.viaCmd;
  children.add(child);
  const pending = new Map();
  let nextId = 1;
  let dead = null;
  let buffer = "";
  const fail = (error) => {
    dead ??= error;
    for (const { reject } of pending.values()) {
      reject(dead);
    }
    pending.clear();
  };
  const send = (message) => {
    if (dead === null) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };
  const handle = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || message.id === undefined) {
      return;
    }
    if (typeof message.method === "string") {
      send(message.method === "ping" ? { jsonrpc: "2.0", id: message.id, result: {} } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    const waiting = pending.get(message.id);
    if (waiting === undefined) {
      return;
    }
    pending.delete(message.id);
    if (isRecord(message.error)) {
      waiting.reject(rpcFailure(message.error));
    } else {
      waiting.resolve(message.result);
    }
  };
  child.on("error", (error) => fail(new Error(`cannot start the server: ${error.message}`)));
  child.on("close", (code) => fail(new Error(`the server exited (code ${code ?? "none"}) before it answered`)));
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_CHARS) {
      fail(new Error("the server sent an oversized line"));
      return;
    }
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== "") {
        handle(line);
      }
    }
  });
  return {
    request(method, params) {
      if (dead !== null) {
        return Promise.reject(dead);
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    async notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
  };
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

/** A fetch inside the budget that closeAll can abort; redirects are refused, so the token stays on its host. */
function fetchWithin(url, init, deadlineAt) {
  const controller = new AbortController();
  aborters.add(controller);
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]),
  }).finally(() => aborters.delete(controller));
}

function openHttp(target, deadlineAt) {
  let nextId = 1;
  let sessionId = null;
  let version = null;
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
      throw new Error(`the server answered HTTP ${response.status}`);
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

/** Opens a session: starts or reaches the server, then `initialize` and `notifications/initialized`. */
export async function connect(target, deadlineAt) {
  const session = target.kind === "stdio" ? openStdio(target) : openHttp(target, deadlineAt);
  await session.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: infoOf(target) });
  await session.notify("notifications/initialized");
  return session;
}

/** The session brief over MCP: `resources/read kalibrate://brief`, whose `contents[0].text` is the brief. */
export async function readBrief(session) {
  const result = await session.request("resources/read", { uri: BRIEF_URI });
  const first = isRecord(result) && Array.isArray(result.contents) ? result.contents[0] : undefined;
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error("resources/read returned no brief text");
  }
  return first.text;
}

/** The session brief over the read API (hosted): `GET <server>/api/v1/brief` answers `{ as_of, brief, tokens }`. */
export async function fetchBrief(target, deadlineAt) {
  const headers = { accept: "application/json", authorization: `Bearer ${target.token}`, "user-agent": userAgentOf(target) };
  const response = await fetchWithin(`${target.api}/api/v1/brief`, { method: "GET", headers }, deadlineAt);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET /api/v1/brief answered HTTP ${response.status}`);
  }
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error("GET /api/v1/brief answered something that is not JSON");
  }
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
    throw new ToolError(`${name} returned an error: ${text.slice(0, 200)}`);
  }
  return { text, structured: isRecord(result) ? result.structuredContent : undefined };
}

/**
 * Runs `work(deadlineAt)` inside a wall-clock budget. Resolves to { ok: true, value } or { ok: false, error }, and
 * always stops any server process it started (with a short grace out of what is left of the budget). A late
 * failure of work that already lost the race is swallowed.
 */
export async function runWithBudget(budgetMs, work) {
  const deadlineAt = Date.now() + budgetMs;
  let timer;
  const expired = Symbol("expired");
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(expired), budgetMs)));
  const running = Promise.resolve().then(() => work(deadlineAt));
  running.catch(() => {});
  try {
    const value = await Promise.race([running, timeout]);
    return value === expired ? { ok: false, error: new Error(`timed out after ${budgetMs} ms`) } : { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
    await closeAll(Math.min(GRACE_MS, Math.max(0, deadlineAt - Date.now())));
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
