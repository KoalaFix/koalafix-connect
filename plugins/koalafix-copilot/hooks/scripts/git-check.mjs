// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// What the git backstop decides (KOA2-140), kept apart from git-hook.mjs so it can be tested without running a script:
// which paths a commit or a push changes, which of them none of the person's open work items covers (asking the
// first-edit gate's read route, ADR-0042), and the warning to print. Agents can skip git hooks, so this is a backstop
// for people and for clients with no pre-tool hook, never the gate itself. Plain ESM, Node 22 APIs only.

import { execFile } from "node:child_process";
import { MAX_PATHS, MAX_PATH_CHARS, inScope, normalisePath } from "./gate.mjs";

/**
 * KoalaFix's share of a commit, in ms: finding the server and every gate ask, the part that hangs when KoalaFix is
 * slow or down. The issue's limit is 300 ms added to a commit. Node's start and git's own listing of the changed paths
 * (GIT_LIST_MS) come on top: they cost the same for any hook on that machine. KALIBRATE_GIT_HOOK_BUDGET_MS overrides
 * it, never past the cap.
 */
export const GIT_BUDGET_MS = 250;
export const GIT_BUDGET_CAP_MS = 5000;

/** How long git may take to list the changed paths before the check gives up (fails open). */
export const GIT_LIST_MS = 2000;

/** The most gate asks one check makes; past it the rest of the paths count as unchecked, never as uncovered. */
export const MAX_ASKS = 16;

/** How many single-path asks narrowing sends at once. */
export const PARALLEL = 6;

/** The most changed paths one check looks at (a huge merge or a vendored folder stays cheap). */
export const MAX_CHANGED = 400;

/** How many uncovered entries the warning names before "and N more". */
const SHOWN = 5;

const ZERO = /^0+$/;

/** `KALIBRATE_GIT_GATE`: off, warn or block. Anything else, or unset, is warn: the backstop never blocks by default. */
export function gitMode(env = process.env) {
  const value = String(env.KALIBRATE_GIT_GATE ?? "").trim().toLowerCase();
  return value === "off" || value === "block" ? value : "warn";
}

/** The budget for one check: KALIBRATE_GIT_HOOK_BUDGET_MS when it is a positive number, never past the cap. */
export function gitBudget(env = process.env) {
  const given = Number(env.KALIBRATE_GIT_HOOK_BUDGET_MS);
  return Math.min(Number.isFinite(given) && given > 0 ? given : GIT_BUDGET_MS, GIT_BUDGET_CAP_MS);
}

/**
 * Runs git in `cwd` and resolves to its stdout, or rejects. `timeoutMs` stops a git that hangs (a lock, a prompt).
 * @param {readonly string[]} args
 * @param {{ cwd: string, timeoutMs: number }} options
 * @returns {Promise<string>}
 */
