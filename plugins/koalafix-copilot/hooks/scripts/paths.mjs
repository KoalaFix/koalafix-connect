// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The files a prompt is about (ADR-0041, KOA2-381). The prompt hook reports them with the recall it already sends, so
// the server lists a teammate's check-in on one of them first and adds them to this session's own lease, and the hook
// can warn before the agent edits. The paths reach teammates on the lease, so only real files count:
// - paths the person's prompt names that exist under the project, or a new file (no spaces, a file extension) in a
//   folder below the top that exists; a bare name like `sweep.ts` only when it is at the project's top;
// - files the agent edited this session that exist now: Claude Code's own Edit, Write, MultiEdit and NotebookEdit calls
//   and Codex's apply_patch calls, read from the client's transcript's last 256 KB. Only those call records count,
//   never a tool's output, a page the agent fetched or a message, whatever they say.
// Never a file's contents, never a path outside the project, through a symbolic link or on another machine, never the
// prompt's other words, and nothing at all when the project is the home folder or a drive's top. Git is never run: a
// repository's own config can run commands. Nothing here throws; a source it cannot read adds nothing.
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The `_meta` keys, as core's contract has them (packages/core/src/contract/self-reported.ts). */
export const PATHS_META = "kalibrate/paths";
export const LEASE_META = "kalibrate/lease";

/** The most paths one call reports, and the longest one: the server keeps no more (core SELF_REPORTED_LIMITS). */
export const MAX_PATHS = 20;
export const PATH_MAX_CHARS = 300;

/** A lease's short id, as the server checks it; any other value is not sent. */
const LEASE_ID = /^w_[0-9a-f]{4,32}$/;

/** The `_meta` fields for a call about `paths` from a session holding `lease`; each one only when there is one. */
export function pathsMeta(paths, lease) {
  return {
    ...(paths.length === 0 ? {} : { [PATHS_META]: paths.slice(0, MAX_PATHS) }),
    ...(typeof lease === "string" && LEASE_ID.test(lease) ? { [LEASE_META]: lease } : {}),
  };
}

/** How many path-like tokens of one prompt are checked against the disk, so a pasted log costs a few dozen reads. */
export const MAX_CANDIDATES = 40;

/** How much of a prompt is read for paths: a pasted log past this adds nothing but time. */
const MAX_PROMPT_SCAN = 64 * 1024;

/** How much of the transcript's end is read for the files the agent edited. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Claude Code's tools whose calls edit a file, and the input field that names it. */
const EDIT_FIELDS = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** A file header in a Codex apply_patch call's patch text. */
const PATCH_HEADER = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+?)\s*$/gm;

/** What no reported path may hold, as the server refuses it: control characters, `:`, and glob or shell characters. */
const REFUSED = /[\p{Cc}:*?<>|"]/u;

/** A file name's extension, which a new file the prompt names must have. */
const EXTENSION = /\.[\p{L}\p{N}]{1,10}$/u;

/** What can open a path in prose: quotes and brackets. Never a dot: `./src` and `.github` start with one. */
const OPENING = new Set(["`", "'", '"', "(", "[", "{", "<"]);

/** What can close a path in prose: quotes, brackets, and the punctuation a sentence puts after one. */
const CLOSING = new Set(["`", "'", '"', ")", "]", "}", ">", ",", ";", "!", "?", ".", ":"]);

/**
 * File names that say the file holds a secret: environment files, keys, certificates' private halves, credential and
 * package-registry login files. Their contents never leave the machine anyway; their names are not sent either, since
 * teammates see the paths on the lease.
 */
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.json)?|.+\.(?:pem|key|p12|pfx|jks|keystore))$/i;

function secretName(rel) {
  return SECRET_NAME.test(rel.slice(rel.lastIndexOf("/") + 1));
}

/** A network path (`\\host\share`, `//host/share`): reading one can send the person's login to a host. */
function isNetworkPath(text) {
  return /^[\\/]{2}/.test(text);
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether `root` is a project the hook may report paths in: not the home folder, not a drive's or the system's top. */
function reportable(root) {
  const base = path.resolve(root);
  return !samePath(base, path.parse(base).root) && !samePath(base, path.resolve(os.homedir()));
}

function unwrap(token) {
  let start = 0;
  let end = token.length;
  while (start < end && OPENING.has(token[start])) {
    start++;
  }
  while (end > start && CLOSING.has(token[end - 1])) {
    end--;
  }
  return token.slice(start, end);
}

/** A double-quoted or backticked run on one line (a path with spaces in it, as a terminal pastes one), else a word. */
const TOKEN = /"([^"\r\n]{1,300})"|`([^`\r\n]{1,300})`|(\S+)/g;

/** The prompt's raw tokens in order: a quoted run whole and then its words, so a quoted sentence still yields its paths. */
function rawTokens(prompt) {
  const out = [];
  for (const match of String(prompt).slice(0, MAX_PROMPT_SCAN).matchAll(TOKEN)) {
    const quoted = match[1] ?? match[2];
    if (quoted === undefined) {
      out.push(match[3] ?? "");
    } else {
      out.push(quoted, ...(/\s/.test(quoted) ? quoted.split(/\s+/) : []));
    }
  }
  return out;
}

