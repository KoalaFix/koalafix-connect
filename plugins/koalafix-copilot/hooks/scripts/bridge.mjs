// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// `node bridge.mjs --client <id> --project <absolute dir>`: the local command hosted `koalafix init` gives Codex, Gemini
// CLI, Cursor and OpenCode in place of a URL with an environment-variable token (see bridge-core.mjs). It reads MCP
// messages from stdin, one per line, sends each to the project's hosted server with the credential it finds when it
// starts, and writes every reply to stdout, one per line. When it cannot start (no hosted config, no credential), it
// still answers: every request gets a JSON-RPC error that names the fix, so the client shows it instead of a bare
// "failed to connect". It never prints the token.

import { createBridge, resolveBridgeTarget, resolveUserBridgeTarget, UNAUTHORIZED_CODE } from "./bridge-core.mjs";
import { parseHookArgs } from "./client.mjs";
import { isRecord, messageOf } from "./connect.mjs";

const MAX_LINE_CHARS = 4 * 1024 * 1024;
const args = parseHookArgs(process.argv.slice(2));
const write = (message) => process.stdout.write(`${message}\n`);
const log = (line) => process.stderr.write(`${line}\n`);

let problem = args.error ?? (!args.user && args.project === null ? "the bridge needs --project <the absolute project folder>, or --user; run koalafix init again" : null);
let bridge = null;
if (problem === null) {
  try {
    // --user (koalafix connect, ADR-0054): the person's own default server and token, no project file.
    const target = args.user ? resolveUserBridgeTarget() : resolveBridgeTarget(args.project);
    bridge = createBridge({ ...target, write, log, userAgent: `koalafix-bridge (${args.client ?? "unknown"})` });
  } catch (error) {
    problem = messageOf(error);
  }
}
if (problem !== null) {
  log(`koalafix bridge: ${problem}`);
}

/** Without a server to reach, every request hears why, as an error the client shows. */
function refuse(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (isRecord(message) && typeof message.method === "string" && "id" in message) {
    write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: UNAUTHORIZED_CODE, message: `KoalaFix is not set up here: ${problem}` } }));
  }
}

let buffer = "";
/** True while dropping the rest of an oversized line, up to its newline, so the next line is read whole. */
let skipping = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (skipping) {
      skipping = false;
      continue;
    }
    if (line !== "") {
      if (bridge === null) {
        refuse(line);
      } else {
        void bridge.send(line);
      }
    }
  }
  if (buffer.length > MAX_LINE_CHARS) {
    log("koalafix bridge: a message from the client was too large; dropped");
    buffer = "";
    skipping = true;
  }
});
// The client closed stdin: answer what is in flight, then let the process end by itself. process.exit() here trips a
// libuv assertion on Windows while fetch's socket is still closing.
process.stdin.on("end", () => {
  void (bridge === null ? Promise.resolve() : bridge.drain()).then(() => {
    process.exitCode = 0;
  });
});
