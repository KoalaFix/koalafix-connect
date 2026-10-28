// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The repo and model a hook reports with each call it makes, in `_meta` next to the unlogged flag (ADR-0033,
// KOA2-149). The server stores both as self-reported and uses neither for who the person is or what they may do.
// - Repo: the `origin` remote's repository name (`.../team/widget.git` -> `widget`), else the project folder's name.
//   Never the URL, a user or token in it, an absolute path or the branch. Read from git's files (label.mjs).
// - Model: only what the client says, never guessed from an environment variable. Codex puts `model` in every hook
//   input. Claude Code names it at session start only, so session start keeps it beside the session's state, and the
//   Stop hook replaces it with the model of the transcript's latest answer, so a `/model` switch is reported from the
//   next turn on.
// A value that does not fit the server's shape is left out rather than sent to be dropped. Nothing here throws: a
// file that cannot be read or written only means a field is not reported.
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRepository, remoteName, safePart } from "./label.mjs";
import { statePath } from "./wip.mjs";

/** The `_meta` keys and limits, as core's contract has them (packages/core/src/contract/self-reported.ts). */
export const REPO_META = "kalibrate/repo";
export const MODEL_META = "kalibrate/model";
export const REPO_MAX = 80;
export const MODEL_MAX = 120;
export const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/+:@-]*$/;

/** How much of the transcript's end the Stop hook reads for the latest answer's model. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** The repository's name, else the folder's, as letters, digits and `._+-`; null when nothing is left. */
export function reportedRepo(root, home = os.homedir()) {
  const resolved = path.resolve(root);
  const repo = findRepository(resolved, home);
  const names = repo === null ? [path.basename(resolved)] : [remoteName(repo.commonDir), path.basename(repo.top)];
  for (const name of names) {
    // safePart keeps `/` for branch names; in a repo or folder name it becomes `-` like any other character.
    const safe = name === null ? "" : safePart(name, REPO_MAX).replaceAll("/", "-");
    if (safe !== "") {
      return safe;
    }
  }
  return null;
}

function shapedModel(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const model = raw.trim();
  return model.length <= MODEL_MAX && MODEL_SHAPE.test(model) ? model : null;
}

/** The model the hook input names (`model`, or `model.id`), when it has the server's shape; else null. */
export function modelOf(input) {
  return shapedModel(typeof input?.model === "string" ? input.model : input?.model?.id);
}

/**
 * The model of the latest answer in a Claude Code JSONL transcript (`{"type":"assistant","message":{"model":...}}`),
 * reading at most its last TRANSCRIPT_TAIL_BYTES; null when there is none. A synthetic answer's `<synthetic>` fails
 * the shape and is passed over.
 */
export function transcriptModel(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  let text;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
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
    if (!lines[n].includes('"assistant"')) {
      continue;
    }
    try {
      const record = JSON.parse(lines[n]);
      const model = record?.type === "assistant" ? shapedModel(record.message?.model) : null;
      if (model !== null) {
        return model;
      }
    } catch {
      // a cut first line or a line that is not JSON
    }
  }
  return null;
}

function modelPath(key, env) {
  return statePath(key, env).replace(/\.json$/, ".model");
}

/** Keeps the model for the session's later hooks, through a temporary file and a rename. */
export function keepModel(key, model, env = process.env) {
  if (model === null) {
    return;
  }
  try {
    const file = modelPath(key, env);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${model}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // the hooks still send the repo
  }
}

/** The model kept for this session, or null. */
export function keptModel(key, env = process.env) {
  try {
    return shapedModel(fs.readFileSync(modelPath(key, env), "utf8"));
  } catch {
    return null;
  }
}

/** Drops the session's kept model; a file that cannot be removed is left for the next session end. */
export function forgetModel(key, env = process.env) {
  try {
    fs.rmSync(modelPath(key, env), { force: true });
  } catch {
    // never worth losing a lease close over
  }
}

/** The `_meta` fields for a call from this project and session: the repo always, the model when known. */
export function provenanceMeta(root, input, key, env = process.env) {
  try {
    const repo = reportedRepo(root);
    const model = modelOf(input) ?? (key === null ? null : keptModel(key, env));
    return { ...(repo === null ? {} : { [REPO_META]: repo }), ...(model === null ? {} : { [MODEL_META]: model }) };
  } catch {
    return {};
  }
}
