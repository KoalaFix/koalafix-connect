// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Claude Code Stop hook, run at the end of every turn. Three jobs:
// - The WIP backstop. When this session had a real prompt (the prompt hook left its state) but holds no live lease,
//   because the prompt hook could not start one or the lease ended, the hook starts it itself, named after the
//   project (label.mjs), never after a prompt. A plugin install (`--user`) never gets one. If the server refuses,
//   it holds the turn once with a reason the model acts on (`decision: "block"`), only in a session a person attends
//   (so never in Cursor or Gemini CLI), never while `stop_hook_active` is set and never twice a session. A server it
//   cannot reach adds nothing.
// - The decision capture (capture.mjs), for project and plugin installs alike: it counts the session's finished turns
//   after a real prompt and, on the first and then whenever CAPTURE_TURNS turns or CAPTURE_MINUTES minutes have passed
//   since the last capture, holds the turn with a reason that tells the model to save the team decisions not saved
//   yet with `remember`, in its own words, to the space capture.mjs picks. Never while the client is already
//   continuing for a stop hook, and never in a session no person attends (`claude -p`, the Agent SDK, `codex exec`;
//   any Cursor or Gemini CLI session, which give no sign), whose printed answer a held turn would replace. If the
//   person's spaces cannot be read it holds nothing and tries next turn. When it has to ask which space, it asks once
//   a session, and remembers the person's pick for the folder (spaces.mjs) from the session's transcript.
// - Asks the server what is open for the person (`open`, the real tool with its real arguments) and prints one line
//   on stderr. If the server cannot be reached it appends that call to the spool
//   (<KALIBRATE_HOME or ~/.kalibrate>/spool/<date>.jsonl, tagged with this project), and the next session-start hook
//   in the project replays what is worth replaying.
// Budget 2.5 s (the configured timeout is 5 s); KALIBRATE_HOOK_BUDGET_MS overrides it. Gemini CLI runs this script at
// SessionEnd (a 1.2 s budget, the `open` line, never a hold) and at AfterAgent, its end of a turn, where it only
// captures: no backstop and no `open`.
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
import { attended, captureDue, captureEvery, captureReason, capturing, fetchSpaces, holdable, isSpacesPage, memberSlugs, pickSpace, projectSlugs } from "./capture.mjs";
import { pickFromTranscript, pickedSpace, rememberPick, transcriptSize } from "./spaces.mjs";

/** `OpenArgs` (contract tools-io.ts): the caller's own items, one page of ten. */
const OPEN_ARGS = { for: "me", limit: 10 };

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
const gemini = args.client === "gemini-cli";
let project = null;
let afterAgent = false;
const holds = [];
const outcome = await runWithBudget(budgetFrom(env, gemini ? BUDGETS.stopAtSessionEnd : BUDGETS.stop), async (deadlineAt) => {
  const input = await readHookInput(process.stdin, 200);
  if (args.error !== null) {
    throw new Error(args.error);
  }
  afterAgent = gemini && input.hook_event_name === "AfterAgent";
  const atSessionEnd = gemini && !afterAgent;
  // The config comes from the folder Claude Code was started in (or `--project`), never from `input.cwd`: the
  // session may have moved into a subfolder that holds a `.kalibrate/` of its own.
  const located = locateHook(args, env, input);
  if (located === null) {
    return null;
  }
  const { found, target } = located;
  project = found.root;
  const sessionId = atSessionEnd || target.kind !== "http" ? null : sessionIdOf(input);
  const key = sessionId === null ? null : sessionKey(found.root, sessionId);
  let state = key === null ? null : readState(key, env);
  const now = Date.now();
  // A finished turn counts toward the next capture; the client continuing for a stop hook is still the same turn.
  const ended = state !== null && holdable(input);
  if (ended) {
    state = { ...state, turns: state.turns + 1 };
    writeState(key, state, env);
  }
  // After the capture asked which space, the person's pick is the space of the model's next remember call.
  let picked = state === null ? null : pickedSpace(found.root, env);
  if (ended && picked === null && state.asked !== null) {
    picked = pickFromTranscript(input.transcript_path, state.asked, state.askedFrom);
    if (picked !== null) {
      try {
        rememberPick(found.root, picked, env);
      } catch {
        // a pick that cannot be written is learnt again from the transcript next turn
      }
    }
  }
  // Started now so the read runs beside the handshake; only on a turn due a capture (checked first: cheaper).
  const due = ended && captureDue(state, now, captureEvery(env)) && capturing(env, args.client, input);
  const spaces = due ? fetchSpaces(target, deadlineAt).catch(() => null) : null;
  const session = afterAgent ? null : await connect(target, deadlineAt);
  if (session !== null && found.user !== true && state !== null && !leaseLive(state)) {
    const n = state.leases + 1;
    const what = projectLabel(found.root);
    const work = { action: "start", what, agent: { client: args.client }, idempotency_key: leaseKey(key, n) };
    try {
      const started = (await callTool(session, "work", work, { [IDEMPOTENCY_META]: work.idempotency_key })).structured;
      state = { ...state, lease: started?.lease ?? null, expiresAt: started?.expires_at ?? null, leases: n };
      writeState(key, state, env);
    } catch (error) {
      if (!(error instanceof ToolError)) {
        throw error;
      }
      // Never in a session no person attends: the held turn's line would replace the answer a script reads.
      if (!state.nudged && input.stop_hook_active !== true && attended(env, args.client, input)) {
        holds.push(backstopReason(messageOf(error), what));
        state = { ...state, nudged: true };
        writeState(key, state, env);
      }
    }
  }
  // An answer that is not a SpacesPage counts as a failed read: no hold, and the next turn tries again.
  const page = spaces === null ? null : await spaces;
  if (isSpacesPage(page)) {
    const choice = pickSpace(memberSlugs(page), projectSlugs(found.root), picked);
    const ask = choice !== null && "ask" in choice;
    // Asked once a session: a later window that would ask again holds nothing.
    if (choice !== null && !(ask && state.asked !== null)) {
      holds.push(captureReason(choice, args.client));
    }
    // The pick is looked for only in what the transcript gains after the ask.
    const asking = ask && state.asked === null;
    const askedFrom = asking ? transcriptSize(input.transcript_path) : state.askedFrom;
    state = { ...state, covered: state.turns, capturedAt: now, asked: asking ? choice.ask : state.asked, askedFrom };
    writeState(key, state, env);
  }
  return session === null ? null : callTool(session, "open", OPEN_ARGS);
});
let notice;
if (outcome.ok) {
  // null: a plugin hook standing down for the project's own install, whose Stop hook prints the line itself, or
  // Gemini CLI's AfterAgent, which leaves the line to SessionEnd.
  notice = outcome.value === null ? "" : `${summarizeOpen(outcome.value, OPEN_ARGS.limit)}\n`;
} else {
  notice = `koalafix: stop hook skipped: ${messageOf(outcome.error)}\n`;
  if (project !== null && !afterAgent && !(outcome.error instanceof ToolError)) {
    try {
      appendSpool({ source: "stop", project, tool: "open", arguments: OPEN_ARGS, reason: messageOf(outcome.error) }, env);
    } catch {
      // a spool that cannot be written is not worth failing a turn's end for
    }
  }
}
// Printed even when `open` failed afterwards: the hold's flag is already written, so it would never come again.
const hold = holds.length > 0 ? holds.join("\n\n") : null;
finish({ stdout: stopBlockOutput(args.client, hold) ?? quietOutput(args.client), stderr: notice });
