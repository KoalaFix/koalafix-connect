// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// What the first-edit gate decides (ADR-0042, KOA2-135), kept apart from pre-tool.mjs so it can be tested without
// running a script: which paths an edit touches, whether a session's cached scopes already cover them, the route to
// ask, and what to print for the answer. The answer is core's `GateAnswer` (packages/core/src/contract/gate.ts).
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { reportedRepo } from "./provenance.mjs";
import { kalibrateHome } from "./spool.mjs";

/** The gate's wall-clock budget in ms: one read, so short; KALIBRATE_HOOK_BUDGET_MS overrides it (connect.mjs budgetFrom). */
export const GATE_BUDGET_MS = 1000;

/**
 * The longest budget the gate may take, whatever KALIBRATE_HOOK_BUDGET_MS says: half a second inside the 5 s timeout
 * the PreToolUse entry sets (settings.ts), so the hook always ends by itself and Claude Code never kills it.
 */
export const GATE_BUDGET_CAP_MS = 4500;

/** The budget for one gate check: the configured one, never past the cap. */
export function gateBudget(configured) {
  return Math.min(configured, GATE_BUDGET_CAP_MS);
}

/** core's `GATE_LIMITS`: the most paths one check carries, and the longest one. */
export const MAX_PATHS = 20;
export const MAX_PATH_CHARS = 300;

/** The most scopes a session keeps, so a long session cannot grow the file without end. */
const MAX_SCOPES = 200;

/** The edit tools the gate watches, and the input field that names the file each one changes. */
const PATH_FIELDS = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `KALIBRATE_GATE`: off, warn or block. Anything else, or unset, is `fallback`: block for a `koalafix init` project
 * (ADR-0042 6), warn for a plugin's `--user` install, which nobody configured for the gate (KOA2-558).
 */
export function gateMode(env = process.env, fallback = "block") {
  const value = String(env.KALIBRATE_GATE ?? "").trim().toLowerCase();
  return value === "off" || value === "warn" || value === "block" ? value : fallback;
}

/** core's `normalisePath`: forward slashes, no `./` prefix, no trailing slash; "." is "" (the whole tree). */
export function normalisePath(value) {
  let out = String(value).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) {
    out = out.slice(2);
  }
  out = out.replace(/\/+$/, "");
  return out === "." ? "" : out;
}

const DRIVE = /^[A-Za-z]:\//;

/** A path through its symlinks and junctions, or its nearest existing folder's real path plus the rest (a new file). */
export function realPath(file) {
  const rest = [];
  let at = path.resolve(file);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...rest.toReversed());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) {
        return path.resolve(file);
      }
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

/** The hook input with the edited file's path through its symlinks and junctions, read against `folder` when relative. */
export function realInput(input, folder) {
  const field = isRecord(input) && typeof input.tool_name === "string" && Object.hasOwn(PATH_FIELDS, input.tool_name) ? PATH_FIELDS[input.tool_name] : null;
  const given = field === null || !isRecord(input.tool_input) ? undefined : input.tool_input[field];
  if (typeof given !== "string" || given.trim() === "") {
    return input;
  }
  return { ...input, tool_input: { ...input.tool_input, [field]: realPath(path.resolve(folder, given)) } };
}

/** The git top level holding `folder` (the nearest folder with a `.git` file or folder), else the folder itself. */
export function repoRoot(folder) {
  const real = realPath(folder);
  for (let at = real; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, ".git"))) {
      return at;
    }
    if (path.dirname(at) === at) {
      return real;
    }
  }
}

/**
 * The repo-relative, forward-slash path of `file` under `root`, or null when it is outside the root. A relative file
 * is taken as relative to the root. Drive letters compare case-insensitively (Windows paths are).
 */
function relativeTo(file, root) {
  const given = String(file).trim().replace(/\\/g, "/");
  const base = String(root).trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = DRIVE.test(given) || DRIVE.test(`${base}/`);
  if (windows && given.startsWith("/") && !given.startsWith("//")) {
    // A single leading slash on Windows is the root of the current drive, never a path inside the repository.
    return null;
  }
  const absolute = windows ? DRIVE.test(given) || given.startsWith("//") : given.startsWith("/");
  const cleaned = path.posix.normalize(absolute ? given : `${base}/${given}`);
  const left = windows ? cleaned.toLowerCase() : cleaned;
  const right = windows ? base.toLowerCase() : base;
  if (!left.startsWith(`${right}/`)) {
    return null;
  }
  return cleaned.slice(base.length + 1);
}

