// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The git backstop (KOA2-140): `koalafix init` writes .git/hooks/pre-commit and pre-push, which run
// `node git-hook.mjs <pre-commit|pre-push> --project <dir>`. It lists the paths the commit or push changes, asks the
// first-edit gate's read route (`GET /api/v1/gate`, ADR-0042) whether the person's open work items cover them, and
// prints a warning on stderr for the ones none covers. It never stops the commit or push unless KALIBRATE_GIT_GATE=block
// (off asks nothing); a block exits BLOCK_EXIT, which the hook init writes turns into git's refusal, and every other
// exit lets git go on. It fails open: no credential, no network, a timeout, an HTTP error or bad JSON prints one line
// starting `koalafix: git check skipped` and exits 0; a folder with no install anywhere stays silent. The install is
// the current worktree's own `.kalibrate` when it has one, since git runs a repository's hooks from every worktree,
// else the `--project` init wrote. KoalaFix's part (finding the server and the
// gate asks) has 250 ms (KALIBRATE_GIT_HOOK_BUDGET_MS overrides it); git lists the changed paths first, within 2 s.

import fs from "node:fs";
import path from "node:path";
import { messageOf, readApi, redact, runWithBudget } from "./connect.mjs";
import { locateHook, parseHookArgs } from "./client.mjs";
import { gateRepo, gateRoute, readAnswer } from "./gate.mjs";
import { GIT_LIST_MS, changedPaths, gitBudget, gitMode, runGit, uncoveredPaths, warning } from "./git-check.mjs";
import { pickedSpace } from "./spaces.mjs";

const KINDS = new Set(["pre-commit", "pre-push"]);

/** The exit code for a deliberate block; init's hook text stops git on this code only (packages/cli init-git.ts). */
const BLOCK_EXIT = 3;

/** Whether `dir` holds a project install (`koalafix init`'s config). */
function installed(dir) {
  return typeof dir === "string" && fs.existsSync(path.join(dir, ".kalibrate", "config.json"));
}

/** All of stdin as text (git's pre-push ref lines), or "" once `deadlineAt` passes. */
function readStdin(deadlineAt) {
  return new Promise((resolve) => {
    let text = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      resolve(text);
    };
    const timer = setTimeout(done, Math.max(0, deadlineAt - Date.now()));
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/** Writes stderr, then lets the process end with `code` (connect.mjs's finish, with an exit code a hook may use). */
function end(text, code) {
  process.exitCode = code;
  process.stdin.destroy();
  const flushed = text === "" ? Promise.resolve() : new Promise((resolve) => process.stderr.write(redact(text), resolve));
  flushed.then(() => setTimeout(() => process.exit(code), 200).unref());
}

/**
 * Git lists the changed paths (its own time limit), then KoalaFix's part runs inside the budget: find the server and
 * ask the gate. Resolves like runWithBudget: `{ ok, value }` with null for "nothing to check", or `{ ok: false, error }`.
 */
async function listThenAsk() {
  let listed;
  try {
    if (!KINDS.has(kind)) {
      throw new Error(`the first argument is pre-commit or pre-push, not ${JSON.stringify(String(kind ?? ""))}`);
    }
    if (args.error !== null) {
      throw new Error(args.error);
    }
    const listedBy = Date.now() + GIT_LIST_MS;
    const stdin = kind === "pre-push" ? await readStdin(listedBy) : "";
    const git = (gitArgs) => runGit(gitArgs, { cwd: process.cwd(), timeoutMs: listedBy - Date.now() });
    listed = await changedPaths(kind, { git, stdin });
  } catch (error) {
    return { ok: false, error };
  }
  // git runs hooks at the top of the worktree: its own install wins over the one init named.
  const here = process.cwd();
  const project = installed(here) ? here : args.project;
  if (listed === null || (listed.paths.length === 0 && listed.dropped === 0) || !installed(project)) {
    return { ok: true, value: null };
  }
  const { paths, dropped } = listed;
  // What the asks have settled so far: kept when the budget runs out mid-way, so a proven gap is still reported.
  const progress = { uncovered: [], unchecked: [...paths], overlaps: [], dropped };
  const outcome = await runWithBudget(
    gitBudget(env),
    async (deadlineAt) => {
      const located = locateHook({ ...args, project }, env, {});
      if (located === null) {
        return null;
      }
      const { found, target } = located;
      const space = pickedSpace(found.root, env);
      const repo = gateRepo(found.root);
      const tool = kind === "pre-commit" ? "git-commit" : "git-push";
      const result = await uncoveredPaths(
        paths,
        async (asked) => {
          const answer = readAnswer(await readApi(target, gateRoute(asked, { space, repo, tool }), deadlineAt, { slowIsDown: false }));
          if (answer === null) {
            throw new Error("GET /api/v1/gate answered something that is not a gate answer");
          }
          return answer;
        },
        undefined,
        progress,
      );
      return { ...result, dropped };
    },
    { slowIsDown: false },
  );
  return !outcome.ok && progress.uncovered.length > 0 ? { ok: true, value: progress, late: outcome.error } : outcome;
}

const env = process.env;
const mode = gitMode(env);
const kind = process.argv[2];
const args = parseHookArgs(process.argv.slice(3));
if (mode === "off") {
  end("", 0);
} else {
  const outcome = await listThenAsk();
  if (!outcome.ok) {
    end(`koalafix: git check skipped: ${messageOf(outcome.error)}\n`, 0);
  } else if (outcome.value === null) {
    end("", 0);
  } else {
    const blocking = mode === "block" && outcome.value.uncovered.length > 0;
    const late = outcome.late === undefined ? "" : `koalafix: git check stopped early: ${messageOf(outcome.late)}\n`;
    end(late + warning(kind, outcome.value, blocking), blocking ? BLOCK_EXIT : 0);
  }
}
