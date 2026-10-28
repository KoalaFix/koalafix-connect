// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The two optional flags that let other clients run the same hook scripts: `--client <id>` picks the shape of what a
// hook prints and the name it gives the server, and `--project <absolute dir>` names the trusted project root for a
// client that has no CLAUDE_PROJECT_DIR. With no flags a hook behaves exactly as it does under Claude Code.
// Plain ESM, Node 22 APIs only, no dependencies.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NoCredentialError, userServer } from "./credentials.mjs";
import { findConfig, hasProjectInstall, resolveTarget, trustedRoot, userFound } from "./project.mjs";

/** The clients a hook can speak for. `claude-code` is the default. */
export const CLIENTS = ["claude-code", "codex", "cursor", "gemini-cli", "opencode"];

/**
 * Clients whose hooks must answer with one JSON object on stdout whenever they exit 0: Cursor (its stop hook),
 * Codex (`Stop` "expects JSON on stdout"), Gemini CLI ("stdout is parsed as JSON"; plain text breaks it). For them a
 * hook with nothing to say prints `{}`, which every one of them reads as "no change".
 */
const JSON_CLIENTS = new Set(["codex", "cursor", "gemini-cli"]);

/** The name each client's hook gives the server (`clientInfo.name`, and the User-Agent over HTTP). */
const CLIENT_NAMES = {
  "claude-code": "kalibrate-claude-code-hook",
  codex: "kalibrate-codex-hook",
  cursor: "kalibrate-cursor-hook",
  "gemini-cli": "kalibrate-gemini-cli-hook",
  opencode: "kalibrate-opencode-hook",
};

const HOOK_VERSION = "0.2.0";

/** A value from the command line, cut short and on one line, so a refusal never echoes much of what it was given. */
function shown(value) {
  const flat = String(value).replace(/\s+/g, " ");
  return JSON.stringify(flat.length > 60 ? `${flat.slice(0, 57)}...` : flat);
}

/**
 * Whether `dir` is an absolute path. On Windows it also needs a drive (`C:\` or `C:/`) or a UNC share
 * (`\\server\share`): a bare `\dir` means "the root of whatever drive the hook happens to run on".
 */
export function isAbsoluteProject(dir, platform = process.platform) {
  if (platform === "win32") {
    return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(dir);
  }
  return path.posix.isAbsolute(dir);
}

/**
 * Reads `--client <id>` and `--project <dir>` (or `--flag=value`) from a hook's argv (`process.argv.slice(2)`).
 * Never throws. Returns `{ client, project, error }`: `client` is the client to print for (`claude-code` when the
 * flag is absent, null when the value is not a known client), `project` the absolute root or null, and `error` null
 * or the reason the hook must skip. An unknown flag, a repeated flag, a missing value and a relative project are
 * all refused rather than guessed at.
 * @param {readonly string[]} argv
 * @param {string} [platform]
 */
export function parseHookArgs(argv, platform = process.platform) {
  const given = {};
  let error = null;
  let user = false;
  for (let index = 0; index < argv.length && error === null; index++) {
    const arg = String(argv[index]);
    if (arg === "--user") {
      user = true;
      continue;
    }
    const match = /^--(client|project)(?:=(.*))?$/s.exec(arg);
    if (match === null) {
      error = `unknown argument ${shown(arg)} (the hooks take --client, --project and --user)`;
      break;
    }
    const name = match[1];
    let value = match[2];
    if (value === undefined) {
      value = argv[index + 1];
      index++;
    }
    if (typeof value !== "string" || value === "" || (match[2] === undefined && value.startsWith("--"))) {
      error = `--${name} needs a value`;
    } else if (given[name] !== undefined) {
      error = `--${name} was given more than once`;
    } else {
      given[name] = value;
    }
  }
  let client = "claude-code";
  if (given.client !== undefined) {
    client = CLIENTS.includes(given.client) ? given.client : null;
    if (client === null && error === null) {
      error = `unknown --client ${shown(given.client)} (expected ${CLIENTS.join(", ")})`;
    }
  }
  let project = null;
  if (given.project !== undefined) {
    if (isAbsoluteProject(given.project, platform)) {
      project = platform === "win32" ? path.win32.resolve(given.project) : path.posix.resolve(given.project);
    } else if (error === null) {
      error = `--project must be an absolute path, not ${shown(given.project)}`;
    }
  }
  if (user && project !== null && error === null) {
    error = "--user and --project do not go together: --user reads no project files";
  }
  return { client, project, error, user };
}