/**
 * The paths a Claude Code PreToolUse input edits, relative to the project root, or null when the gate does not apply:
 * another tool, no path, a path outside the root (not our repository), or one longer than the wire allows.
 */
export function editPaths(input, projectRoot) {
  if (!isRecord(input) || typeof input.tool_name !== "string" || !Object.hasOwn(PATH_FIELDS, input.tool_name)) {
    return null;
  }
  const field = PATH_FIELDS[input.tool_name];
  const given = isRecord(input.tool_input) ? input.tool_input[field] : undefined;
  if (typeof given !== "string" || given.trim() === "" || typeof projectRoot !== "string" || projectRoot === "") {
    return null;
  }
  const relative = relativeTo(given, projectRoot);
  if (relative === null || relative === "" || relative.length > MAX_PATH_CHARS) {
    return null;
  }
  return [relative];
}

/** Whether a cached scope contains `file`: equal, or a parent on a segment boundary; "" and "." are the whole tree. */
export function inScope(file, scopes) {
  const target = normalisePath(file);
  return scopes.some((scope) => {
    const wanted = normalisePath(scope);
    return wanted === "" || target === wanted || target.startsWith(`${wanted}/`);
  });
}

/** Whether every path is inside some cached scope (and there is at least one path). */
export function allInScope(paths, scopes) {
  return paths.length > 0 && paths.every((file) => inScope(file, scopes));
}

/**
 * `/api/v1/gate?path=..&path=..[&space=..][&repo=..][&tool=..][&blocked_at=..]`, URL-encoded, at most 20 paths. `repo` is
 * the repository the paths are relative to, as `kalibrate/repo` reports it (ADR-0033, ADR-0045); omitted when unknown.
 * @param {readonly string[]} paths
 * @param {{ space?: string | null, repo?: string | null, tool?: string | null, blockedAt?: string | null }} [options]
 */
export function gateRoute(paths, { space = null, repo = null, tool = null, blockedAt = null } = {}) {
  const query = new URLSearchParams();
  for (const file of paths.slice(0, MAX_PATHS)) {
    query.append("path", file);
  }
  if (space) {
    query.set("space", space);
  }
  if (repo) {
    query.set("repo", repo);
  }
  if (tool) {
    query.set("tool", tool);
  }
  if (blockedAt) {
    query.set("blocked_at", blockedAt);
  }
  return `/api/v1/gate?${query.toString().replace(/\+/g, "%20")}`;
}

/** The repository name to send with a gate check for `root` (provenance.mjs `reportedRepo`), null when unknown or on any error. */
export function gateRepo(root) {
  try {
    return reportedRepo(root);
  } catch {
    return null;
  }
}

/** A GateAnswer with the fields the hook uses, or null for anything else. */
export function readAnswer(body) {
  if (!isRecord(body) || !["allow", "warn", "block"].includes(body.decision) || typeof body.message !== "string") {
    return null;
  }
  return body;
}

/**
 * What to print for Claude Code. A block in block mode denies the edit with the answer's message. A warn, or a block
 * in warn mode, adds the message as context in front of the edit and leaves the permission flow alone: this never
 * prints `permissionDecision: "allow"`, which would skip the person's own permission prompt. Allow prints nothing.
 * Returns the stdout text ("" for nothing).
 */
export function gateOutput(answer, mode) {
  if (mode === "off" || !isRecord(answer) || typeof answer.message !== "string") {
    return "";
  }
  if (answer.decision === "block" && mode === "block") {
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer.message } })}\n`;
  }
  if (answer.decision === "block" || answer.decision === "warn") {
    // The server's block message asks for the edit again; in warn mode the edit has gone ahead, so the note says so.
    const message = answer.decision === "block" ? `${answer.message} ${WARN_MODE_NOTE}` : answer.message;
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } })}\n`;
  }
  return "";
}

/** What a block in warn mode adds to the server's message: the edit was not stopped, so there is nothing to redo. */
export const WARN_MODE_NOTE = "(This edit was not stopped and need not be made again; check in before the next one.)";

/**
 * Removes the session's gate file at session end (session-end.mjs), so the sessions folder does not grow. Best effort:
 * a file it cannot remove must never stop the lease close that follows.
 */
export function removeGate(key, env = process.env) {
  try {
    fs.rmSync(gateStatePath(key, env), { force: true });
  } catch {
    // Left behind: harmless, since the gate never reads another session's file.
  }
}

/** The session's gate file, apart from wip.mjs's `<key>.json`. */
export function gateStatePath(key, env = process.env) {
  return path.join(kalibrateHome(env), "sessions", `${key}.gate.json`);
}

