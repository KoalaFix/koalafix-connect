// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The name the hooks give a session's automatic WIP lease, which every teammate sees in "Teammates working". It comes
// from the project alone: the repository's name and branch, or the folder's name outside a repository. Never from
// what the person typed: a prompt is private (a resignation letter, a doctor's visit) and the lease is not.
// Git is read from its files, never by running git, so the label costs a few small reads inside the hook's budget.
// A repository chooses its own branch and remote, and the label reaches teammates' agents, so each part keeps only
// letters, digits and `._/+-`: no spaces, quotes or punctuation to write a sentence or close a quote with.
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "./connect.mjs";
import { KEY_SHAPES } from "./wip.mjs";

/** The longest label a teammate sees, in characters. */
export const LABEL_MAX = 80;

/** How many folders up from the project the hook looks for a `.git`: a project may be a subfolder of its repository. */
const MAX_DEPTH = 40;

function readSmall(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= 256 * 1024 ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/** A network path (`\\host\share`, `//host/share`, `\\?\`, `\\.\`): opening one can send the person's login to a host. */
function isNetworkPath(text) {
  return /^[\\/]{2}/.test(text);
}

/**
 * One part of a label (a repository, branch or folder name): credential shapes taken out, then every character that
 * is not a letter, digit or `._/+-` turned into `-`, runs of `-` made one, at most `max` characters.
 */
export function safePart(text, max = LABEL_MAX) {
  const unkeyed = redact(String(text)).replace(KEY_SHAPES, "redacted");
  const safe = unkeyed
    .replace(/[^\p{L}\p{N}._/+-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  const chars = Array.from(safe);
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : safe;
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The repository holding `root`: its top folder, its git folder (where HEAD is) and its common git folder (where
 * config is; differs from the git folder in a linked worktree). Null when `root` is not inside a repository. The
 * search stops below the home folder, so a dotfiles repository there never names every project under it, and a
 * `.git` file pointing at a network path is refused.
 */
export function findRepository(root, home = os.homedir()) {
  const start = path.resolve(root);
  const ceiling = home === "" ? null : path.resolve(home);
  let dir = start;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (ceiling !== null && samePath(dir, ceiling) && !samePath(start, ceiling)) {
      return null;
    }
    const dotGit = path.join(dir, ".git");
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat !== null && (stat.isDirectory() || stat.isFile())) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(dotGit) ?? "");
        if (pointer === null || isNetworkPath(pointer[1])) {
          return null;
        }
        gitDir = path.resolve(dir, pointer[1]);
      }
      const common = (readSmall(path.join(gitDir, "commondir")) ?? "").trim();
      if (isNetworkPath(common)) {
        return null;
      }
      return { top: dir, gitDir, commonDir: common === "" ? gitDir : path.resolve(gitDir, common) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

/** The branch HEAD names, or null when HEAD is detached or unreadable. */
export function branchOf(gitDir) {
  const match = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(readSmall(path.join(gitDir, "HEAD")) ?? "");
  return match === null ? null : match[1];
}

/** A git config value: a quoted one up to its closing quote, else up to an inline `;` or `#` comment. */
function configValue(raw) {
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  return quoted !== null ? quoted[1] : raw.replace(/\s[;#].*$/, "").trim();
}

/**
 * The repository's name from its `origin` remote (`.../org/name.git` -> `name`), or null when there is none. The
 * query, fragment and anything up to an `@` (a user or a token) are dropped before the last path segment is kept.
 * Section and key names are matched as git matches them, ignoring case.
 */
export function remoteName(commonDir) {
  const config = readSmall(path.join(commonDir, "config"));
  if (config === null) {
    return null;
  }
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (section !== null) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1]);
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line) : null;
    if (url !== null) {
      const bare = configValue(url[1]).replace(/[?#].*$/, "");
      const afterUser = bare.slice(bare.lastIndexOf("@") + 1);
      const name = afterUser.replace(/[\\/]+$/, "").split(/[\\/:]/).at(-1)?.replace(/\.git$/i, "") ?? "";
      return name === "" ? null : name;
    }
  }
  return null;
}

/**
 * The automatic lease's description for a session in `root`: "working in <repo> on <branch>", "working in <repo>"
 * when HEAD is detached, or "working in <folder>" outside a repository.
 */
export function projectLabel(root, home = os.homedir()) {
  const resolved = path.resolve(root);
  const repo = findRepository(resolved, home);
  if (repo === null) {
    return `working in ${safePart(path.basename(resolved), 60) || "a project folder"}`;
  }
  const name = safePart(remoteName(repo.commonDir) ?? path.basename(repo.top), 30) || "a repository";
  const branch = branchOf(repo.gitDir);
  const shown = branch === null ? "" : safePart(branch, LABEL_MAX - "working in  on ".length - name.length);
  return shown === "" ? `working in ${name}` : `working in ${name} on ${shown}`;
}