/**
 * The project root a hook trusts: `--project` when it was given (it replaces CLAUDE_PROJECT_DIR), else
 * `trustedRoot(env)`. Never the `cwd` in the hook's stdin and never the hook's own working directory.
 * @param {{ project: string | null }} args
 * @param {Record<string, string | undefined>} [env]
 */
export function hookRoot(args, env = process.env) {
  return args.project !== null ? args.project : trustedRoot(env);
}

/**
 * Whether a sign-in link could be opened where this hook runs. Conservative: Windows and macOS always can; elsewhere
 * only with a display (`DISPLAY`, `WAYLAND_DISPLAY`) or a `BROWSER` set. Never in a Claude Code cloud session, whose
 * VM sets `CLAUDE_CODE_REMOTE=true` (code.claude.com/docs/en/cloud-environments, "Install dependencies with a
 * SessionStart hook"). Cloud Cowork's Linux container has no display, so it counts as no browser too.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 */
export function canShowBrowser(env = process.env, platform = process.platform) {
  if (env.CLAUDE_CODE_REMOTE === "true") {
    return false;
  }
  if (platform === "win32" || platform === "darwin") {
    return true;
  }
  return ["DISPLAY", "WAYLAND_DISPLAY", "BROWSER"].some((name) => typeof env[name] === "string" && env[name] !== "");
}

/**
 * Where a hook finds its server, or null when it should do nothing at all.
 * - A project install (`koalafix init`, the default): the trusted project's `.kalibrate/config.json`, as before.
 * - A plugin or extension install (`--user`): no project file is read. The server and token are the person's own
 *   (`koalafix login`, or the hooks' browser sign-in), and the folder the client reports only keys the session's state
 *   and spool. When that folder has its own `koalafix init` install, the plugin hook stands down (null), so the
 *   project's hooks run alone.
 * With no credential and no way to show a browser (`canShowBrowser`), null: the hook exits at once and silently, with
 * no sign-in and no network. With a browser, a plugin install throws NoCredentialError (the hook may sign in,
 * device.mjs) and a project install throws a plain error the hook reports on stderr.
 * Throws when a project install is broken (no config, no serverUrl, a refused link): the hook reports it on stderr.
 * @param {{ client: string, project: string | null, user?: boolean }} args
 * @param {Record<string, unknown>} [input] the hook's stdin
 * @param {string} [platform]
 */
export function locateHook(args, env = process.env, input = {}, platform = process.platform) {
  try {
    return locate(args, env, input);
  } catch (error) {
    if (!(error instanceof NoCredentialError)) {
      throw error;
    }
    if (!canShowBrowser(env, platform)) {
      return null;
    }
    throw args.user === true ? error : new Error(error.message);
  }
}

function locate(args, env, input) {
  if (args.user !== true) {
    const found = findConfig(hookRoot(args, env));
    return { found, target: withClient(resolveTarget(found, env), args.client) };
  }
  const reported = reportedFolder(input);
  const dir = env.CLAUDE_PROJECT_DIR;
  const root = typeof dir === "string" && dir !== "" ? dir : (reported ?? os.homedir());
  if (hasProjectInstall(root)) {
    return null;
  }
  const found = userFound(root, userServer(env));
  if (found === null) {
    throw new NoCredentialError();
  }
  return { found, target: withClient(resolveTarget(found, env), args.client) };
}

