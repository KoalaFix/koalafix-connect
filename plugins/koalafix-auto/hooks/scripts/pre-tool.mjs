// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The first-edit gate's hook (ADR-0042, KOA2-135): Claude Code `PreToolUse` on Edit, Write, MultiEdit and
// NotebookEdit. Before the session's first edit of a path it asks `GET /api/v1/gate` whether the person has checked in
// for it. An allow or warn is cached for the session as the covering lease's paths, so a later edit inside them asks
// nothing; a block is not cached and denies the edit with the server's check-in instruction. `KALIBRATE_GATE` is off,
// warn or block (default block): warn turns a block into a note, off asks nothing.
// It never prints `permissionDecision: "allow"`, so the person's own permission prompt still runs. It fails open: on
// any problem (no credential, no network, a timeout, an HTTP error, a cool-off, bad JSON) it prints nothing on stdout,
// one line on stderr starting `koalafix: gate`, and exits 0. Budget 1 s (KALIBRATE_HOOK_BUDGET_MS overrides).
// The space is the one the person picked for this folder (spaces.mjs, a local file); none is sent when there is no pick.

import { budgetFrom, finish, messageOf, readApi, runWithBudget } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs } from "./client.mjs";
import { GATE_BUDGET_MS, alreadyWarned, allInScope, blockedAtFor, editPaths, gateBudget, gateMode, gateOutput, gateRoute, nextGate, readAnswer, readGate, realInput, repoRoot, writeGate } from "./gate.mjs";
import { pickedSpace } from "./spaces.mjs";
import { sessionIdOf, sessionKey } from "./wip.mjs";

const env = process.env;
const mode = gateMode(env);
const args = parseHookArgs(process.argv.slice(2));
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
    const paths = editPaths(realInput(input, found.root), root);
    if (paths === null) {
      return;
    }
    const sessionId = sessionIdOf(input);
    const key = sessionId === null ? null : sessionKey(found.root, sessionId);
    const state = key === null ? { scopes: [], blockedAt: null, blockedPaths: [], warned: [] } : readGate(key, env);
    if (allInScope(paths, state.scopes)) {
      return;
    }
    const route = gateRoute(paths, { space: pickedSpace(found.root, env), tool: input.tool_name, blockedAt: blockedAtFor(state, paths) });
    const answer = readAnswer(await readApi(target, route, deadlineAt, { slowIsDown: false }));
    if (answer === null) {
      throw new Error("GET /api/v1/gate answered something that is not a gate answer");
    }
    if (!alreadyWarned(state, answer)) {
      stdout = gateOutput(answer, mode);
    }
    if (key !== null) {
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
