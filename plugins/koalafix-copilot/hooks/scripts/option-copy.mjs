// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Moves a plugin install's stored sign-in into the koalafix-auto plugin's own option, once (release one of two).
//
// The Claude directory asks a plugin to take its credential through a `userConfig` option marked sensitive, not from a
// file on the machine. koalafix-auto 0.5.12 declares that option (`koalafix_token`). This step fills it for someone who
// already signed in through the browser (credentials.json), so they never sign in again: at session start, when the
// option is empty and the hooks connected with the stored sign-in, it runs Claude Code's own
// `claude plugin configure <plugin>@<marketplace> --values-stdin` with the token on stdin (never on the command line),
// and the person sees one line asking them to restart Claude Code once. The headers helper keeps reading
// credentials.json in this release, so nothing stops working if the step cannot run; it tries again a day later.
//
// Which `claude` it runs: only fixed install places in the person's home folder (the native installer's
// ~/.local/bin, the Claude desktop app's bundled copy) and Homebrew's on macOS. Never PATH or an environment variable:
// a cloned project can set environment variables for its sessions, and the program run here is handed the token.
// Plain ESM, Node 22 APIs only, no dependencies.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { optionOrigin, optionToken, originOf } from "./credentials.mjs";
import { kalibrateHome } from "./spool.mjs";

/** The option's key in koalafix-auto's plugin.json `userConfig`. */
export const OPTION_KEY = "koalafix_token";

/** What the person sees once the sign-in is in the option. */
export const RESTART_LINE =
  "KoalaFix moved your sign-in into the plugin's own settings, where Claude Code keeps it as a secret. Restart Claude Code once to finish; nothing else to do.";

/** How long after an attempt the next one waits, so a session start never runs `claude` every time. */
export const RETRY_MS = 24 * 60 * 60 * 1000;

/** Under this much budget left, the step does not start: `claude` takes a second or two to start. */
const MIN_BUDGET_MS = 2500;

const NAME = /^[A-Za-z0-9._-]+$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markerPath(env) {
  return path.join(kalibrateHome(env), "option-copy.json");
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The plugin id (`<plugin>@<marketplace>`) Claude Code knows an installed plugin by, from its root
 * (`.../plugins/cache/<marketplace>/<plugin>/<version>`), or null for anything else (a `--plugin-dir` folder).
 * @param {unknown} root CLAUDE_PLUGIN_ROOT
 */
export function pluginIdOf(root) {
  if (typeof root !== "string" || root === "") {
    return null;
  }
  const parts = path.resolve(root).split(/[\\/]+/);
  for (let index = parts.length - 4; index >= 1; index--) {
    if (parts[index] === "cache" && parts[index - 1] === "plugins") {
      const [marketplace, plugin] = [parts[index + 1], parts[index + 2]];
      return NAME.test(marketplace) && NAME.test(plugin) ? `${plugin}@${marketplace}` : null;
    }
  }
  return null;
}

/** Whether the plugin at `root` declares the sensitive option this step fills. */
export function declaresOption(root) {
  const manifest = readJson(path.join(root, ".claude-plugin", "plugin.json"));
  const option = isRecord(manifest?.userConfig) ? manifest.userConfig[OPTION_KEY] : undefined;
  return isRecord(option) && option.sensitive === true;
}

/** Version folder names, newest first (2.1.321 before 2.1.317 before 2.1.99). */
function newestFirst(names) {
  const parts = (name) => name.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return names.toSorted((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let index = 0; index < Math.max(x.length, y.length); index++) {
      if ((x[index] ?? 0) !== (y[index] ?? 0)) {
        return (y[index] ?? 0) - (x[index] ?? 0);
      }
    }
    return 0;
  });
}

/** The Claude desktop app's bundled Claude Code binaries under `base`, newest version first. */
function desktopBinaries(base, exe) {
  let versions = [];
  try {
    versions = fs.readdirSync(base).filter((name) => /^\d+(\.\d+)*$/.test(name));
  } catch {
    return [];
  }
  const found = [];
  for (const version of newestFirst(versions)) {
    const dir = path.join(base, version);
    found.push(path.join(dir, exe));
    try {
      for (const sub of fs.readdirSync(dir)) {
        found.push(path.join(dir, sub, exe));
      }
    } catch {
      // an unreadable version folder has nothing to offer
    }
  }
  return found;
}

