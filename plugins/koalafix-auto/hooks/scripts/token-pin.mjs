// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// A project's token is pinned to the server it was issued for. `koalafix init` writes `.kalibrate/token` and records
// the origin of the server it used in <KALIBRATE_HOME or ~/.kalibrate>/project-pins.json, outside the repository:
//   { "<sha256 of the project's real path>": { "origin": "https://host[:port]", "pinnedAt": "<ISO time>" } }
// `.kalibrate/config.json` is ignored by git but a commit can still force-add one, and a pull then replaces the local
// file while the local token stays. Before a hook sends the project token it compares the config's server with the
// pin: a different origin gets no token and no request. A project with no pin (an install from before pins, or a
// pin file that cannot be read) is pinned to its current server on first use. The CLI keeps a TypeScript twin of the
// writer (packages/cli/src/project-pin.ts); the two must agree on the file, the key and the entry.
// Plain ESM, Node built-ins only, no dependencies. Every function takes the file system it uses, so tests pass a fake.

import { createHash, randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";

/**
 * The file system calls the pins use: node:fs, or a fake in a test.
 * @typedef {{ readFileSync(file: string, encoding: "utf8"): string, writeFileSync(file: string, text: string, options: { mode: number }): void, renameSync(from: string, to: string): void, mkdirSync(dir: string, options: { recursive: true, mode: number }): unknown, realpathSync(file: string): string }} PinFs
 */

/** The pin file's name in the KoalaFix home. */
export const PINS_FILE = "project-pins.json";

/** The one line the person sees when a project's server address no longer matches its token's. */
export const PIN_NOTICE = "KoalaFix: this folder's server address changed since its token was issued, so the token was not sent. If you changed it yourself, run koalafix init again.";

/** The project's server is not the one its token was issued for: the token is not sent and the server not called. */
export class TokenPinError extends Error {
  constructor() {
    super(PIN_NOTICE);
    this.name = "TokenPinError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pinsPath(home) {
  return path.join(home, PINS_FILE);
}

/** The origin of an http(s) URL (`https://host[:port]`), or null for anything else. */
export function pinOrigin(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The pin key of a project folder: sha256 hex of its real path, lower-cased on Windows (where paths are case-blind).
 * A folder whose real path cannot be read is keyed by its resolved path.
 * @param {string} root
 * @param {Pick<PinFs, "realpathSync">} [fsys]
 * @param {string} [platform]
 * @returns {string}
 */
export function projectKey(root, fsys = nodeFs, platform = process.platform) {
  let real;
  try {
    real = fsys.realpathSync(root);
  } catch {
    real = path.resolve(root);
  }
  return createHash("sha256").update(platform === "win32" ? real.toLowerCase() : real, "utf8").digest("hex");
}

/**
 * Every valid pin, `{ [key]: { origin, pinnedAt } }`. A missing, unreadable or unparsable file reads as no pins.
 * @param {string} file
 * @param {Pick<PinFs, "readFileSync">} [fsys]
 * @returns {Record<string, { origin: string, pinnedAt: string }>}
 */
export function readPins(file, fsys = nodeFs) {
  let parsed;
  try {
    parsed = JSON.parse(fsys.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const pins = {};
  for (const [key, entry] of Object.entries(isRecord(parsed) ? parsed : {})) {
    if (/^[0-9a-f]{64}$/.test(key) && isRecord(entry) && typeof entry.origin === "string" && pinOrigin(entry.origin) === entry.origin) {
      pins[key] = { origin: entry.origin, pinnedAt: typeof entry.pinnedAt === "string" ? entry.pinnedAt : "" };
    }
  }
  return pins;
}

/**
 * Pins the project `key` to `origin`, replacing any earlier pin, through a temporary file in the same folder and a
 * rename, so a hook running beside this one never reads half a file. Returns false instead of throwing.
 * @param {string} file
 * @param {string} key
 * @param {string} origin
 * @param {PinFs} [fsys]
 * @param {Date} [now]
 * @returns {boolean}
 */
export function writePin(file, key, origin, fsys = nodeFs, now = new Date()) {
  try {
    const pins = readPins(file, fsys);
    pins[key] = { origin, pinnedAt: now.toISOString() };
    fsys.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fsys.writeFileSync(temp, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
    fsys.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compares the project's server with its pin. "match": the same origin. "pinned": there was no pin, so one was
 * written now from the current server (trust on first use; also "pinned" when that write failed, so a read-only home
 * never stops the hooks). "changed": another origin is pinned, so the token must not be sent. Never throws.
 * @param {{ home: string, root: string, serverUrl: string, fsys?: PinFs, platform?: string, now?: Date }} options
 * @returns {"match" | "pinned" | "changed"}
 */
export function checkPin({ home, root, serverUrl, fsys = nodeFs, platform = process.platform, now = new Date() }) {
  const origin = pinOrigin(serverUrl);
  const file = pinsPath(home);
  const key = projectKey(root, fsys, platform);
  const pinned = readPins(file, fsys)[key];
  if (pinned === undefined) {
    if (origin !== null) {
      writePin(file, key, origin, fsys, now);
    }
    return "pinned";
  }
  return pinned.origin === origin ? "match" : "changed";
}

/**
 * Throws TokenPinError when the project's server is not the origin its token is pinned to; pins it when unpinned.
 * @param {{ home: string, root: string, serverUrl: string, fsys?: PinFs, platform?: string, now?: Date }} options
 */
export function assertPinned(options) {
  if (checkPin(options) === "changed") {
    throw new TokenPinError();
  }
}
