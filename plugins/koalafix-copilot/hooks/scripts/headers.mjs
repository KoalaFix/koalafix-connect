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
// With no such token, or on any problem, it prints `{}` and exits 0: Claude Code then connects without a credential
// and asks for its own OAuth sign-in, as it would with no helper. A token only goes over https, or over http to the
// local machine.

import { parseHookArgs } from "./client.mjs";
import { messageOf } from "./connect.mjs";
import { userToken } from "./credentials.mjs";
import { findConfig, mcpEndpoint, readToken, serverUrlOf, trustedRoot } from "./project.mjs";

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

/** The plugin install's header: the person's own token for the server Claude Code names, or none. */
function userHeaders() {
  const asked = env.CLAUDE_CODE_MCP_SERVER_URL;
  if (asked === undefined || asked === "") {
    throw new Error("Claude Code named no server (CLAUDE_CODE_MCP_SERVER_URL), so no credential is sent");
  }
  mcpEndpoint(asked);
  const token = userToken(asked, env);
  return token === "" ? {} : { Authorization: `Bearer ${token}` };
}

try {
  if (args.error !== null) {
    throw new Error(args.error);
  }
  process.stdout.write(`${JSON.stringify(args.user ? userHeaders() : projectHeaders())}\n`);
} catch (error) {
  process.stderr.write(`koalafix: headers helper: ${messageOf(error)}\n`);
  if (args.user) {
    process.stdout.write("{}\n");
  } else {
    process.exitCode = 1;
  }
}