/**
 * One folder as a client reported it, as a path this system opens, or null. A `file:` URI becomes a path, and on
 * Windows the editor form `/c:/work/...` becomes `c:/work/...` (Node reads the first as absolute, but cannot open it).
 * @param {unknown} dir
 * @param {string} platform
 */
function folderPath(dir, platform) {
  if (typeof dir !== "string" || dir === "") {
    return null;
  }
  let candidate = dir;
  if (candidate.startsWith("file:")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  if (platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(candidate)) {
    candidate = candidate.slice(1);
  }
  return isAbsoluteProject(candidate, platform) ? candidate : null;
}

/**
 * The folder a client says the session works in, for a `--user` hook: `cwd` (Claude Code, Codex, Gemini CLI), else
 * the first of Cursor's `workspace_roots`, since Cursor sends no `cwd`. In a multi-root Cursor workspace only the first
 * root counts, for state and for standing down. Only an absolute path counts; null when there is none.
 * @param {Record<string, unknown>} input the hook's stdin
 * @param {string} [platform]
 */
export function reportedFolder(input, platform = process.platform) {
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  for (const dir of [input.cwd, roots[0]]) {
    const found = folderPath(dir, platform);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** `clientInfo` for the server, so core files the call under the right client family. */
export function clientInfoFor(client) {
  return { name: CLIENT_NAMES[client] ?? CLIENT_NAMES["claude-code"], version: HOOK_VERSION };
}

/** The target `resolveTarget` found, carrying the name this client's hook gives the server. */
export function withClient(target, client) {
  return { ...target, clientInfo: clientInfoFor(client) };
}

/**
 * What session-start prints for a brief: Cursor's `additional_context`, everyone else's `hookSpecificOutput`. A
 * `notice` for the person (install-notice.mjs) rides as `systemMessage`, which the client shows to them, not the model.
 */
export function sessionStartOutput(client, context, notice = null) {
  if (client === "cursor") {
    return `${JSON.stringify({ additional_context: context })}\n`;
  }
  const shown = notice === null ? {} : { systemMessage: notice };
  return `${JSON.stringify({ ...shown, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`;
}

/** Each client's prompt-submit event, named in its `hookSpecificOutput`. */
const PROMPT_EVENTS = { "claude-code": "UserPromptSubmit", codex: "UserPromptSubmit", "gemini-cli": "BeforeAgent", opencode: "UserPromptSubmit" };

/**
 * What the prompt hook prints. Claude Code, Codex and Gemini CLI read `hookSpecificOutput.additionalContext` for
 * their prompt event; Cursor's `beforeSubmitPrompt` must answer `continue`, and takes `additional_context` beside it
 * (a Cursor staff answer, not yet in Cursor's hook docs). Null context means nothing to add.
 */
export function promptOutput(client, context) {
  if (client === "cursor") {
    return `${JSON.stringify(context === null ? { continue: true } : { continue: true, additional_context: context })}\n`;
  }
  if (context === null) {
    return quietOutput(client);
  }
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: PROMPT_EVENTS[client] ?? "UserPromptSubmit", additionalContext: context } })}\n`;
}

/**
 * What the Stop hook prints to keep the turn going with a reason: Claude Code and Codex read `decision: "block"`,
 * Gemini CLI's AfterAgent too (`block` is its alias of `deny`: the reason goes back to the model as a new prompt),
 * Cursor's stop hook auto-submits `followup_message`. Null when the client cannot be held or there is no reason.
 */
export function stopBlockOutput(client, reason) {
  if (reason === null) {
    return null;
  }
  if (client === "claude-code" || client === "codex" || client === "gemini-cli") {
    return `${JSON.stringify({ decision: "block", reason })}
`;
  }
  if (client === "cursor") {
    return `${JSON.stringify({ followup_message: reason })}
`;
  }
  return null;
}

/** What a hook prints on stdout when it has nothing to add: `{}` for the clients that need JSON, else nothing. */
export function quietOutput(client) {
  return JSON_CLIENTS.has(client) ? "{}\n" : "";
}
