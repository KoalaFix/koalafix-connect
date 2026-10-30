// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The first-edit gate's hook (ADR-0042, KOA2-135): Claude Code `PreToolUse` on Edit, Write, MultiEdit and
// NotebookEdit. Before the session's first edit of a path it asks `GET /api/v1/gate` whether the person has checked in
// for it. An allow or warn is cached for the session as the covering lease's paths, so a later edit inside them asks
// nothing; in block mode a block is not cached and denies the edit with the server's check-in instruction.
// `KALIBRATE_GATE` is off, warn or block (default block; warn for a `--user` install, the plugin's or `koalafix
// connect`'s, KOA2-558): warn turns a block into a note, shown once a session unless it names a teammate not shown
// before, and caches the path; off asks nothing. A `--user` install runs in any folder, so like the Stop hook it asks
// only where the prompt hook found the folder is the team's (its automatic lease lands in the folder's space, KOA2-5):
// in a personal folder it sends no path and never tells the agent to check in.
// It never prints `permissionDecision: "allow"`, so the person's own permission prompt still runs. It fails open: on
// any problem (no credential, no network, a timeout, an HTTP error, a cool-off, bad JSON) it prints nothing on stdout,
// one line on stderr starting `koalafix: gate`, and exits 0. Budget 1 s (KALIBRATE_HOOK_BUDGET_MS overrides).
// The space is the one the person picked for this folder (spaces.mjs, a local file); none is sent when there is no pick.

import { budgetFrom, finish, messageOf, readApi, runWithBudget } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs } from "./client.mjs";
import { GATE_BUDGET_MS, MAX_PATHS, allInScope, alreadyShown, blockedAtFor, editPaths, emptyGate, gateBudget, gateMode, gateOutput, gateRepo, gateRoute, nextGate, readAnswer, readGate, realInput, repoRoot, writeGate } from "./gate.mjs";
import { commitPaths, shellOf, shellPaths } from "./shell-writes.mjs";
import { pickedSpace } from "./spaces.mjs";
import { readState, sessionIdOf, sessionKey } from "./wip.mjs";

/**
 * The repository paths a Bash or PowerShell command writes (shell-writes.mjs, KOA2-390), with a `git commit`'s paths
 * from git inside what is left of the budget; null when it writes none, so a read like `ls` or `git status` asks nothing.
 */
async function commandPaths(input, root, folder, deadlineAt) {
  const writes = shellPaths(input, root, folder);
  if (writes === null) {
    return null;
  }
  const committed = await Promise.all(writes.commits.map((commit) => commitPaths(commit, Math.max(1, deadlineAt - Date.now() - 100))));
  const paths = [...new Set([...writes.paths, ...committed.flat()])].slice(0, MAX_PATHS);
  return paths.length === 0 ? null : paths;
}

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
const mode = gateMode(env, args.user ? "warn" : "block");
let stdout = "";
let notice = "";
if (mode !== "off") {
  // A gate that runs out of time lets the edit through and leaves the server's cool-off alone: one slow check must not
  // turn off the prompt and Stop hooks for a minute.
  const outcome = await runWithBudget(gateBudget(budgetFrom(env, GATE_BUDGET_MS)), async (deadlineAt) => {
    const input = await readHookInput(process.stdin, 200);
    if (args.error !== null) {
      throw new Error(args.error);
    }
    const located = locateHook(args, env, input);
    if (located === null) {
      return;
    }
    const { found, target } = located;
    // Leases name paths from the repository's top level, through any junction or symlink to it.
    const root = repoRoot(found.root);
    const sessionId = sessionIdOf(input);
    const key = sessionId === null ? null : sessionKey(found.root, sessionId);
    // A --user install in a personal folder asks nothing, so it reads no command and starts no git either.
    if (found.user === true && (key === null || readState(key, env)?.autoLease !== true)) {
      return;
    }
    const paths = shellOf(input?.tool_name) === null ? editPaths(realInput(input, found.root), root) : await commandPaths(input, root, found.root, deadlineAt);
    if (paths === null) {
      return;
    }
    const state = key === null ? emptyGate() : readGate(key, env);
    if (allInScope(paths, state.scopes)) {
      return;
    }
    const route = gateRoute(paths, { space: pickedSpace(found.root, env), repo: gateRepo(found.root), tool: input.tool_name, blockedAt: blockedAtFor(state, paths) });
    const answer = readAnswer(await readApi(target, route, deadlineAt, { slowIsDown: false }));
    if (answer === null) {
      throw new Error("GET /api/v1/gate answered something that is not a gate answer");
    }
    if (!alreadyShown(state, answer, mode)) {
      stdout = gateOutput(answer, mode);
    }
    // An answer that came after the budget ran out was never shown, so it must not mark anything shown.
    if (key !== null && Date.now() < deadlineAt) {
      try {
        writeGate(key, nextGate(state, answer, paths, mode), env);
      } catch (error) {
        notice += `koalafix: gate could not keep its session cache: ${messageOf(error)}\n`;
      }
    }
  }, { slowIsDown: false });
  if (!outcome.ok) {
    stdout = "";
    notice += `koalafix: gate skipped: ${messageOf(outcome.error)}\n`;
  }
}
finish({ stdout, stderr: notice });
