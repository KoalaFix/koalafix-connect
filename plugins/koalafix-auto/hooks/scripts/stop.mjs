// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Claude Code Stop hook, run at the end of every turn. Three jobs:
// - The WIP backstop. When this session had a real prompt (the prompt hook left its state) but holds no live lease,
//   because the prompt hook could not start one or the lease ended, the hook starts it itself, named after the
//   project (label.mjs), never after a prompt. A plugin install (`--user`) gets one only when the prompt hook found its lease lands in the folder's space. If the server refuses,
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
// - Asks the server what needs the person (`open` for disputes and handoffs, the real tool with its real arguments) and
//   prints one line on stderr naming what this session has not named yet, so each item is told once a session and a
//   turn with nothing new prints nothing (KOA2-545). If the server cannot be reached it appends that call to the spool
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
import { needsYouLine } from "./format.mjs";
import { appendSpool } from "./spool.mjs";
import { backstopReason, leaseKey, leaseLive, readState, readTold, sessionIdOf, sessionKey, writeState, writeTold } from "./wip.mjs";
import { projectLabel } from "./label.mjs";
import { keepModel, keptModel, provenanceMeta, transcriptModel } from "./provenance.mjs";
import { attended, captureDue, captureEvery, captureReason, capturing, fetchSpaces, holdable, isSpacesPage, memberSlugs, pickSpace, projectSlugs } from "./capture.mjs";
import { pickFromTranscript, pickedSpace, rememberPick, transcriptSize } from "./spaces.mjs";
import { closeReplaced } from "./lease-close.mjs";

/**
 * `OpenArgs` (contract tools-io.ts): the caller's own items that need them (KOA2-545), the kinds the session brief
 * lists (mcp-server brief.ts): a dispute and a rule review wait for a person and no clock closes them, and a handoff the
 * clock returns to its sender unacked. The rest close harmlessly by the clock, or the agent closes them itself. A page
 * of 50, so an item that arrives mid-session is not hidden behind ten already named.
 */
const OPEN_ARGS = { for: "me", kind: ["dispute", "rule_review", "handoff"], limit: 50 };

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
const gemini = args.client === "gemini-cli";
let project = null;
let afterAgent = false;
const holds = [];
/** The session's key, for what the Stop line has named this session (null at Gemini CLI's SessionEnd). */
let toldKey = null;
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
  const sessionId = atSessionEnd ? null : sessionIdOf(input);
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
  // Started now so the read runs beside the tool calls; only on a turn due a capture (checked first: cheaper).
  const due = ended && captureDue(state, now, captureEvery(env)) && capturing(env, args.client, input);
  const spaces = due ? fetchSpaces(target, deadlineAt).catch(() => null) : null;
  const session = afterAgent ? null : connect(target, deadlineAt);
  // Claude Code's latest answer names the model now in use (a `/model` switch included): kept for the later hooks.
  const answered = key === null || session === null ? null : transcriptModel(input.transcript_path);
  if (answered !== null && answered !== keptModel(key, env)) {
    keepModel(key, answered, env);
  }
  // The repo and model this session reports with its calls (provenance.mjs, KOA2-149).
  const reported = session === null ? {} : provenanceMeta(found.root, input, key, env);
  // A plugin install restarts its lease only when the first prompt found it lands in this folder's space (KOA2-5).
  if (session !== null && state !== null && (found.user !== true || state.autoLease === true) && !leaseLive(state)) {
    // The lease past its end time was extended by every call since, so it is still open: closed first (KOA2-531).
    if (await closeReplaced(session, found.root, target.url, key, state, reported, deadlineAt - 1000, env)) {
      state = { ...state, lease: null, expiresAt: null };
      writeState(key, state, env);
    }
    const n = state.leases + 1;
    const what = projectLabel(found.root);
    const work = { action: "start", what, agent: { client: args.client }, idempotency_key: leaseKey(key, n) };
    try {
      const started = (await callTool(session, "work", work, { [IDEMPOTENCY_META]: work.idempotency_key, ...reported })).structured;
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
  toldKey = key;
  return session === null ? null : callTool(session, "open", OPEN_ARGS, reported);
});
let notice;
if (outcome.ok) {
  // null: a plugin hook standing down for the project's own install, whose Stop hook prints the line itself, or
  // Gemini CLI's AfterAgent, which leaves the line to SessionEnd.
  const told = toldKey === null ? null : readTold(toldKey, env);
  const said = outcome.value === null ? { line: "", named: [] } : needsYouLine(outcome.value, OPEN_ARGS.limit, told);
  notice = said.line === "" ? "" : `${said.line}\n`;
  if (toldKey !== null && told !== null && said.named.length > 0) {
    try {
      writeTold(toldKey, [...told, ...said.named], env);
    } catch {
      // an item named again next turn is better than a failed turn's end
    }
  }
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
