// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// What the prompt and session-end hooks decide, kept apart from the scripts so it can be tested without running one.
// The hook, not the model, starts the session's WIP lease and puts team memory in front of the first real prompt;
// after that it adds only what this session has not been shown (a fact in a new state, a new fact key, a change since
// the person last read it, a teammate's lease). Notes are shown once, on the first prompt, never as news. A teammate's
// lease on the files the prompt is about is pushed as a collision warning, once (ADR-0041). Team memory always sits
// inside the data frame (memory-frame.mjs); KoalaFix's own lines stay outside it. The inputs are the real tools'
// shapes: `RecallResult` and `WorkResult` (packages/core/src/contract/tools-io.ts).
// Plain ESM, Node 22 APIs only, no dependencies.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./connect.mjs";
import { FRAME_CHARS, framed } from "./memory-frame.mjs";
import { isWholeTree, overlaps } from "./paths.mjs";
import { kalibrateHome } from "./spool.mjs";

/** The most characters one injected block may hold: about 400 tokens. */
export const MAX_BLOCK_CHARS = 1500;

/** How many new fact keys one later prompt may add. */
export const MAX_NEW_FACTS = 3;

/** How many notes the first block shows. */
export const MAX_NOTES = 3;

/** A lease this close to its end is started again rather than relied on. */
const LEASE_MARGIN_MS = 60_000;

/** Words that only acknowledge: a prompt made of these and stopwords ("ok, continue", "yes go ahead") is skipped. */
const ACK_WORDS = new Set("y n k ok okay yes yep yup yeah no nope sure go ahead do it continue carry on proceed next done thanks thank you ty cool great nice perfect lgtm sounds good please".split(" "));