/**
 * The Claude Code binaries this step may run, in the order it tries them: the newest desktop app copy, the native
 * installer's, then Homebrew's on macOS. Only existing files.
 * @param {string} [home]
 * @param {string} [platform]
 */
export function claudeCandidates(home = os.homedir(), platform = process.platform) {
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const list = [];
  if (platform === "win32") {
    list.push(...desktopBinaries(path.join(home, "AppData", "Roaming", "Claude", "claude-code"), exe));
  } else if (platform === "darwin") {
    list.push(...desktopBinaries(path.join(home, "Library", "Application Support", "Claude", "claude-code"), exe));
  }
  list.push(path.join(home, ".local", "bin", exe));
  if (platform === "darwin") {
    list.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  }
  return list.filter(isFile);
}

/**
 * Copies the stored sign-in into the plugin option when it should, and says what happened. Never throws, never
 * prints, and never puts the token anywhere but the child's stdin.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   client: string,
 *   located: { found: { user?: boolean }, target: { url: string, token: string } } | null,
 *   deadlineAt: number,
 *   home?: string,
 *   platform?: string,
 *   now?: number,
 *   run?: typeof spawnSync,
 * }} options
 * @returns {{ copied: boolean, reason: string }}
 */
export function copyIntoOption({ env = process.env, client, located, deadlineAt, home = os.homedir(), platform = process.platform, now = Date.now(), run = spawnSync }) {
  if (client !== "claude-code" || located === null || located.found.user !== true) {
    return { copied: false, reason: "not a Claude Code plugin install" };
  }
  if (optionToken(env) !== "") {
    return { copied: false, reason: "the option is set" };
  }
  if (originOf(located.target.url) !== optionOrigin(env) || located.target.token === "") {
    return { copied: false, reason: "the stored sign-in is for another server" };
  }
  const root = env.CLAUDE_PLUGIN_ROOT;
  const pluginId = pluginIdOf(root);
  if (pluginId === null || typeof root !== "string" || !declaresOption(root)) {
    return { copied: false, reason: "this plugin has no such option" };
  }
  const marker = readJson(markerPath(env));
  const last = typeof marker?.at === "string" ? Date.parse(marker.at) : Number.NaN;
  if (marker?.pluginId === pluginId && Number.isFinite(last) && now - last < RETRY_MS) {
    return { copied: false, reason: "tried within the last day" };
  }
  const left = deadlineAt - Date.now();
  if (left < MIN_BUDGET_MS) {
    return { copied: false, reason: "not enough time left in this session start" };
  }
  const binaries = claudeCandidates(home, platform).slice(0, 2);
  if (binaries.length === 0) {
    return { copied: false, reason: "no Claude Code program found in its usual places" };
  }
  let copied = false;
  let reason = "claude plugin configure did not save it";
  for (const binary of binaries) {
    const timeout = Math.max(1000, deadlineAt - Date.now() - 300);
    const result = run(binary, ["plugin", "configure", pluginId, "--values-stdin", "--json"], {
      input: JSON.stringify({ [OPTION_KEY]: located.target.token }),
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env,
    });
    if (result.error !== undefined || result.status !== 0) {
      reason = result.error !== undefined ? "claude could not be started" : `claude plugin configure exited ${String(result.status)}`;
      continue;
    }
    let saved = [];
    try {
      const parsed = JSON.parse(String(result.stdout));
      saved = isRecord(parsed) && Array.isArray(parsed.saved) ? parsed.saved : [];
    } catch {
      saved = [];
    }
    if (saved.includes(OPTION_KEY)) {
      copied = true;
      reason = "saved";
      break;
    }
  }
  try {
    fs.mkdirSync(path.dirname(markerPath(env)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath(env), `${JSON.stringify({ pluginId, at: new Date(now).toISOString(), copied })}\n`, { mode: 0o600 });
  } catch {
    // without the marker the step runs again next session, which is harmless
  }
  return { copied, reason };
}
