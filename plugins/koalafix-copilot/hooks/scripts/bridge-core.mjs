// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The stdio bridge to a hosted KoalaFix server (bridge.mjs is its entry). Codex, Gemini CLI, Cursor and OpenCode read a
// remote server's bearer token only from an environment variable, which nobody sets after `koalafix init` (launch
// audit: Codex answered "NONE"). So hosted init gives them this local command instead: it speaks MCP over stdio to the
// client and Streamable HTTP to the server, and reads the credential when it starts, the way Claude Code's headers
// helper does: the project's own `.kalibrate/token`, else the person's `koalafix login` credential issued for exactly
// that server. No token is written into any client's config.
//
// Every message the client sends goes to the server as one POST, in order of arrival; every reply the server sends
// (JSON or an event stream) goes back as one line. The protocol version the server answers `initialize` with, and a
// session id if it issues one, go on every later request. The token is only ever sent to the configured server, never
// follows a redirect and never appears in a message: a refused credential comes back as a JSON-RPC error naming the
// fix. stdout carries protocol only; problems go to stderr.

import { userServer } from "./credentials.mjs";
import { isRecord, messageOf, redact } from "./connect.mjs";
import { findConfig, mcpEndpoint, readToken, serverUrlOf } from "./project.mjs";

/** A reply larger than this is refused rather than buffered (the same cap the hooks put on a stdio line). */
export const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
/** How long one request may take, a long tool call included. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** JSON-RPC code for a refused credential, in the server-error range so clients show the message. */
export const UNAUTHORIZED_CODE = -32001;

/**
 * The server and credential for a project folder: its `.kalibrate/config.json` must name the server, and a token must
 * exist for exactly that server. Throws with the fix in words otherwise.
 * @param {string} root the absolute project folder
 */
export function resolveBridgeTarget(root, env = process.env) {
  const found = findConfig(root);
  const url = mcpEndpoint(serverUrlOf(found.config));
  const token = readToken(found, env);
  if (token === "") {
    const origin = new URL(url).origin;
    throw new Error(`no credential for ${origin}: run koalafix login --url ${origin}, or koalafix init again in this folder`);
  }
  return { url, token };
}

/**
 * The person's own server and token (`koalafix connect` at user scope, ADR-0054): the default server in
 * credentials.json and the token saved for exactly that origin. No project file is read.
 */
export function resolveUserBridgeTarget(env = process.env) {
  const server = userServer(env);
  if (server === null) {
    throw new Error("no KoalaFix credential on this machine: run the connect line from the dashboard again, or koalafix login");
  }
  return { url: mcpEndpoint(server.serverUrl), token: server.token };
}

/** Every JSON-RPC message in a Streamable HTTP response body: one JSON document (or a batch), or an event stream. */
export function messagesOf(text, contentType) {
  if (/text\/event-stream/i.test(contentType)) {
    const found = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") {
        continue;
      }
      try {
        found.push(JSON.parse(data));
      } catch {
        // a partial event or a comment
      }
    }
    return found;
  }
  if (text.trim() === "") {
    return [];
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function errorReply(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * A bridge over `fetch`: `send(line)` forwards one line from the client and resolves once every reply to it has been
 * written with `write`. Lines go one at a time, in order, until `initialize` is answered; after that each goes at once.
 * @param {{ url: string, token: string, fetch?: typeof fetch, write: (line: string) => void, log?: (line: string) => void, userAgent?: string }} options
 */
export function createBridge(options) {
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const origin = new URL(options.url).origin;
  let sessionId = null;
  let version = null;
  let queue = Promise.resolve();
  let opened = false;
  const inFlight = new Set();

  async function forward(line) {
    try {
      await relay(line);
    } finally {
      if (!opened && line.includes('"initialize"')) {
        try {
          opened = JSON.parse(line)?.method === "initialize";
        } catch {
          // not JSON: relay() already answered it
        }
      }
    }
  }

  /** One line to the server and its replies back. */
  async function relay(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      options.write(JSON.stringify(errorReply(null, -32700, "parse error: the line is not JSON")));
      return;
    }
    const id = isRecord(message) && "id" in message && typeof message.method === "string" ? message.id : null;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${options.token}`,
      ...(options.userAgent === undefined ? {} : { "user-agent": options.userAgent }),
      ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      ...(version === null ? {} : { "mcp-protocol-version": version }),
    };
    let response;
    try {
      response = await doFetch(options.url, { method: "POST", headers, body: line, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      log(`koalafix bridge: ${origin} could not be reached: ${redact(messageOf(error))}`);
      if (id !== null) {
        options.write(JSON.stringify(errorReply(id, -32603, `KoalaFix at ${origin} could not be reached; check the connection, then restart this client`)));
      }
      return;
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      log(`koalafix bridge: ${origin} refused the credential (HTTP ${response.status})`);
      if (id !== null) {
        options.write(JSON.stringify(errorReply(id, UNAUTHORIZED_CODE, `KoalaFix at ${origin} did not accept your credential. Run koalafix login --url ${origin}, or ask your team's admin for an invite.`)));
      }
      return;
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      // The connection broke, or the time ran out, while the reply was still arriving: the request still gets an answer.
      log(`koalafix bridge: ${origin} broke off its reply: ${redact(messageOf(error))}`);
      if (id !== null) {
        options.write(JSON.stringify(errorReply(id, -32603, `KoalaFix at ${origin} broke off its reply; try again`)));
      }
      return;
    }
    if (!response.ok) {
      log(`koalafix bridge: ${origin} answered HTTP ${response.status}`);
      if (id !== null) {
        // The server's own JSON-RPC error for this request says more than the status; pass it on when there is one.
        let own;
        try {
          own = messagesOf(text, response.headers.get("content-type") ?? "").find((reply) => isRecord(reply) && reply.id === id && isRecord(reply.error));
        } catch {
          own = undefined;
        }
        options.write(JSON.stringify(own ?? errorReply(id, -32603, `KoalaFix at ${origin} answered HTTP ${response.status}`)));
      }
      return;
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      if (id !== null) {
        options.write(JSON.stringify(errorReply(id, -32603, "KoalaFix sent a reply too large to pass on")));
      }
      return;
    }
    let replies;
    try {
      replies = messagesOf(text, response.headers.get("content-type") ?? "");
    } catch {
      if (id !== null) {
        options.write(JSON.stringify(errorReply(id, -32603, "KoalaFix sent a reply that is not JSON")));
      }
      return;
    }
    for (const reply of replies) {
      if (isRecord(message) && message.method === "initialize" && isRecord(reply) && reply.id === id && isRecord(reply.result) && typeof reply.result.protocolVersion === "string") {
        version = reply.result.protocolVersion;
      }
      options.write(JSON.stringify(reply));
    }
  }

  return {
    send(line) {
      // In order until `initialize` is answered; after that each request goes at once, so a client's parallel tool
      // calls are not queued behind one another.
      const next = opened ? forward(line) : queue.then(() => forward(line));
      if (!opened) {
        queue = next.catch(() => {});
      }
      const tracked = next.catch(() => {});
      inFlight.add(tracked);
      void tracked.finally(() => inFlight.delete(tracked));
      return next;
    },
    /** Resolves once every line sent so far has been answered. */
    async drain() {
      await Promise.all([queue, ...inFlight]);
    },
  };
}