/** The prompt's tokens that look like paths: anything with a slash or backslash, an `@` mention, or a dotted file name. */
export function pathTokens(prompt) {
  const tokens = [];
  for (const raw of rawTokens(prompt)) {
    let token = unwrap(raw.trim()).replace(/^@/, "");
    // `work.ts:42`, `work.ts:42:7` and `work.ts#L42-L50` name the file.
    token = unwrap(token.replace(/(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/, ""));
    if (token === "" || token.length > PATH_MAX_CHARS || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      continue;
    }
    if (/[\\/]/.test(token) || /^[\p{L}\p{N}_.-]+\.[\p{L}\p{N}]{1,10}$/u.test(token)) {
      tokens.push(token);
      if (tokens.length === MAX_CANDIDATES) {
        break;
      }
    }
  }
  return tokens;
}

/** `raw` relative to the project with `/` between folders, or null when it is outside the project or not a path. */
export function relativePath(raw, root) {
  const text = String(raw).trim();
  if (text === "" || text.length > PATH_MAX_CHARS || isNetworkPath(text)) {
    return null;
  }
  const base = path.resolve(root);
  const rel = path.relative(base, path.resolve(base, text.replace(/\\/g, "/")));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  const slashed = rel.split(path.sep).join("/");
  return REFUSED.test(slashed) || slashed.length > PATH_MAX_CHARS ? null : slashed;
}

/**
 * What `rel` is under `base`, read without following a symbolic link at any step (one could point at another machine,
 * and opening it would send the person's login there): "file", "folder", or null when it is missing or a link.
 */
function kindOf(base, rel) {
  let at = base;
  let stat = null;
  for (const part of rel.split("/")) {
    at = path.join(at, part);
    try {
      stat = fs.lstatSync(at);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) {
      return null;
    }
  }
  return stat === null ? null : stat.isDirectory() ? "folder" : "file";
}

/**
 * The paths a prompt names that are under `root`, relative, in the order named: one that exists, or a new file (no
 * spaces, a file extension) in a folder below the top that exists. So "and/or", "e.g." or a quoted sentence that starts
 * with a real folder never count.
 */
export function promptPaths(prompt, root) {
  const base = path.resolve(root);
  const found = [];
  for (const token of pathTokens(prompt)) {
    const rel = relativePath(token, base);
    if (rel === null || found.includes(rel)) {
      continue;
    }
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const newFile = folder !== "" && !/\s/.test(rel) && EXTENSION.test(rel) && kindOf(base, folder) === "folder";
    if (kindOf(base, rel) !== null || newFile) {
      found.push(rel);
    }
  }
  return found;
}

/** The last `bytes` of a regular file as text, or null when it cannot be read. */
function readTail(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return null;
    }
    const start = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

/** The patch text of a Codex apply_patch call: its own input, or the patch an `apply_patch` shell command carries. */
function patchOf(payload) {
  if (payload?.type !== "custom_tool_call" && payload?.type !== "function_call") {
    return null;
  }
  if (payload.name === "apply_patch" && typeof payload.input === "string") {
    return payload.input;
  }
  let args = null;
  try {
    args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : null;
  } catch {
    return null;
  }
  if (payload.name === "apply_patch" && typeof args?.input === "string") {
    return args.input;
  }
  const command = Array.isArray(args?.command) ? args.command : null;
  return command !== null && command[0] === "apply_patch" && typeof command[1] === "string" ? command[1] : null;
}

/** A line worth parsing: one that holds an edit tool's call or an apply_patch. Most lines are neither, so most skip JSON.parse. */
const EDIT_LINE = /"name":\s*"(?:Edit|Write|MultiEdit|NotebookEdit)"|apply_patch/;

/** The files one transcript line's own edit calls name, in order: never text a tool returned or a message held. */
function filesIn(line) {
  if (!EDIT_LINE.test(line)) {
    return [];
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    // The tail's first line is usually cut short, and a client may write lines that are not JSON.
    return [];
  }
  const files = [];
  const content = record?.type === "assistant" ? record.message?.content : undefined;
  for (const part of Array.isArray(content) ? content : []) {
    const field = part?.type === "tool_use" ? EDIT_FIELDS[part.name] : undefined;
    const file = field === undefined ? undefined : part.input?.[field];
    if (typeof file === "string") {
      files.push(file);
    }
  }
  const patch = patchOf(record?.payload);
  for (const match of patch === null ? [] : patch.matchAll(PATCH_HEADER)) {
    files.push(match[1]);
  }
  return files;
}

/** The files the client's transcript shows the agent edited this session, relative to `root`, newest first. */
export function editedPaths(transcriptPath, root) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) || isNetworkPath(transcriptPath)) {
    return [];
  }
  const text = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (text === null) {
    return [];
  }
  const base = path.resolve(root);
  const found = [];
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0 && found.length < MAX_PATHS; index--) {
    for (const file of filesIn(lines[index]).toReversed()) {
      const rel = relativePath(file, base);
      if (rel !== null && !found.includes(rel) && found.length < MAX_PATHS && kindOf(base, rel) !== null) {
        found.push(rel);
      }
    }
  }
  return found;
}

/** What the prompt hook reports: the prompt's paths first, then the files the session edited, deduped, at most 20. */
export function sessionPaths({ prompt, transcriptPath, root }) {
  if (!reportable(root)) {
    return [];
  }
  const all = [...promptPaths(prompt, root), ...editedPaths(transcriptPath, root)].filter((rel) => !secretName(rel));
  return [...new Set(all)].slice(0, MAX_PATHS);
}

/** A path as the stores compare it (core's normalisePath): `/` only, no `./` in front, no `/` behind. */
function normalised(text) {
  let out = String(text).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) {
    out = out.slice(2);
  }
  out = out.replace(/\/+$/, "");
  return out === "." ? "" : out;
}

/** Whether a lease path is the whole tree (`.`, `./`, empty): it overlaps everything, so it says nothing about a file. */
export function isWholeTree(text) {
  return normalised(text) === "";
}

/** Core's overlap rule (pathsOverlap): the same path, one inside the other on a folder boundary, or the whole tree. */
export function overlaps(a, b) {
  const left = normalised(a);
  const right = normalised(b);
  if (left === "" || right === "") {
    return true;
  }
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
