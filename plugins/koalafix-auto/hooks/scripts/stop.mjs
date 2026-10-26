// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Claude Code Stop hook, run at the end of every turn. Two jobs:
// - The WIP backstop. When this session had a real prompt (the prompt hook left its state) but holds no live lease,
//   because the prompt hook could not start one or the lease ended, the hook starts it itself, named after the
//   project (label.mjs), never after a prompt. A plugin install (`--user`) never gets one. If the server refuses,
//   it holds the turn once with a reason the model acts on (Claude Code and Codex `decision: "block"`, Cursor
//   `followup_message`), never while `stop_hook_active` is set and never twice a session. A server it cannot reach
//   adds nothing.
// - Asks the server what is open for the person (`open`, the real tool with its real arguments) and prints one line
//   on stderr. If the server cannot be reached it appends that call to the spool
//   (<KALIBRATE_HOME or ~/.kalibrate>/spool/<date>.jsonl, tagged with this project), and the next session-start hook
//   in the project replays what is worth replaying.
// Budget 2.5 s (the configured timeout is 5 s); KALIBRATE_HOOK_BUDGET_MS overrides it. Gemini CLI runs this script at
// SessionEnd, so there it keeps a 1.2 s budget and never holds anything.
//
// Other clients run the same script with `--client <id>` and `--project <absolute dir>` (client.mjs). Cursor, Codex
// and Gemini CLI get `{}` on stdout when there is nothing to hold, since they read it as JSON.

import { BUDGETS, IDEMPOTENCY_META, ToolError, budgetFrom, callTool, connect, finish, messageOf, runWithBudget } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs, quietOutput, stopBlockOutput } from "./client.mjs";
import { summarizeOpen } from "./format.mjs";
import { appendSpool } from "./spool.mjs";
import { backstopReason, leaseKey, leaseLive, readState, sessionIdOf, sessionKey, writeState } from "./wip.mjs";
import { projectLabel } from "./label.mjs";

/** `OpenArgs` (contract tools-io.ts): the caller's own items, one page of ten. */
const OPEN_ARGS = { for: "me", limit: 10 };

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
const atSessionEnd = args.client === "gemini-cli";
let project = null;
let hold = null;
const outcome = await runWithBudget(budgetFrom(env, atSessionEnd ? BUDGETS.stopAtSessionEnd : BUDGETS.stop), async (deadlineAt) => {
  const input = await readHookInput(process.stdin, 200);
  if (args.error !== null) {
    throw new Error(args.error);
  }
  // The config comes from the folder Claude Code was started in (or `--project`), never from `input.cwd`: the
  // session may have moved into a subfolder that holds a `.kalibrate/` of its own.
  const located = locateHook(args, env, input);
  if (located === null) {
    return null;
  }
  const { found, target } = located;
  project = found.root;
  const session = await connect(target, deadlineAt);
  const sessionId = atSessionEnd || target.kind !== "http" || found.user === true ? null : sessionIdOf(input);
  const key = sessionId === null ? null : sessionKey(found.root, sessionId);
  const state = key === null ? null : readState(key, env);
  if (key !== null && state !== null && !leaseLive(state)) {
    const n = state.leases + 1;
    const what = projectLabel(found.root);
    const work = { action: "start", what, agent: { client: args.client }, idempotency_key: leaseKey(key, n) };
    try {
      const started = (await callTool(session, "work", work, { [IDEMPOTENCY_META]: work.idempotency_key })).structured;
      writeState(key, { ...state, lease: started?.lease ?? null, expiresAt: started?.expires_at ?? null, leases: n }, env);
    } catch (error) {
      if (!(error instanceof ToolError)) {
        throw error;
      }
      if (!state.nudged && input.stop_hook_active !== true) {
        hold = backstopReason(messageOf(error), what);
        writeState(key, { ...state, nudged: true }, env);
      }
    }
  }
  return callTool(session, "open", OPEN_ARGS);
});
let notice;
if (outcome.ok) {
  // null: a plugin hook standing down for the project's own install, whose Stop hook prints the line itself.
  notice = outcome.value === null ? "" : `${summarizeOpen(outcome.value, OPEN_ARGS.limit)}\n`;
} else {
  notice = `koalafix: stop hook skipped: ${messageOf(outcome.error)}\n`;
  if (project !== null && !(outcome.error instanceof ToolError)) {
    try {
      appendSpool({ source: "stop", project, tool: "open", arguments: OPEN_ARGS, reason: messageOf(outcome.error) }, env);
    } catch {
      // a spool that cannot be written is not worth failing a turn's end for
    }
  }
}
finish({ stdout: stopBlockOutput(args.client, hold) ?? quietOutput(args.client), stderr: notice });
