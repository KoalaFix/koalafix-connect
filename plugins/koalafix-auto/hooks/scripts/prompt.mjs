// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The prompt hook: Claude Code and Codex `UserPromptSubmit`, Gemini CLI `BeforeAgent`, Cursor `beforeSubmitPrompt`.
// The hook does the team-memory work itself, so it never depends on the model choosing to:
// - On the session's first real prompt it calls `recall(about: prompt)` and `work(start)` together, and puts one
//   block in front of the prompt: the verdict, the lease it started, overlapping work, facts, notes and teammates.
// - The lease is named after the project (label.mjs: repository and branch, or the folder), never after the prompt:
//   teammates see the lease, and a prompt can be private. A plugin install (`--user`) runs in any folder, so on the
//   first prompt it reads the person's spaces alongside the recall and starts the lease only when the space the
//   server would file it in is this folder's space (lease-space.mjs, KOA2-5); the answer holds for the session.
// - On later prompts it calls `recall` again and adds only what this session has not been shown (wip.mjs). Most
//   prompts add nothing, so the model does not learn to skip the block.
// - An acknowledgement ("ok", "continue") asks the server nothing. A lease that has ended is started again.
// - The recall carries the person's prompt, so it is marked unlogged: the server keeps no query-log row and opens no
//   gap item for it, as for the session brief (Part A 4.6, KOA2-42).
// - Every call says which repo and model it came from in `_meta` (provenance.mjs, KOA2-149), on the same request.
// It fails open: on any problem it adds nothing, prints one line on stderr and exits 0. Budget 1.5 s (KALIBRATE_HOOK_BUDGET_MS overrides). Other clients pass `--client` and `--project`.
// No MCP handshake (KOA2-64): each call is one `tools/call` request, sent alone with the `MCP-Protocol-Version`
// header, so a later prompt is one HTTP request and the first is two in parallel (a plugin install's first adds its
// spaces read, beside the recall, before the lease start). A server that wants the handshake
// gets it once, and the hook says so on stderr.

import { BUDGETS, IDEMPOTENCY_META, UNLOGGED_META, budgetFrom, callTool, connect, finish, messageOf, runWithBudget } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs, promptOutput } from "./client.mjs";
import { NoCredentialError, signInStep } from "./device.mjs";
import { firstBlock, isTrivial, recallQuery, leaseKey, leaseLive, newsBlock, promptOf, readState, restartedLine, sessionIdOf, sessionKey, writeState } from "./wip.mjs";
import { projectLabel } from "./label.mjs";
import { fetchSpaces } from "./capture.mjs";
import { ServerOfflineError } from "./offline.mjs";
import { autoLeaseSpace } from "./lease-space.mjs";
import { pickedSpace } from "./spaces.mjs";
import { provenanceMeta } from "./provenance.mjs";

/** How many results one recall asks for: enough for a first block, few enough to stay inside the budget. */
const RECALL_LIMIT = 5;

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
let context = null;
let notice = "";
let session = null;

/** Starts lease number `n` for this session, returning the `WorkResult` or null when the server refused it. */
async function startLease(session, key, n, what, client, reported) {
  const work = { action: "start", what, agent: { client }, idempotency_key: leaseKey(key, n) };
  try {
    return (await callTool(session, "work", work, { [IDEMPOTENCY_META]: leaseKey(key, n), ...reported })).structured ?? null;
  } catch (error) {
    notice += `koalafix: prompt hook could not start the WIP lease: ${messageOf(error)}\n`;
    return null;
  }
}

/** How long before the budget ends the lease's calls are given up on, so the memory block still goes out. */
const LEASE_CUTOFF_MS = 250;

/** What a lease start that had not answered by the cutoff resolves to. */
const LATE = Symbol("late");

/** The promise's value, or `late` when it has not settled by `until` (ms since the epoch). */
function settleBy(promise, until, late) {
  let timer;
  const cutoff = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, until - Date.now()), late);
  });
  return Promise.race([promise, cutoff]).finally(() => clearTimeout(timer));
}

/**
 * A plugin install: whether the session's lease would land in this folder's space (lease-space.mjs). True or false
 * once the spaces are read; null when they could not be, so the next prompt reads them again.
 */
async function leaseAllowed(target, root, deadlineAt) {
  try {
    return autoLeaseSpace(await fetchSpaces(target, deadlineAt), root, pickedSpace(root, env)) !== null;
  } catch (error) {
    // A server in its cool-off already gets the hook's one "skipped" line; saying it twice is noise.
    if (!(error instanceof ServerOfflineError)) {
      notice += `koalafix: prompt hook could not read your spaces, so it started no WIP lease yet: ${messageOf(error)}\n`;
    }
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
  const key = sessionKey(found.root, sessionId);
  // A project folder `koalafix init` tied to a space always gets an automatic lease, named when one is started; a
  // plugin install gets one when its first prompt found the lease would land in this folder's space.
  const project = found.user !== true;
  const state = readState(key, env);
  session = connect(target, deadlineAt);
  const about = recallQuery(prompt);
  const reported = provenanceMeta(found.root, input, key, env);
  const recall = callTool(session, "recall", { about, limit: RECALL_LIMIT }, { [UNLOGGED_META]: true, ...reported }).then((result) => result.structured ?? null);
  // The lease's calls stop short of the budget. A start still unanswered then is not counted, so the next try sends
  // the same idempotency key and gets the same lease back rather than leaving a second one open.
  const leaseBy = deadlineAt - LEASE_CUTOFF_MS;
  const leaseIf = (ok, n) => (ok === true ? settleBy(startLease(session, key, n, projectLabel(found.root), args.client, reported), leaseBy, LATE) : null);
  if (state === null) {
    const allowed = project ? Promise.resolve(true) : leaseAllowed(target, found.root, leaseBy);
    const [memory, started, autoLease] = await Promise.all([recall, allowed.then((ok) => leaseIf(ok, 1)), allowed]);
    const work = started === LATE ? null : started;
    const block = firstBlock(memory, work);
    context = block.text;
    writeState(key, { lease: work?.lease ?? null, expiresAt: work?.expires_at ?? null, leases: started === LATE ? 0 : 1, shown: block.shown, nudged: false, autoLease }, env);
    return;
  }
  // A plugin install whose spaces could not be read on the first prompt reads them again, until it knows.
  const allowed = project || state.autoLease !== null ? Promise.resolve(project || state.autoLease) : leaseAllowed(target, found.root, leaseBy);
  const restart = allowed.then((ok) => (leaseLive(state) ? null : leaseIf(ok, state.leases + 1)));
  const [memory, started, autoLease] = await Promise.all([recall, restart, allowed]);
  const work = started === LATE ? null : started;
  const known = { ...state, autoLease: project ? state.autoLease : autoLease };
  const next = work === null ? known : { ...known, lease: work.lease ?? null, expiresAt: work.expires_at ?? null, leases: state.leases + 1 };
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