/** Words that carry no topic: a prompt made only of these is not worth a recall. */
const STOPWORDS = new Set(
  "the and for are but not you your all any can had her was one our out has have him his how its may new now see two who did get got let put say she too use what when where which while with this that these those then than them they there their from into just also only some such very will would should could about after again more most other over same each both does doing done here please thanks okay yes".split(" "),
);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function shownValue(value) {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value ?? null);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The words of a prompt that name a topic: three letters or more, not a stopword. */
export function contentWords(prompt) {
  return (String(prompt).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** Whether a prompt is an acknowledgement or holds no topic: the hook then asks the server nothing. */
export function isTrivial(prompt) {
  const text = String(prompt ?? "").trim();
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.every((word) => ACK_WORDS.has(word)) || contentWords(text).length === 0;
}

/** Credential shapes a person might paste into a prompt: KoalaFix and bearer tokens, then common provider keys. */
export const KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

/**
 * The prompt as the recall sends it: at most 2,000 characters, with anything shaped like a credential or a private key
 * taken out. The recall is unlogged, but the text still crosses the network to the server.
 */
export function recallQuery(prompt) {
  const text = redact(String(prompt)).replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<redacted key>");
  return text.replace(KEY_SHAPES, "<redacted>").slice(0, 2000);
}

/** The session id a client sends its hooks: `session_id` (Claude Code, Codex, Gemini CLI) or `conversation_id` (Cursor). */
export function sessionIdOf(input) {
  for (const name of ["session_id", "conversation_id", "sessionId"]) {
    const value = isRecord(input) ? input[name] : undefined;
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/** The prompt text a client sends: `prompt` everywhere we hook, `user_prompt` as a fallback. */
export function promptOf(input) {
  for (const name of ["prompt", "user_prompt"]) {
    const value = isRecord(input) ? input[name] : undefined;
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

/** A stable, opaque id for one session in one project: the state file's name and the idempotency keys' stem. */
export function sessionKey(project, sessionId) {
  return crypto.createHash("sha256").update(`${project}\n${sessionId}`).digest("hex").slice(0, 32);
}

export function statePath(key, env = process.env) {
  return path.join(kalibrateHome(env), "sessions", `${key}.json`);
}

/** The session's state, or null for a session the hook has not started yet (or whose file is unreadable). */
export function readState(key, env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(key, env), "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.shown)) {
      return null;
    }
    return {
      lease: typeof parsed.lease === "string" ? parsed.lease : null,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      leases: Number.isInteger(parsed.leases) ? parsed.leases : 0,
      shown: parsed.shown.filter((entry) => typeof entry === "string"),
      nudged: parsed.nudged === true,
      // A plugin install: whether the lease would land in this folder's space (lease-space.mjs); null: not known yet.
      autoLease: parsed.autoLease === true ? true : parsed.autoLease === null ? null : false,
      turns: Number.isInteger(parsed.turns) && parsed.turns >= 0 ? parsed.turns : 0,
      covered: Number.isInteger(parsed.covered) && parsed.covered >= 0 ? parsed.covered : 0,
      capturedAt: Number.isFinite(parsed.capturedAt) ? parsed.capturedAt : null,
      // The spaces the capture offered when it asked the person which one (once a session), else null.
      asked: Array.isArray(parsed.asked) ? parsed.asked.filter((slug) => typeof slug === "string") : null,
      // The transcript's size when it asked: the pick is looked for only after it.
      askedFrom: Number.isInteger(parsed.askedFrom) && parsed.askedFrom >= 0 ? parsed.askedFrom : 0,
    };
  } catch {
    return null;
  }
}

/** Writes the state through a temporary file and a rename, so a reader never sees half of it. */
export function writeState(key, state, env = process.env) {
  const file = statePath(key, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function removeState(key, env = process.env) {
  fs.rmSync(statePath(key, env), { force: true });
}

/** Whether the session's lease can still be counted on: it exists and has more than a minute left. */
export function leaseLive(state, now = Date.now()) {
  if (state === null || state.lease === null) {
    return false;
  }
  const ends = state.expiresAt === null ? Number.NaN : Date.parse(state.expiresAt);
  return Number.isNaN(ends) || ends - now > LEASE_MARGIN_MS;
}

/** The idempotency key for the session's n-th lease: two hook configs firing for one prompt open one lease. */
export function leaseKey(key, n) {
  return `hook-wip:${key}:${n}`;
}

function list(result, name) {
  return isRecord(result) && Array.isArray(result[name]) ? result[name].filter(isRecord) : [];
}

function factLine(fact) {
  const value = "value" in fact ? ` = ${shownValue(fact.value)}` : "";
  const owner = typeof fact.owner === "string" && fact.owner !== "" ? `, owner ${str(fact.owner, 40)}` : "";
  const told = typeof fact.instruction === "string" && fact.instruction !== "" ? ` ${str(fact.instruction, 160)}` : "";
  return `- ${str(fact.key, 80)}${value} (${str(fact.state, 20) || "?"}${owner})${told}`;
}

function workingLine(work) {
  const agent = typeof work.agent === "string" && work.agent !== "" ? ` (${str(work.agent, 30)})` : "";
  return `- ${str(work.who, 40)}${agent}: ${str(work.what, 100)} [${str(work.lease, 20)}, started ${str(work.started_ago, 20)}, ends in ${str(work.ends_in, 20)}]`;
}

function changeLine(change) {
  return `- ${str(change.key, 80)} changed ${str(change.changed_ago, 20)}: ${shownValue(change.was)} -> ${shownValue(change.now)}`;
}

/**
 * What the hook says, outside the team memory, when a teammate's check-in overlaps the files the prompt is about
 * (ADR-0041): pushed before the agent edits, instead of found only when it checks in itself.
 */
export const COLLISION_WARNING =
  "Heads up from KoalaFix: a teammate has checked in on files this prompt is about (Collision below). Tell the person who and what before you edit those files.";

/**
 * Adds memory lines while they fit in `budget` characters, recording their signatures only when a line is kept. A
 * section's header is written only together with its first kept line, so no header stands empty (an empty "Teammates
 * working:" would read as nobody).
 */
function packer(budget) {
  const lines = [];
  const kept = [];
  let size = 0;
  let pending = null;
  return {
    /** The header the next kept line goes under; null for lines with no header. */
    section(header) {
      pending = header;
    },
    add(line, ...signatures) {
      const adding = pending === null ? [line] : [pending, line];
      const cost = adding.reduce((sum, text) => sum + text.length, 0) + adding.length - (lines.length === 0 ? 1 : 0);
      if (size + cost > budget) {
        return false;
      }
      lines.push(...adding);
      size += cost;
      pending = null;
      kept.push(...signatures);
      return true;
    },
    lines: () => lines,
    kept: () => kept,
    count: () => lines.length,
  };
}

/** What is left of the block's cap for team memory once KoalaFix's own lines and the frame are counted. */
function memoryBudget(guidance) {
  return MAX_BLOCK_CHARS - guidance.join("\n").length - 1 - FRAME_CHARS;
}

/** A lease's paths, without one on the whole tree: that overlaps every file, so it warns of nothing in particular. */
function pathList(entry) {
  return Array.isArray(entry?.paths) ? entry.paths.filter((path) => typeof path === "string" && !isWholeTree(path)) : [];
}

/**
 * The project a hook-started lease's label names (label.mjs: "working in <repo> on <branch>", or "working in <folder>"),
 * lower case; null for a label an agent wrote itself, which says nothing about its repository.
 */
export function labelProject(what) {
  const match = /^working in (\S+?)(?: on \S.*)?$/.exec(typeof what === "string" ? what : "");
  return match === null ? null : match[1].toLowerCase();
}

/**
 * Whether a teammate's lease sits on one of the paths this prompt is about. Paths are relative to a repository, so a
 * hook lease whose label names another project (`project` is this one's) is on another `package.json`, not this one.
 */
function onPaths(entry, paths, project) {
  const theirs = labelProject(entry?.what);
  if (project !== null && theirs !== null && theirs !== project) {
    return false;
  }
  return paths.length > 0 && pathList(entry).some((path) => paths.some((mine) => overlaps(path, mine)));
}

/** "- Collision: harry (codex): <label> [w_9, ...] on <their paths>; this prompt: <the prompt's paths>". */
function collisionLine(entry, paths) {
  const theirs = pathList(entry).filter((path) => paths.some((mine) => overlaps(path, mine)));
  const mine = paths.filter((path) => theirs.some((other) => overlaps(other, path)));
  const shown = (some) => some.slice(0, 3).map((path) => str(path, 80)).join(", ");
  const on = theirs.length === 0 ? "" : ` on ${shown(theirs)}`;
  const prompt = mine.length === 0 ? "" : `; this prompt: ${shown(mine)}`;
  return `- Collision: ${workingLine(entry).slice(2)}${on}${prompt}`;
}

function verdictHeader(recall) {
  const verdict = isRecord(recall) && typeof recall.verdict === "string" ? recall.verdict.toUpperCase() : "UNKNOWN";
  const instruction = isRecord(recall) ? str(recall.instruction, 220) : "";
  return `KoalaFix team memory for this task (added by a hook, not by you): ${verdict}.${instruction === "" ? "" : ` ${instruction}`}`;
}

/**
 * The first prompt's block: the verdict and its instruction and the lease the hook started (KoalaFix's own lines),
 * then the team memory inside the frame: collisions (the lease start's overlaps, and teammates' leases on the paths this
 * prompt is about, in this project), facts, notes, teammates' work and changes, cut to 1,500 characters in all. The
 * warning line goes out only with a collision line it can point at. `work` is null when the lease could not be started.
 * Returns the text and the signatures of everything it shows.
 */
export function firstBlock(recall, work, ownLease = null, paths = [], project = null) {
  const guidance = [verdictHeader(recall)];
  const lease = isRecord(work) && typeof work.lease === "string" ? work.lease : null;
  if (lease !== null) {
    const ends = typeof work.expires_at === "string" ? `, until ${work.expires_at}` : "";
    guidance.push(`WIP: the hook started lease ${lease} for this task${ends}; the session-end hook closes it. If you finish sooner, work(done, lease: "${lease}") with the outcome.`);
  }
  const own = (entry) => entry.lease === lease || entry.lease === ownLease;
  const found = [...list(work, "overlaps"), ...list(recall, "working_on")].filter((entry) => !own(entry) && onPaths(entry, paths, project));
  const collisions = found.filter((entry, index) => found.findIndex((other) => other.lease === entry.lease) === index);
  const block = packer(memoryBudget(collisions.length > 0 ? [...guidance, COLLISION_WARNING] : guidance));
  const warned = collisions.filter((entry) => block.add(collisionLine(entry, paths), `x:${entry.lease}`, `w:${entry.lease}`)).length > 0;
  block.section("Facts:");
  for (const fact of list(recall, "facts")) {
    block.add(factLine(fact), `f:${fact.key}:${fact.state}`);
  }
  block.section("Notes:");
  for (const note of list(recall, "notes").slice(0, MAX_NOTES)) {
    block.add(`- ${str(note.id, 20)}: ${str(note.preview, 160)}`, `n:${note.id}`);
  }
  const collided = new Set(collisions.map((entry) => entry.lease));
  block.section("Teammates working:");
  for (const entry of list(recall, "working_on").filter((entry) => !own(entry) && !collided.has(entry.lease))) {
    block.add(workingLine(entry), `w:${entry.lease}`);
  }
  block.section(null);
  for (const change of list(recall, "since_you_last_read")) {
    block.add(changeLine(change), `c:${change.key}:${JSON.stringify(change.now ?? null)}`);
  }
  return { text: framed(warned ? [...guidance, COLLISION_WARNING] : guidance, block.lines()), shown: block.kept() };
}

/**
 * A later prompt's block: only what this session has not been shown, as team memory inside the frame. First a
 * teammate's lease on the paths this prompt is about, once per lease, even one shown before as plain work; then a fact
 * whose state changed, a fact key never shown (three at most), changes since the person last read a key, and
 * teammates' leases not shown before. Notes never are. Returns null when there is no news.
 */
export function newsBlock(recall, state, paths = [], project = null) {
  const seen = new Set(state.shown);
  const knownKeys = new Set(state.shown.filter((entry) => entry.startsWith("f:")).map((entry) => entry.slice(2, entry.lastIndexOf(":"))));
  const collisions = list(recall, "working_on").filter((entry) => entry.lease !== state.lease && !seen.has(`x:${entry.lease}`) && onPaths(entry, paths, project));
  const guidance = ["KoalaFix update (added by a hook: only what is new since this session's last note):"];
  const block = packer(memoryBudget(collisions.length > 0 ? [...guidance, COLLISION_WARNING] : guidance));
  let warned = false;
  for (const entry of collisions) {
    if (block.add(collisionLine(entry, paths), `x:${entry.lease}`, `w:${entry.lease}`)) {
      seen.add(`w:${entry.lease}`);
      warned = true;
    }
  }
  if (warned) {
    guidance.push(COLLISION_WARNING);
  }
  let newKeys = 0;
  for (const fact of list(recall, "facts")) {
    const signature = `f:${fact.key}:${fact.state}`;
    if (seen.has(signature)) {
      continue;
    }
    if (!knownKeys.has(String(fact.key))) {
      if (newKeys >= MAX_NEW_FACTS) {
        continue;
      }
      newKeys++;
    }
    block.add(factLine(fact), signature);
  }
  for (const change of list(recall, "since_you_last_read")) {
    const signature = `c:${change.key}:${JSON.stringify(change.now ?? null)}`;
    if (!seen.has(signature)) {
      block.add(changeLine(change), signature);
    }
  }
  for (const entry of list(recall, "working_on")) {
    const signature = `w:${entry.lease}`;
    if (entry.lease !== state.lease && !seen.has(signature)) {
      block.add(workingLine(entry), signature);
    }
  }
  return block.count() === 0 ? null : { text: framed(guidance, block.lines()), shown: block.kept() };
}

/** The lease block for a later prompt whose lease had to be started again. */
export function restartedLine(work) {
  return isRecord(work) && typeof work.lease === "string" ? `KoalaFix: the earlier lease ended, so the hook started lease ${work.lease} for this task.` : null;
}

/** What the lease's outcome says when the session ends without the model closing it. */
export const ENDED_OUTCOME = "session ended (closed by the KoalaFix session-end hook)";

/**
 * The reason a Stop hook gives when the server refused the lease: the model can act on it once. It names the
 * project label to use, so the model does not describe the work in the person's own words.
 */
export function backstopReason(error, label) {
  return `KoalaFix could not record this session's work in progress (${error}). Call work(action: "start", what: ${JSON.stringify(label)}) now, then finish.`;
}
