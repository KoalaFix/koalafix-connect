// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Claude Code `headersHelper` for a hosted Kalibrate server, named in the project's `.mcp.json`. Claude Code runs it
// in the project folder each time it connects and sends the JSON object it prints as request headers, so the bearer
// token goes from `.kalibrate/token` into the Authorization header and is never written into `.mcp.json` (Part B 3.6).
//
// It prints the header only when the URL Claude Code is connecting to (CLAUDE_CODE_MCP_SERVER_URL) is the server
// in `.kalibrate/config.json`: a pulled commit that repoints `.mcp.json` does not get the token. On any problem it
// prints nothing on stdout, one line on stderr, and exits 1, so the connection fails visibly instead of going out
// without a credential. It never prints the token anywhere but stdout, which Claude Code reads as the header. A
// `.kalibrate/config.json` or `.kalibrate/token` that is a symbolic link is refused, so a committed link cannot hand
// it another credential on this machine.
//
// With `--user` it serves a plugin's copy of the server instead (the koalafix-auto plugin), and reads no project
// file: the token is the person's own (`koalafix login`, or the hooks' browser sign-in), and only the one saved for
// exactly the origin Claude Code is connecting to, so the one browser sign-in serves the hooks and the tools alike.
// With no such token it sends the hooks' pending device sign-in code instead (userHeaders), so the one browser sign-in
// covers the tools in this very session. On any problem it prints `{}` and exits 0: Claude Code then connects without
// a credential and asks for its own OAuth sign-in, as it would with no helper. A token only goes over https, or over
// http to the local machine.
//
// The project token is pinned to the server it was issued for (token-pin.mjs). When `.kalibrate/config.json` names
// another origin, it prints nothing on stdout, one plain line on stderr, and exits 1, as for any other project
// refusal: Claude Code does not connect to a server a commit chose.

import { parseHookArgs } from "./client.mjs";
import { messageOf } from "./connect.mjs";
import { userToken } from "./credentials.mjs";
import { headersDeviceCode } from "./device.mjs";
import { findConfig, mcpEndpoint, readToken, serverUrlOf, trustedRoot } from "./project.mjs";
import { TokenPinError } from "./token-pin.mjs";

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));

/** The project install's header: `.kalibrate/token`, for the server in `.kalibrate/config.json` only. */
function projectHeaders() {
  // CLAUDE_PROJECT_DIR when Claude Code passes it, else the folder Claude Code runs the helper in (the project
  // folder). Only that folder's own `.kalibrate/` counts; nothing above or below it is read.
  const found = findConfig(trustedRoot(env, process.cwd()));
  const expected = mcpEndpoint(serverUrlOf(found.config));
  const asked = env.CLAUDE_CODE_MCP_SERVER_URL;
  if (asked !== undefined && asked !== "" && mcpEndpoint(asked) !== expected) {
    throw new Error(".mcp.json points at a different server than .kalibrate/config.json; run koalafix init again");
  }
  const token = readToken(found);
  if (token === "") {
    throw new Error(".kalibrate/token is missing or empty");
  }
  return { Authorization: `Bearer ${token}` };
}

/** How long the helper may take to start a sign-in for a person with no token (Claude Code waits on it to connect). */
const DEVICE_START_MS = 4000;

/**
 * The plugin install's header: the person's own token for the server Claude Code names. With none yet, the hooks'
 * pending device sign-in code (started here when session start has not yet), which that server takes as the approval's
 * token once the person approves and never answers with a 401 before (mcp-server device-connection.ts): Claude Code
 * then never starts a second sign-in of its own, and its tools work in the same session straight after the one
 * approval. None when there is no code to send.
 */
async function userHeaders() {
  const asked = env.CLAUDE_CODE_MCP_SERVER_URL;
  if (asked === undefined || asked === "") {
    throw new Error("Claude Code named no server (CLAUDE_CODE_MCP_SERVER_URL), so no credential is sent");
  }
  mcpEndpoint(asked);
  const token = userToken(asked, env);
  if (token !== "") {
    return { Authorization: `Bearer ${token}` };
  }
  const code = await headersDeviceCode(asked, { env, client: "claude-code", deadlineAt: Date.now() + DEVICE_START_MS }).catch(() => null);
  return code === null ? {} : { "X-KoalaFix-Device": code };
}

try {
  if (args.error !== null) {
    throw new Error(args.error);
  }
  process.stdout.write(`${JSON.stringify(args.user ? await userHeaders() : projectHeaders())}\n`);
} catch (error) {
  // A `serverUrl` that is not the server the project's token was issued for (token-pin.mjs) is refused like any other
  // project problem, with its own plain line: nothing on stdout and exit 1, so Claude Code does not connect at all.
  process.stderr.write(error instanceof TokenPinError ? `${error.message}\n` : `koalafix: headers helper: ${messageOf(error)}\n`);
  if (args.user) {
    process.stdout.write("{}\n");
  } else {
    process.exitCode = 1;
  }
}
