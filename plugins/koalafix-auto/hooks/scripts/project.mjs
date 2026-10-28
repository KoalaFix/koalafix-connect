// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Where a hook goes: the hook JSON Claude Code sends, the trusted project folder (CLAUDE_PROJECT_DIR) and its
// `.kalibrate/config.json`, and how to reach that project's hosted server (`serverUrl` and `.kalibrate/token`). How to
// talk to it is connect.mjs. Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { NoCredentialError, userToken } from "./credentials.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A bearer token only goes over https, or over http to this machine. Same rule as the adapter's config writer. */
export function mcpEndpoint(serverUrl) {
  const url = new URL(serverUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("serverUrl must be https (http is only allowed for localhost)");
  }
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return base.endsWith("/mcp") ? base : `${base}/mcp`;
}

/** The server's base URL, where `/api/v1` sits beside `/mcp`: the MCP endpoint without its `/mcp`. */
export function apiBase(serverUrl) {
  return mcpEndpoint(serverUrl).replace(/\/mcp$/, "");
}

/**
 * What Claude Code sends a hook on stdin. A hook that gets nothing (or nothing valid) still runs, from its own cwd.
 * @param {import("node:stream").Readable & { isTTY?: boolean }} [stream]
 * @param {number} [waitMs]
 */
export async function readHookInput(stream = process.stdin, waitMs = 300) {
  if (stream.isTTY) {
    return {};
  }
  const chunks = [];
  let timer;
  const finished = (async () => {
    try {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    } catch {
      // a broken pipe reads as no input
    }
  })();
  await Promise.race([finished, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The project folder a hook may trust: `CLAUDE_PROJECT_DIR`, which Claude Code sets to the folder it was started in
 * (the folder whose `.claude/settings.json` installed the hooks and whose trust dialog the user accepted). Never the
 * `cwd` from the hook's stdin and never the hook's own working directory: both follow the session into any subfolder,
 * and a subfolder (a cloned repository, a vendored package) can hold a `.kalibrate/` of its own.
 *
 * `fallback` is for the headers helper only: Claude Code runs it in the project folder itself, so its working
 * directory is that folder when `CLAUDE_PROJECT_DIR` is not passed to it. The hooks pass none and refuse instead.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [fallback]
 * @returns {string}
 */
export function trustedRoot(env = process.env, fallback) {
  const dir = env.CLAUDE_PROJECT_DIR;
  if (typeof dir === "string" && dir !== "") {
    return path.resolve(dir);
  }
  if (typeof fallback === "string" && fallback !== "") {
    return path.resolve(fallback);
  }
  throw new Error("CLAUDE_PROJECT_DIR is not set, so the trusted project folder is unknown; the hooks run only from Claude Code");
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/** `O_NOFOLLOW` where the platform has it (not on Windows, where the lstat and realpath checks carry the rule). */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Reads a file that must be a regular file sitting directly in `dir`: not a symbolic link (or junction), and not
 * resolving anywhere else. Returns null when it does not exist; throws with `name` in the message otherwise.
 */
function readInside(dir, name) {
  const file = path.join(dir, name);
  const stat = lstatOrNull(file);
  if (stat === null) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`.kalibrate/${name} is a symbolic link; refusing it (run koalafix init again)`);
  }
  if (!stat.isFile()) {
    throw new Error(`.kalibrate/${name} is not a regular file; refusing it`);
  }
  if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) {
    throw new Error(`.kalibrate/${name} resolves outside the project's .kalibrate folder; refusing it`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`.kalibrate/${name} is not a regular file; refusing it`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** The `.kalibrate` folder of `root`, which must be a real folder there: a symbolic link to one elsewhere is refused. */
function kalibrateDir(root) {
  const dir = path.join(root, ".kalibrate");
  const stat = lstatOrNull(dir);
  if (stat === null) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(".kalibrate in the project folder is a symbolic link or not a folder; refusing it");
  }
  return dir;
}

/**
 * Reads `<root>/.kalibrate/config.json`, where `root` is the trusted project folder (`trustedRoot`). It does not
 * walk up or down: a `.kalibrate/` anywhere else is never read. A config that is a symbolic link is refused.
 */
export function findConfig(root) {
  if (typeof root !== "string" || root === "") {
    throw new Error("no trusted project folder to read .kalibrate/config.json from");
  }
  const resolved = path.resolve(root);
  const dir = kalibrateDir(resolved);
  const text = dir === null ? null : readInside(dir, "config.json");
  if (dir === null || text === null) {
    throw new Error(`no .kalibrate/config.json in the project folder ${resolved}; run koalafix init there`);
  }
  const file = path.join(dir, "config.json");
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!isRecord(config)) {
    throw new Error(`${file} must hold a JSON object`);
  }
  return { root: resolved, dir, file, config };
}

/** The config's `serverUrl`. A config without one is invalid. */
export function serverUrlOf(config) {
  if (typeof config.serverUrl !== "string" || config.serverUrl === "") {
    throw new Error(".kalibrate/config.json has no serverUrl; run koalafix init");
  }
  return config.serverUrl;
}

/**
 * The one-line token in `.kalibrate/token`, or "" when the file is missing, empty or not one line. A token file that
 * is a symbolic link, or that resolves outside the project's `.kalibrate` folder, throws: a repository could commit a
 * link that points at another credential on this machine.
 */
export function readToken(found, env = process.env) {
  const text = found.dir === null ? null : readInside(found.dir, "token");
  const token = text === null ? "" : text.trim();
  if (token !== "" && !/\s/.test(token)) {
    return token;
  }
  // No project token: the person's own credential, only when it was issued for exactly this server (credentials.mjs).
  return typeof found.config.serverUrl === "string" ? userToken(found.config.serverUrl, env) : "";
}

/**
 * A plugin or extension install (`--user`): no project files are read, the server and token come from the person's
 * credential, and `root` only keys the session's state and spool. Returns null when the person has no credential.
 * @param {string} root
 * @param {{ serverUrl: string, token: string } | null} server
 */
export function userFound(root, server) {
  return server === null ? null : { root: path.resolve(root), dir: null, file: null, config: { serverUrl: server.serverUrl }, user: true };
}

/** Whether the project has its own `koalafix init` install: a plugin hook then stands down, so nothing runs twice. */
export function hasProjectInstall(root) {
  return lstatOrNull(path.join(root, ".kalibrate", "config.json")) !== null;
}

/**
 * How to reach the server: `serverUrl` with the bearer token in `.kalibrate/token`, or the person's own credential
 * for exactly that server. The token is never read from the environment here: a cloned repository chooses
 * `serverUrl`, so a token from the user's own environment must not follow it.
 */
export function resolveTarget(found, env = process.env) {
  const serverUrl = serverUrlOf(found.config);
  const token = readToken(found, env);
  if (token === "") {
    throw new NoCredentialError(found.user === true ? "no KoalaFix credential for this server; run koalafix login" : ".kalibrate/token is missing or empty, and koalafix login has no token for this server");
  }
  return { url: mcpEndpoint(serverUrl), api: apiBase(serverUrl), token };
}