/** A session's gate cache before its first check. */
export const EMPTY_GATE = Object.freeze({ scopes: [], blockedAt: null, blockedPaths: [], warned: [], nudged: false });

/**
 * The session's gate cache: `{ scopes, blockedAt, blockedPaths, warned, nudged }`, empty when there is none or it
 * cannot be read. `nudged` is true once warn mode has shown the check-in note.
 */
export function readGate(key, env = process.env) {
  const empty = { ...EMPTY_GATE };
  try {
    const parsed = JSON.parse(fs.readFileSync(gateStatePath(key, env), "utf8"));
    if (!isRecord(parsed)) {
      return empty;
    }
    const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
    return { scopes: strings(parsed.scopes), blockedAt: typeof parsed.blockedAt === "string" ? parsed.blockedAt : null, blockedPaths: strings(parsed.blockedPaths), warned: strings(parsed.warned), nudged: parsed.nudged === true };
  } catch {
    return empty;
  }
}

/** Writes the gate cache through a temporary file and a rename, as wip.mjs does. */
export function writeGate(key, state, env = process.env) {
  const file = gateStatePath(key, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** core's `pathsOverlap`: the same path, or one inside the other on a segment boundary; "" is the whole tree. */
function overlap(a, b) {
  const left = normalisePath(a);
  const right = normalisePath(b);
  return left === "" || right === "" || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * The block time to send with a check of `paths`: the session's last block, only when these paths overlap the paths it
 * blocked, so the server's false-block line never counts a correct block of other paths.
 */
export function blockedAtFor(state, paths) {
  return state.blockedAt !== null && paths.some((file) => state.blockedPaths.some((blocked) => overlap(file, blocked))) ? state.blockedAt : null;
}

/** The teammates' lease ids a warn names. */
function teammateLeases(answer) {
  return Array.isArray(answer.overlaps) ? answer.overlaps.filter(isRecord).map((entry) => entry.lease).filter((lease) => typeof lease === "string") : [];
}

/**
 * The cache after an answer. Allow and warn add the answer's `scope` to the scopes (the asked paths when it names
 * none), drop the blocked paths they overlap, and remember a warn's teammate leases so each is shown once. A block adds
 * its paths to the blocked ones with the answer's as_of as the block time; it caches nothing in block mode, and in warn
 * mode (where the block only shows a note) it caches the asked paths, marks the check-in note shown and remembers the
 * teammates it named, so the note shows once a session and each teammate once.
 */
export function nextGate(state, answer, asked, mode = "block") {
  const warned = [...new Set([...state.warned, ...teammateLeases(answer)])].slice(-MAX_SCOPES);
  if (answer.decision === "block") {
    const blockedAt = typeof answer.as_of === "string" ? answer.as_of : state.blockedAt;
    const blockedPaths = [...new Set([...state.blockedPaths, ...asked])].slice(-MAX_SCOPES);
    if (mode !== "warn") {
      return { ...state, blockedAt, blockedPaths };
    }
    // In warn mode the block was only a note: the asked paths count as seen, so the note shows once.
    const scopes = [...new Set([...state.scopes, ...asked])].slice(-MAX_SCOPES);
    return { scopes, blockedAt, blockedPaths, warned, nudged: true };
  }
  const given = Array.isArray(answer.scope) ? answer.scope.filter((entry) => typeof entry === "string").map(normalisePath) : [];
  const scopes = [...new Set([...state.scopes, ...(given.length > 0 ? given : asked)])].slice(-MAX_SCOPES);
  const blockedPaths = state.blockedPaths.filter((blocked) => !asked.some((file) => overlap(file, blocked)));
  return { scopes, blockedAt: blockedPaths.length === 0 ? null : state.blockedAt, blockedPaths, warned, nudged: state.nudged === true };
}

/** Whether every teammate lease a warn names was already shown this session (so it is not shown again). */
export function alreadyWarned(state, answer) {
  const leases = teammateLeases(answer);
  return answer.decision === "warn" && leases.length > 0 && leases.every((lease) => state.warned.includes(lease));
}

/**
 * Whether the answer would only repeat what the session was already shown: a warn whose teammates were all shown, or,
 * in warn mode, a block after the check-in note was shown that names no teammate not shown before. A block in block
 * mode always shows (it denies the edit).
 */
export function alreadyShown(state, answer, mode) {
  if (answer.decision === "warn") {
    return alreadyWarned(state, answer);
  }
  return answer.decision === "block" && mode === "warn" && state.nudged === true && teammateLeases(answer).every((lease) => state.warned.includes(lease));
}