export function runGit(args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8", timeout: Math.max(1, timeoutMs), windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/**
 * git's `-z` output as normalised, distinct paths: at most MAX_CHANGED, none longer than the wire allows. `dropped`
 * counts the ones left out, which the warning reports as unchecked rather than pass over in silence.
 */
export function pathList(text) {
  const seen = new Set();
  let tooLong = 0;
  for (const raw of String(text).split("\0")) {
    const file = normalisePath(raw);
    if (file === "") {
      continue;
    }
    if (file.length > MAX_PATH_CHARS) {
      tooLong++;
    } else {
      seen.add(file);
    }
  }
  const all = [...seen];
  return { paths: all.slice(0, MAX_CHANGED), dropped: tooLong + Math.max(0, all.length - MAX_CHANGED) };
}

/**
 * The ref updates git hands a pre-push hook on stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line):
 * each one that sends commits, as `{ local, remote }` with `remote` null for a new branch. Deletions send nothing.
 */
export function pushedRanges(stdin) {
  const ranges = [];
  for (const line of String(stdin).split(/\r?\n/)) {
    const [, local, , remote] = line.trim().split(/\s+/);
    if (typeof local === "string" && /^[0-9a-f]{7,64}$/i.test(local) && !ZERO.test(local)) {
      ranges.push({ local, remote: typeof remote === "string" && /^[0-9a-f]{7,64}$/i.test(remote) && !ZERO.test(remote) ? remote : null });
    }
  }
  return ranges;
}

/**
 * The paths a commit or a push changes, repo-relative, as `{ paths, dropped }`, or null when the check does not apply:
 * a merge commit (it carries a whole branch's files, already checked when they were committed), a push that sends
 * nothing, or the first push of a clone with no remote-tracking branch at all (its whole history would count). A push
 * counts only commits no remote-tracking branch has yet, so merging the base branch in and pushing names none of its
 * files. Renames count as a delete and an add, so both paths are checked. `git commit --amend` checks only what is
 * newly staged, not the whole amended commit: enough for a backstop.
 * @param {"pre-commit" | "pre-push"} kind
 * @param {{ git: (args: readonly string[]) => Promise<string>, stdin?: string }} io
 */
export async function changedPaths(kind, { git, stdin = "" }) {
  if (kind === "pre-commit") {
    // Both at once: on a busy Windows machine one git start alone can take a few hundred ms.
    const [merging, staged] = await Promise.all([
      git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
        () => true,
        () => false,
      ),
      git(["diff", "--cached", "--name-only", "--no-renames", "-z"]),
    ]);
    return merging ? null : pathList(staged);
  }
  const ranges = pushedRanges(stdin);
  if (ranges.length === 0) {
    return null;
  }
  // One log over every pushed ref (a --tags push names many). The remotes' tips may be commits this clone never
  // fetched; then the remote-tracking branches alone stand for them.
  const log = ["log", "--format=", "--name-only", "--no-renames", "-z", ...ranges.map((range) => range.local), "--not", "--remotes"];
  const tips = ranges.map((range) => range.remote).filter((remote) => remote !== null);
  const [tracked, files] = await Promise.all([git(["for-each-ref", "--count=1", "--format=x", "refs/remotes"]), tips.length === 0 ? git(log) : git([...log, ...tips]).catch(() => git(log))]);
  return tracked.trim() === "" && tips.length === 0 ? null : pathList(files);
}

/** The covering lease's paths in a gate answer, [] when it names none. */
function scopeOf(answer) {
  const lease = answer.covered_by;
  return lease !== null && typeof lease === "object" && Array.isArray(lease.paths) ? lease.paths.filter((entry) => typeof entry === "string") : [];
}

/**
 * The changed paths none of the person's open work items covers. The gate allows only when one lease covers every
 * path it is asked about, and a commit can span two work items, so: ask with up to MAX_PATHS paths; an allow or a warn
 * covers them, and every other path inside the covering lease; a block with no scoped lease at all (`no_lease`,
 * `unscoped`) leaves every path uncovered; any other block is narrowed by asking for up to PARALLEL paths one by one,
 * at the same time, so narrowing costs one more round trip, not one per path. A narrowed path that is covered may
 * cover the rest, so the next round asks them together again. At most `maxAsks` asks: what is left then is
 * `unchecked`, never uncovered. `overlaps` are the teammates' leases a warn named. `progress`, when given, holds the
 * same three after every round, so a caller whose time runs out mid-way still has what was settled.
 * @param {readonly string[]} paths
 * @param {(paths: readonly string[]) => Promise<Record<string, unknown>>} ask
 * @param {{ uncovered: string[], unchecked: string[], overlaps: Record<string, unknown>[] }} [progress]
 */
