// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The local spool both hooks share. When the server cannot be reached, a hook appends a line describing the call it
// tried to make to <KALIBRATE_HOME or ~/.kalibrate>/spool/<date>.jsonl, tagged with the project folder it came from.
// The next session-start hook that reaches the server of that same project replays the lines that are worth
// replaying (writes) through the real tools and drops the rest; another project's lines stay queued for it. A spool
// line never holds a token: it records the project, the tool name and its arguments, nothing about the connection.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Tools whose spooled calls are replayed. Reads are logged but not replayed; settle and share need a person's yes. */
export const REPLAYABLE_TOOLS = new Set(["remember", "verify", "work"]);

/** The most calls one session-start hook replays, so a long outage cannot eat the hook's budget. */
export const MAX_REPLAY = 50;

/** A call the server answered with an error is dropped after this many tries. */
export const MAX_TRIES = 3;

const STALE_CLAIM_MS = 5 * 60 * 1000;

/** `KALIBRATE_HOME` when set, else `~/.kalibrate`. */
export function kalibrateHome(env = process.env) {
  const home = env.KALIBRATE_HOME;
  return home !== undefined && home !== "" ? home : path.join(os.homedir(), ".kalibrate");
}

export function spoolDir(env = process.env) {
  return path.join(kalibrateHome(env), "spool");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether two project folders are the same one (case-insensitive on Windows, where paths are). */
export function sameProject(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Appends one line to today's spool file and returns the file's path. `project` is the folder that holds the
 * project's `.kalibrate/`, so the call is only ever replayed against that project's server.
 * @param {{ source: string, project?: string, tool: string, arguments: Record<string, unknown>, reason?: string }} call
 */
export function appendSpool(call, env = process.env, now = new Date()) {
  const dir = spoolDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${now.toISOString().slice(0, 10)}.jsonl`);
  const record = {
    v: 1,
    id: randomUUID(),
    at: now.toISOString(),
    source: call.source,
    ...(typeof call.project === "string" ? { project: call.project } : {}),
    tool: call.tool,
    arguments: call.arguments,
    replay: REPLAYABLE_TOOLS.has(call.tool),
    reason: (call.reason ?? "").slice(0, 200),
  };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return file;
}

function parseEntry(line) {
  try {
    const entry = JSON.parse(line);
    if (!isRecord(entry) || typeof entry.tool !== "string" || !isRecord(entry.arguments)) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/** The files to work through, each as { source, base }: today's and older spool files, and abandoned claims. */
function pendingFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).toSorted();
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const source = path.join(dir, name);
    if (name.endsWith(".jsonl")) {
      files.push({ source, base: name });
      continue;
    }
    const claim = /^(.+\.jsonl)\.\d+\.drain$/.exec(name);
    if (claim?.[1] !== undefined) {
      try {
        if (Date.now() - fs.statSync(source).mtimeMs > STALE_CLAIM_MS) {
          files.push({ source, base: claim[1] });
        }
      } catch {
        // gone already
      }
    }
  }
  return files;
}

/**
 * Replays the spool. `send(entry)` makes the call and throws if it fails; an error with `name === "ToolError"`
 * means the server answered with an error (a tool's refusal or a JSON-RPC error, counted against the entry),
 * anything else means the server is unreachable (replay stops and the rest stays queued). With `project` set, only
 * that project's lines are sent: another project's stay queued, and a replayable line with no project is dropped,
 * because no server can be shown to be its own.
 * @param {(entry: Record<string, unknown>) => Promise<unknown>} send
 * @param {{ env?: NodeJS.ProcessEnv, project?: string, maxEntries?: number, shouldStop?: () => boolean }} [options]
 */
export async function drainSpool(send, options = {}) {
  const env = options.env ?? process.env;
  const maxEntries = options.maxEntries ?? MAX_REPLAY;
  const shouldStop = options.shouldStop ?? (() => false);
  const dir = spoolDir(env);
  const result = { replayed: 0, dropped: 0, kept: 0 };
  let attempts = 0;
  let halted = false;
  for (const { source, base } of pendingFiles(dir)) {
    if (halted) {
      break;
    }
    const claimed = path.join(dir, `${base}.${process.pid}.drain`);
    try {
      fs.renameSync(source, claimed);
    } catch {
      continue; // another session took it
    }
    const keep = [];
    for (const line of fs.readFileSync(claimed, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") {
        continue;
      }
      if (halted || attempts >= maxEntries || shouldStop()) {
        halted = true;
        keep.push(line);
        continue;
      }
      const entry = parseEntry(line);
      if (entry === null || entry.replay !== true || !REPLAYABLE_TOOLS.has(entry.tool)) {
        result.dropped++;
        continue;
      }
      if (options.project !== undefined && !sameProject(entry.project, options.project)) {
        if (typeof entry.project === "string") {
          keep.push(line);
        } else {
          result.dropped++;
        }
        continue;
      }
      attempts++;
      try {
        await send(entry);
        result.replayed++;
      } catch (error) {
        if (error instanceof Error && error.name === "ToolError") {
          const tries = (typeof entry.tries === "number" ? entry.tries : 0) + 1;
          if (tries >= MAX_TRIES) {
            result.dropped++;
          } else {
            keep.push(JSON.stringify({ ...entry, tries }));
          }
        } else {
          halted = true;
          keep.push(line);
        }
      }
    }
    if (keep.length > 0) {
      fs.appendFileSync(path.join(dir, base), `${keep.join("\n")}\n`, { mode: 0o600 });
    }
    result.kept += keep.length;
    fs.rmSync(claimed, { force: true });
  }
  return result;
}
