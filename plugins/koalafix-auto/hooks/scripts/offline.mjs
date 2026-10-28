// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The circuit breaker every hook shares. When a request to a server fails because the server is down (the connection
// is refused or reset, the name does not resolve, it answers 5xx, or it does not answer inside the hook's budget), the
// hook records a cool-off for that server's origin in <KALIBRATE_HOME or ~/.kalibrate>/offline.json, beside the
// session state and the spool. Until the cool-off ends, every hook skips the network for that origin at once, so a
// hung server costs one budget, not 1.5 s on every prompt. The first answer after it (any HTTP status below 500)
// clears the record. A server that refuses a token (401) or a call (a tool's refusal) is up: it answered.
// The file holds origins and times only, never a token. Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { kalibrateHome } from "./spool.mjs";

/** How long hooks leave a server alone after it failed: one minute. KALIBRATE_HOOK_COOLOFF_MS overrides; 0 turns it off. */
export const COOL_OFF_MS = 60_000;

/** The one line session start gives the model when the server is down, so it neither waits nor pretends. */
export const OFFLINE_NOTICE = "KoalaFix team memory is offline right now; work without it and don't claim you checked it.";

/** Thrown in place of a request while the server's cool-off runs: the hook skips the network. */
export class ServerOfflineError extends Error {
  /** @param {number} until when the cool-off ends, ms since the epoch */
  constructor(until) {
    super(`the KoalaFix server failed a moment ago; the hooks leave it alone until ${new Date(until).toISOString()}`);
    this.name = "ServerOfflineError";
    this.until = until;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function offlinePath(env = process.env) {
  return path.join(kalibrateHome(env), "offline.json");
}

/** The cool-off in ms: KALIBRATE_HOOK_COOLOFF_MS when it is a whole number of 0 or more, else COOL_OFF_MS. */
export function coolOffMs(env = process.env) {
  const text = env.KALIBRATE_HOOK_COOLOFF_MS ?? "";
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) && value >= 0 ? value : COOL_OFF_MS;
}

/** Every origin's record, `{ [origin]: { until, reason } }`; an unreadable or missing file reads as none. */
function readAll(env) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(offlinePath(env), "utf8"));
  } catch {
    return {};
  }
  const records = {};
  for (const [origin, entry] of Object.entries(isRecord(parsed) ? parsed : {})) {
    if (isRecord(entry) && Number.isFinite(entry.until)) {
      records[origin] = { until: entry.until, reason: typeof entry.reason === "string" ? entry.reason : "" };
    }
  }
  return records;
}

/** Writes the records through a temporary file and a rename, so a hook running beside this one never reads half. */
function writeAll(records, env) {
  const file = offlinePath(env);
  if (Object.keys(records).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(records)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** When the origin's cool-off ends (ms since the epoch), or null when hooks may call it now. */
export function offlineUntil(origin, env = process.env, now = Date.now()) {
  const until = readAll(env)[origin]?.until;
  return until !== undefined && until > now ? until : null;
}

/** Starts (or restarts) the origin's cool-off. Never throws: a breaker that cannot be written only costs speed. */
export function markOffline(origin, reason, env = process.env, now = Date.now()) {
  const ms = coolOffMs(env);
  if (ms === 0) {
    return;
  }
  try {
    const records = Object.fromEntries(Object.entries(readAll(env)).filter(([, entry]) => entry.until > now));
    records[origin] = { until: now + ms, reason: String(reason).slice(0, 200) };
    writeAll(records, env);
  } catch {
    // the next failure tries again
  }
}

/** Clears the origin's record after an answer. Writes only when there was one, so a healthy prompt touches no file. */
export function markOnline(origin, env = process.env) {
  try {
    const records = readAll(env);
    if (origin in records) {
      delete records[origin];
      writeAll(records, env);
    }
  } catch {
    // a record that cannot be cleared ends with its cool-off
  }
}

/** The origin a request goes to, the breaker's key. */
export function originKey(url) {
  return new URL(url).origin;
}

/** Throws ServerOfflineError while the origin's cool-off runs; a hook calls it before any request of its own. */
export function assertOnline(url, env = process.env, now = Date.now()) {
  const until = offlineUntil(originKey(url), env, now);
  if (until !== null) {
    throw new ServerOfflineError(until);
  }
}
