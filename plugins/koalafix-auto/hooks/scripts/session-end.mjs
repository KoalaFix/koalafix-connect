// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The session-end hook: Claude Code, Codex and Gemini CLI `SessionEnd`, Cursor `sessionEnd`. It closes the WIP lease
// the prompt hook started for this session with `work(done)`, so a finished session stops showing as work in
// progress without the model having to remember. A session the prompt hook never started has nothing to close.
// A client may kill a session-end hook early (Claude Code allows about 1.5 s), so the close is made durable before
// the network: the state file is removed and the call is written to the spool first, then sent. The next session
// start in the project replays the spooled call under the same idempotency key, a no-op when this one landed. A
// client with no session-end event lets the lease expire by itself. For Claude Code it also starts the decision
// capture's last pass when the session ends with turns no capture covered (capture-end.mjs). It prints nothing on
// stdout (`{}` for the clients that need JSON) and exits 0.

import { BUDGETS, IDEMPOTENCY_META, budgetFrom, callTool, connect, finish, messageOf, runWithBudget } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs, quietOutput } from "./client.mjs";
import { appendSpool } from "./spool.mjs";
import { ENDED_OUTCOME, readState, removeState, sessionIdOf, sessionKey } from "./wip.mjs";
import { endPassDue, startEndPass } from "./capture-end.mjs";

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
const outcome = await runWithBudget(budgetFrom(env, BUDGETS.sessionEnd), async (deadlineAt) => {
  const input = await readHookInput(process.stdin, 100);
  if (args.error !== null) {
    throw new Error(args.error);
  }
  const sessionId = sessionIdOf(input);
  if (sessionId === null) {
    return "no session";
  }
  const located = locateHook(args, env, input);
  if (located === null) {
    return "project install";
  }
  const { found, target } = located;
  const project = found.root;
  const key = sessionKey(project, sessionId);
  const state = readState(key, env);
  // Claude Code only: the decision capture's last pass over turns no capture covered (capture-end.mjs).
  const cwd = env.CLAUDE_PROJECT_DIR ?? (typeof input.cwd === "string" ? input.cwd : project);
  const pass = args.client === "claude-code" && target.kind === "http" && endPassDue(state, env, input) ? startEndPass({ target, root: project, cwd, sessionId, env, deadlineAt }) : null;
  if (state === null || state.lease === null) {
    if (state !== null) {
      removeState(key, env);
    }
    await pass;
    return "no lease";
  }
  const pending = { action: "done", lease: state.lease, outcome: ENDED_OUTCOME, idempotency_key: `hook-wip-done:${key}:${state.leases}` };
  removeState(key, env);
  appendSpool({ source: "session-end", project, tool: "work", arguments: pending, reason: "queued before the close, in case the session exits first" }, env);
  try {
    const session = await connect(target, deadlineAt);
    await callTool(session, "work", pending, { [IDEMPOTENCY_META]: pending.idempotency_key });
  } finally {
    await pass;
  }
  return "closed";
});
// The close is already in the spool, so a failure here only says why it did not land now.
const notice = outcome.ok ? "" : `koalafix: session-end hook could not close the lease now (the next session start retries it): ${messageOf(outcome.error)}\n`;
finish({ stdout: quietOutput(args.client), stderr: notice });
