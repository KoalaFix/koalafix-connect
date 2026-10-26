// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The prompt hook: Claude Code and Codex `UserPromptSubmit`, Gemini CLI `BeforeAgent`, Cursor `beforeSubmitPrompt`.
// The hook does the team-memory work itself, so it never depends on the model choosing to:
// - On the session's first real prompt it calls `recall(about: prompt)` and `work(start)` together, and puts one
//   block in front of the prompt: the verdict, the lease it started, overlapping work, facts, notes and teammates.
// - On later prompts it calls `recall` again and adds only what this session has not been shown (wip.mjs). Most
//   prompts add nothing, so the model does not learn to skip the block.
// - An acknowledgement ("ok", "continue") asks the server nothing. A lease that has ended is started again.
// - The recall carries the person's prompt, so it is marked unlogged: the server keeps no query-log row and opens no
//   gap item for it, as for the session brief (Part A 4.6, KOA2-42).
// Hosted mode only: local mode starts a server process per call, which a per-prompt budget cannot afford; there the
// session-start brief stands alone. It fails open: on any problem it adds nothing, prints one line on stderr and
// exits 0. Budget 1.5 s (KALIBRATE_HOOK_BUDGET_MS overrides). Other clients pass `--client` and `--project`.
// No MCP handshake (KOA2-64): each call is one `tools/call` request, sent alone with the `MCP-Protocol-Version`
// header, so a later prompt is one HTTP request and the first is two in parallel. A server that wants the handshake
// gets it once, and the hook says so on stderr.

import { BUDGETS, IDEMPOTENCY_META, UNLOGGED_META, budgetFrom, callTool, connectStateless, finish, messageOf, runWithBudget } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs, promptOutput } from "./client.mjs";
import { NoCredentialError, signInStep } from "./device.mjs";
import { firstBlock, isTrivial, recallQuery, leaseKey, leaseLive, newsBlock, promptOf, readState, restartedLine, sessionIdOf, sessionKey, whatOf, writeState } from "./wip.mjs";

/** How many results one recall asks for: enough for a first block, few enough to stay inside the budget. */
const RECALL_LIMIT = 5;

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
let context = null;
let notice = "";
let session = null;

/** Starts lease number `n` for this session, returning the `WorkResult` or null when the server refused it. */
async function startLease(session, key, n, what, client) {
  const work = { action: "start", what, agent: { client }, idempotency_key: leaseKey(key, n) };
  try {
    return (await callTool(session, "work", work, { [IDEMPOTENCY_META]: leaseKey(key, n) })).structured ?? null;
  } catch (error) {
    notice += `koalafix: prompt hook could not start the WIP lease: ${messageOf(error)}\n`;
    return null;
  }
}

const outcome = await runWithBudget(budgetFrom(env, BUDGETS.prompt), async (deadlineAt) => {
  const input = await readHookInput(process.stdin, 200);
  if (args.error !== null) {
    throw new Error(args.error);
  }
  const prompt = promptOf(input);
  if (isTrivial(prompt)) {
    return;
  }
  const sessionId = sessionIdOf(input);
  if (sessionId === null) {
    throw new Error("the client sent no session id, so the hook cannot tell a first prompt from a later one");
  }
  let located;
  try {
    located = locateHook(args, env, input);
  } catch (error) {
    if (!(error instanceof NoCredentialError)) {
      throw error;
    }
    // Waiting on a browser sign-in that session start began: check it once, quietly, and go on when approved.
    if (!(await signInStep({ env, client: args.client, deadlineAt, start: false })).signedIn) {
      return;
    }
    located = locateHook(args, env, input);
  }
  if (located === null) {
    return;
  }
  const { found, target } = located;
  if (target.kind !== "http") {
    return;
  }
  const key = sessionKey(found.root, sessionId);
  const state = readState(key, env);
  session = connectStateless(target, deadlineAt);
  const about = recallQuery(prompt);
  const recall = callTool(session, "recall", { about, limit: RECALL_LIMIT }, { [UNLOGGED_META]: true }).then((result) => result.structured ?? null);
  if (state === null) {
    const what = whatOf(prompt);
    const [memory, work] = await Promise.all([recall, startLease(session, key, 1, what, args.client)]);
    const block = firstBlock(memory, work);
    context = block.text;
    writeState(key, { lease: work?.lease ?? null, expiresAt: work?.expires_at ?? null, leases: 1, shown: block.shown, what, nudged: false }, env);
    return;
  }
  const restart = leaseLive(state) ? null : startLease(session, key, state.leases + 1, whatOf(prompt), args.client);
  const [memory, work] = await Promise.all([recall, restart]);
  const next = work === null ? state : { ...state, lease: work.lease ?? null, expiresAt: work.expires_at ?? null, leases: state.leases + 1 };
  const news = newsBlock(memory, next);
  const restarted = work === null ? null : restartedLine(work);
  const parts = [restarted, news?.text ?? null].filter((part) => part !== null);
  context = parts.length === 0 ? null : parts.join("\n");
  writeState(key, { ...next, shown: [...next.shown, ...(news?.shown ?? [])] }, env);
});
if (session?.fallback != null) {
  notice += `koalafix: prompt hook fell back to the MCP handshake: ${session.fallback}\n`;
}
if (!outcome.ok) {
  context = null;
  notice += `koalafix: prompt hook skipped: ${messageOf(outcome.error)}\n`;
}
finish({ stdout: promptOutput(args.client, context), stderr: notice });
