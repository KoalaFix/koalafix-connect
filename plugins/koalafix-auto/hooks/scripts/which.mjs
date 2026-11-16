// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Finds a program on PATH as an absolute path, so a hook never starts one by bare name. On Windows, Node (libuv) looks
// for a bare name in the child's working folder first and only then in PATH, so a `git.exe` committed at the top of a
// cloned repository would run in place of the real git. The search here looks only at absolute PATH entries, skips
// every entry that is, or sits inside, the folder the command will run in, and never looks at the working folder
// itself. Plain ESM, Node built-ins only, no dependencies.

import fs from "node:fs";
import path from "node:path";

/** What execFile can start without a shell, in the order tried: `.cmd` and `.bat` need cmd.exe, so they are not here. */
const WINDOWS_EXTENSIONS = [".exe", ".com"];

/** A Windows path that names its drive (`C:\` or `C:/`) or a network share (`\\host\share`); `\foo` and `C:foo` do not. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|\/\/[^\\/])/;

/** Whether `dir` is `folder` or a folder inside it, compared as paths (without case on Windows). */
function insideOrEqual(dir, folder, platform) {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = flavour.relative(fold(flavour.resolve(folder)), fold(flavour.resolve(dir)));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${flavour.sep}`) && !flavour.isAbsolute(relative));
}

/**
 * The absolute path of `name` on `pathVar`, or null. Pure: the file system is `isFile`.
 * Only absolute PATH entries count; an empty entry, a relative one and `.` are skipped, and so is every entry that is
 * `cwd` or inside it. On win32 the extensions `.exe` then `.com` are tried; elsewhere the bare name is.
 * @param {{ name: string, pathVar: string | undefined, platform: NodeJS.Platform, cwd: string, isFile: (file: string) => boolean }} options
 * @returns {string | null}
 */
export function resolveOnPath({ name, pathVar, platform, cwd, isFile }) {
  const windows = platform === "win32";
  const flavour = windows ? path.win32 : path.posix;
  const extensions = windows ? WINDOWS_EXTENSIONS : [""];
  for (const entry of String(pathVar ?? "").split(windows ? ";" : ":")) {
    const dir = windows ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (dir === "" || dir === "." || !(windows ? WINDOWS_ABSOLUTE.test(dir) : flavour.isAbsolute(dir)) || insideOrEqual(dir, cwd, platform)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = flavour.join(dir, `${name}${extension}`);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Whether `file` is a regular file, and on systems with execute bits one this process may run. */
export function isExecutableFile(file, platform = process.platform, fileSystem = fs) {
  try {
    if (!fileSystem.statSync(file).isFile()) {
      return false;
    }
    if (platform !== "win32") {
      fileSystem.accessSync(file, fileSystem.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** The PATH of `env`: on Windows the variable can be spelled `Path` or `PATH`. */
function pathOf(env, platform) {
  if (platform !== "win32") {
    return env.PATH;
  }
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === "PATH");
  return key === undefined ? undefined : env[key];
}

/** Answers already found in this process, by program, folder and PATH: a hook process lives for a few hundred ms. */
const found = new Map();

/**
 * `name` as an absolute path for a command that will run in `cwd`, or null when it is not on PATH outside `cwd`.
 * Reads the environment and the file system; the answer is kept for the rest of this process.
 * @param {string} name
 * @param {{ cwd: string, env?: Record<string, string | undefined>, platform?: NodeJS.Platform }} options
 * @returns {string | null}
 */
export function whichSync(name, { cwd, env = process.env, platform = process.platform }) {
  const pathVar = pathOf(env, platform);
  const key = JSON.stringify([name, platform, cwd, pathVar ?? null]);
  if (!found.has(key)) {
    found.set(key, resolveOnPath({ name, pathVar, platform, cwd, isFile: (file) => isExecutableFile(file, platform) }));
  }
  return found.get(key) ?? null;
}
