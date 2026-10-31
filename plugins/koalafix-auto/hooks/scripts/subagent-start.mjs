// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Claude Code SubagentStart hook: tells a subagent that can call recall that team memory is there, that it recalls
// with its own task before acting, and that it leaves every write to the session that started it (subagent.mjs).
// SubagentStart can only add context, never block, and its input carries no prompt, so the lines are the same for
// every subagent. No network: whether the person is signed in is read from the local credential, so a subagent is
// never told to call tools that cannot answer.
// The same guards as the other hooks: a plugin install (`--user`) stands down in a project with its own
// `koalafix init` install; no credential means no lines (a subagent never starts the browser sign-in); Node older
// than 22 means no lines. It runs in `claude -p` and SDK sessions too, as the brief and per-prompt recall do: only a
// held turn is kept out of an unattended run, and this holds nothing.
// It fails open: on any problem it prints nothing on stdout, one line on stderr, and exits 0.

import { finish, messageOf } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs, reportedFolder } from "./client.mjs";
import { NoCredentialError } from "./device.mjs";
import { SUBAGENT_CONTEXT, agentGetsRecall, subagentOutput } from "./subagent.mjs";

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
let context = null;
let notice = "";
try {
  const input = await readHookInput(process.stdin, 200);
  if (args.error !== null) {
    throw new Error(args.error);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (args.client === "claude-code" && major >= 22) {
    let located = null;
    try {
      located = locateHook(args, env, input);
    } catch (error) {
      if (!(error instanceof NoCredentialError)) {
        throw error;
      }
    }
    if (located !== null) {
      const dir = env.CLAUDE_PROJECT_DIR;
      const projectDir = typeof dir === "string" && dir !== "" ? dir : reportedFolder(input);
      if (agentGetsRecall(input.agent_type, projectDir, env)) {
        context = SUBAGENT_CONTEXT;
      }
    }
  }
} catch (error) {
  context = null;
  notice = `koalafix: subagent-start skipped: ${messageOf(error)}\n`;
}
finish({ stdout: subagentOutput(context), stderr: notice });