export async function uncoveredPaths(paths, ask, maxAsks = MAX_ASKS, progress = { uncovered: [], unchecked: [], overlaps: [] }) {
  let left = [...paths];
  /** @type {string[]} */
  const uncovered = [];
  /** @type {Map<string, Record<string, unknown>>} */
  const overlaps = new Map();
  /** @type {string[]} */
  const scopes = [];
  const covered = (answer) => {
    for (const work of Array.isArray(answer.overlaps) ? answer.overlaps : []) {
      if (work !== null && typeof work === "object" && typeof work.lease === "string") {
        overlaps.set(work.lease, work);
      }
    }
    scopes.push(...scopeOf(answer));
  };
  let asks = 0;
  let narrow = false;
  const report = () => {
    progress.uncovered = [...uncovered];
    progress.unchecked = [...left];
    progress.overlaps = [...overlaps.values()];
  };
  while (left.length > 0 && asks < maxAsks) {
    report();
    if (!narrow) {
      const asked = left.slice(0, MAX_PATHS);
      asks++;
      const answer = await ask(asked);
      if (answer.decision !== "block") {
        covered(answer);
        left = left.filter((file) => !asked.includes(file) && !inScope(file, scopes));
      } else if (answer.reason === "no_lease" || answer.reason === "unscoped") {
        uncovered.push(...left);
        left = [];
      } else {
        narrow = asked.length > 1;
        if (!narrow) {
          uncovered.push(...asked);
          left = left.slice(1);
        }
      }
      continue;
    }
    const asked = left.slice(0, Math.min(PARALLEL, maxAsks - asks));
    asks += asked.length;
    const answers = await Promise.all(asked.map((file) => ask([file])));
    answers.forEach((answer, index) => (answer.decision === "block" ? uncovered.push(asked[index] ?? "") : covered(answer)));
    // Back to asking together only when a narrowed path was covered: its lease may cover the rest.
    narrow = answers.every((answer) => answer.decision === "block");
    left = left.filter((file) => !asked.includes(file) && !inScope(file, scopes));
  }
  report();
  return { uncovered, unchecked: left, overlaps: [...overlaps.values()], asks };
}

/** Uncovered files grouped for the warning: a folder with two or more of them shows once, as `folder/ (n files)`. */
export function grouped(files) {
  const byFolder = new Map();
  for (const file of files) {
    const cut = file.lastIndexOf("/");
    const folder = cut === -1 ? "" : file.slice(0, cut);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  const entries = [];
  for (const [folder, inside] of byFolder) {
    if (inside.length > 1 && folder !== "") {
      entries.push(`${folder}/ (${inside.length} files)`);
    } else {
      entries.push(...inside);
    }
  }
  return entries.length > SHOWN ? `${entries.slice(0, SHOWN).join(", ")} and ${entries.length - SHOWN} more` : entries.join(", ");
}

/** Server text for a terminal: control characters (escape codes, line breaks) become spaces, so none can forge a line. */
function plain(value) {
  return Array.from(String(value), (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : char;
  }).join("");
}

/**
 * What the hook prints on stderr, "" for nothing: the uncovered paths and how to check in, teammates on the same
 * paths, and how much went unchecked. `blocking` says the commit or push was stopped (KALIBRATE_GIT_GATE=block).
 * @param {"pre-commit" | "pre-push"} kind
 * @param {{ uncovered: readonly string[], unchecked: readonly string[], overlaps: readonly Record<string, unknown>[], dropped?: number }} result
 * @param {boolean} blocking
 */
export function warning(kind, result, blocking) {
  const act = kind === "pre-commit" ? "commit" : "push";
  const lines = [];
  if (result.uncovered.length > 0) {
    lines.push(`koalafix: no open work item of yours covers ${grouped(result.uncovered)} in this ${act}.`);
    lines.push(`koalafix: check in so your team sees it: have your agent call work(action: "start", what: "<the task>", paths: [<these files or folders>]).`);
    lines.push(blocking ? `koalafix: the ${act} was stopped (KALIBRATE_GIT_GATE=block). Check in, or run it again with KALIBRATE_GIT_GATE=warn.` : `koalafix: this is a warning; the ${act} went ahead.`);
  }
  for (const work of result.overlaps) {
    lines.push(`koalafix: a teammate is on these paths too: ${plain(work.who ?? "someone")} on "${plain(work.what ?? "")}" [lease ${plain(work.lease)}].`);
  }
  const unchecked = result.unchecked.length + (result.dropped ?? 0);
  if (unchecked > 0) {
    lines.push(`koalafix: ${unchecked} more changed file${unchecked === 1 ? "" : "s"} went unchecked (too many, or too long a path, to check in time).`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
