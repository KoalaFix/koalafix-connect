// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// What the prompt and session-end hooks decide, kept apart from the scripts so it can be tested without running one.
// The hook, not the model, starts the session's WIP lease and puts team memory in front of the first real prompt;
// after that it adds only what this session has not been shown (a fact in a new state, a new fact key, a change since
// the person last read it, a teammate's lease). Notes are shown once, on the first prompt, never as news. The inputs
// are the real tools' shapes: `RecallResult` and `WorkResult` (packages/core/src/contract/tools-io.ts).
// Plain ESM, Node 22 APIs only, no dependencies.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./connect.mjs";
import { kalibrateHome } from "./spool.mjs";

/** The most characters one injected block may hold: about 400 tokens. */
export const MAX_BLOCK_CHARS = 1500;

/** How many new fact keys one later prompt may add. */
export const MAX_NEW_FACTS = 3;

/** How many notes the first block shows. */
export const MAX_NOTES = 3;

/** The lease description: the prompt's first line, this long at most. */
export const WHAT_MAX = 80;

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

/**
 * The lease's description: the prompt's first non-empty line, with anything shaped like a credential taken out, at
 * most 80 characters. Teammates see it, so it is kept short.
 */
export function whatOf(prompt) {
  const line = String(prompt).split(/\r?\n/).find((part) => part.trim() !== "") ?? "";
  const clean = redact(line).replace(/[A-Za-z0-9_+/=-]{32,}/g, "<redacted>");
  return str(clean, WHAT_MAX);
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
      what: typeof parsed.what === "string" ? parsed.what : null,
      nudged: parsed.nudged === true,
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

/** Adds lines while they fit, recording each one's signature only when it is kept. */
function packer(header) {
  const lines = [header];
  const kept = [];
  let size = header.length;
  return {
    add(line, signature) {
      if (size + 1 + line.length > MAX_BLOCK_CHARS) {
        return false;
      }
      lines.push(line);
      size += 1 + line.length;
      if (signature !== undefined) {
        kept.push(signature);
      }
      return true;
    },
    text: () => lines.join("\n"),
    kept: () => kept,
    count: () => lines.length - 1,
  };
}

function verdictHeader(recall) {
  const verdict = isRecord(recall) && typeof recall.verdict === "string" ? recall.verdict.toUpperCase() : "UNKNOWN";
  const instruction = isRecord(recall) ? str(recall.instruction, 220) : "";
  return `KoalaFix team memory for this task (added by a hook, not by you): ${verdict}.${instruction === "" ? "" : ` ${instruction}`}`;
}

/**
 * The first prompt's block: the verdict and its instruction, the lease the hook started, overlapping work, then
 * facts, notes and teammates' work, cut to 1,500 characters. `work` is null when the lease could not be started.
 * Returns the text and the signatures of everything it shows.
 */
export function firstBlock(recall, work, ownLease = null) {
  const block = packer(verdictHeader(recall));
  const lease = isRecord(work) && typeof work.lease === "string" ? work.lease : null;
  if (lease !== null) {
    const ends = typeof work.expires_at === "string" ? `, until ${work.expires_at}` : "";
    block.add(`WIP: the hook started lease ${lease} for this task${ends}; the session-end hook closes it. If you finish sooner, work(done, lease: "${lease}") with the outcome.`);
  }
  for (const overlap of list(work, "overlaps")) {
    block.add(`Overlap: ${workingLine(overlap).slice(2)}`, `w:${overlap.lease}`);
  }
  const facts = list(recall, "facts");
  if (facts.length > 0) {
    block.add("Facts:");
    for (const fact of facts) {
      block.add(factLine(fact), `f:${fact.key}:${fact.state}`);
    }
  }
  const notes = list(recall, "notes").slice(0, MAX_NOTES);
  if (notes.length > 0) {
    block.add("Notes:");
    for (const note of notes) {
      block.add(`- ${str(note.id, 20)}: ${str(note.preview, 160)}`, `n:${note.id}`);
    }
  }
  const working = list(recall, "working_on").filter((entry) => entry.lease !== lease && entry.lease !== ownLease);
  if (working.length > 0) {
    block.add("Teammates working:");
    for (const entry of working) {
      block.add(workingLine(entry), `w:${entry.lease}`);
    }
  }
  for (const change of list(recall, "since_you_last_read")) {
    block.add(changeLine(change), `c:${change.key}:${JSON.stringify(change.now ?? null)}`);
  }
  return { text: block.text(), shown: block.kept() };
}

/**
 * A later prompt's block: only what this session has not been shown. A fact whose key is known but whose state
 * changed is news; a fact key never shown is news (three at most); so are changes since the person last read a key
 * and teammates' leases not shown before. Notes never are. Returns null when there is no news.
 */
export function newsBlock(recall, state) {
  const seen = new Set(state.shown);
  const knownKeys = new Set(state.shown.filter((entry) => entry.startsWith("f:")).map((entry) => entry.slice(2, entry.lastIndexOf(":"))));
  const block = packer("KoalaFix update (added by a hook: only what is new since this session's last note):");
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
  return block.count() === 0 ? null : { text: block.text(), shown: block.kept() };
}

/** The lease block for a later prompt whose lease had to be started again. */
export function restartedLine(work) {
  return isRecord(work) && typeof work.lease === "string" ? `KoalaFix: the earlier lease ended, so the hook started lease ${work.lease} for this task.` : null;
}

/** What the lease's outcome says when the session ends without the model closing it. */
export const ENDED_OUTCOME = "session ended (closed by the KoalaFix session-end hook)";

/** The lease description the Stop backstop uses when the session's first prompt left none. */
export const CONTINUED_WHAT = "work continued in this session";

/** The reason a Stop hook gives when the server refused the lease: the model can act on it once. */
export function backstopReason(error) {
  return `KoalaFix could not record this session's work in progress (${error}). Call work(action: "start", what: <one line on what you are doing>) now, then finish.`;
}
