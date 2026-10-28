// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The space a folder's decisions go to, for a person in several spaces none of which is named after the project. The
// capture asks them once a session (capture.mjs); this file remembers what they picked, per folder, so no later window
// or session in that folder asks again. The answer is learnt from the session's own transcript: the latest koalafix
// `remember` call, written after the capture asked, whose space is one of the person's spaces. It is kept on this machine only, in
// <KALIBRATE_HOME or ~/.kalibrate>/spaces.json, keyed by a hash of the folder, never on the server.
// Plain ESM, Node 22 APIs only, no dependencies.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { kalibrateHome } from "./spool.mjs";

/** How many folders the file remembers; the oldest pick goes first. */
export const MAX_FOLDERS = 500;

/** The most of a transcript the hook reads for the person's pick: what was written since it asked, up to this. */
export const TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;

/** A space slug as the server makes them. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A koalafix `remember` tool's name in any client: `remember`, `mcp__koalafix__remember`, `koalafix.remember`. */
const REMEMBER = /(?:^|[_.:/])remember$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The file's key for a folder: an opaque hash, so the file names no folder. On Windows the path is taken without a
 * `\\?\` prefix and in lower case, so one folder reached through two clients is one key.
 */
export function folderKey(root, platform = process.platform) {
  const resolved = path.resolve(root);
  const key = platform === "win32" ? resolved.replace(/^\\\\\?\\/, "").toLowerCase() : resolved;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** A transcript's size in bytes now, or 0 when it cannot be read: where the scan for the pick starts. */
export function transcriptSize(transcriptPath) {
  try {
    return typeof transcriptPath === "string" && path.isAbsolute(transcriptPath) ? fs.statSync(transcriptPath).size : 0;
  } catch {
    return 0;
  }
}

function spacesPath(env) {
  return path.join(kalibrateHome(env), "spaces.json");
}

function readFolders(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(spacesPath(env), "utf8"));
    return isRecord(parsed) && isRecord(parsed.folders) ? parsed.folders : {};
  } catch {
    return {};
  }
}

/** The space the person picked for this folder, or null. */
export function pickedSpace(root, env = process.env) {
  const entry = readFolders(env)[folderKey(root)];
  return isRecord(entry) && typeof entry.space === "string" && SLUG.test(entry.space) ? entry.space : null;
}

/** Remembers the person's pick for this folder, through a temporary file and a rename. */
export function rememberPick(root, space, env = process.env, now = Date.now()) {
  if (!SLUG.test(space)) {
    return;
  }
  const folders = { ...readFolders(env), [folderKey(root)]: { space, at: now } };
  const kept = Object.entries(folders)
    .filter(([, entry]) => isRecord(entry) && typeof entry.space === "string")
    .toSorted(([, a], [, b]) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, MAX_FOLDERS);
  const file = spacesPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ folders: Object.fromEntries(kept) })}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The arguments of a tool call node: Claude Code's `input` object, or Codex's `arguments` (a JSON string or object). */
function argumentsOf(node) {
  if (isRecord(node.input)) {
    return node.input;
  }
  if (isRecord(node.arguments)) {
    return node.arguments;
  }
  if (typeof node.arguments === "string") {
    try {
      const parsed = JSON.parse(node.arguments);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The space of the last team `remember` call in one transcript record, among `offered`, or null. */
function pickIn(record, offered, depth = 0) {
  if (depth > 8 || (typeof record !== "object" || record === null)) {
    return null;
  }
  let found = null;
  if (!Array.isArray(record) && typeof record.name === "string" && REMEMBER.test(record.name)) {
    const args = argumentsOf(record);
    if (args !== null && typeof args.space === "string" && offered.includes(args.space) && (args.lane === undefined || args.lane === "team")) {
      found = args.space;
    }
  }
  for (const value of Object.values(record)) {
    found = pickIn(value, offered, depth + 1) ?? found;
  }
  return found;
}

/**
 * The space the person picked after the capture asked: the space of the latest koalafix `remember` call written to the
 * transcript after byte `from` (its size when the capture asked) whose space is one of `offered`, or null. At most the
 * last TRANSCRIPT_READ_BYTES are read. Reads Claude Code's and Codex's JSONL transcripts; a line that is not JSON, or
 * a transcript that cannot be read, gives nothing.
 */
export function pickFromTranscript(transcriptPath, offered, from = 0) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) || offered.length === 0) {
    return null;
  }
  let text;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    // A transcript smaller than when the hook asked is another file: read it all.
    const start = Math.max(from <= size ? from : 0, size - TRANSCRIPT_READ_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  const lines = text.split("\n");
  for (let n = lines.length - 1; n >= 0; n -= 1) {
    if (!lines[n].includes("remember")) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(lines[n]);
    } catch {
      continue;
    }
    const space = pickIn(record, offered);
    if (space !== null) {
      return space;
    }
  }
  return null;
}
