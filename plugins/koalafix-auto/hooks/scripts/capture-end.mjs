// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The decision capture's last pass, for Claude Code: a session that ends with finished turns no capture covered gets
// one more capture after it ends, since a SessionEnd hook cannot hold a turn. The session-end hook starts
// `claude -p --resume <session> --fork-session --no-session-persistence` with the capture's reason, detached, so the
// session's own conversation is in the model's context and it saves only what it has not saved yet. The fork is never
// written to disk, and the session's own transcript is left as it was. The run gets no built-in tools (`--tools ""`),
// refuses every tool it is not given (`--permission-mode dontAsk`), so it can call only the koalafix `remember` and
// `recall` tools whatever the person's own permission rules allow, and runs with every hook off (no brief, recall,
// lease or capture of its own; KALIBRATE_CAPTURE=off as well). At most END_MAX_TURNS turns, on the person's own
// Claude Code sign-in: one model call, which KALIBRATE_CAPTURE_AT_END=off turns off.
// No pass when the session ended by logging out, when every turn was covered, when the person must pick a space and
// has not picked one for this folder before (they are gone), for a session id that is not a UUID, or when no `claude` executable can be found (CLAUDE_CODE_EXECPATH
// when it names `claude` or a `.js` entry point run under Node, never a bare node; else `claude` on PATH; a Windows
// install that is only an npm `.cmd` shim is not started).
// Other clients have no headless resume a hook can start.
// Plain ESM, Node 22 APIs only, no dependencies.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { captureReason, capturing, fetchSpaces, isSpacesPage, memberSlugs, pickSpace, projectSlugs } from "./capture.mjs";
import { pickedSpace } from "./spaces.mjs";

/** The tools the last pass may call: the plugin's server, then a `koalafix init` project's. */
export const END_TOOLS = ["mcp__plugin_koalafix_koalafix__remember", "mcp__plugin_koalafix_koalafix__recall", "mcp__koalafix__remember", "mcp__koalafix__recall"];

/** The most turns the last pass may take. */
export const END_MAX_TURNS = 8;

/** Only a session id of this shape goes on the command line, so it can never be read as a flag. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What CLAUDE_CODE_EXECPATH may name: Claude Code itself, or its JavaScript entry point (never Node itself). */
const CLAUDE_FILE = /^(?:claude(?:\.exe)?|[^/]+\.(?:c|m)?js)$/i;

function off(value) {
  return ["off", "0", "false"].includes(String(value ?? "").trim().toLowerCase());
}

/** Whether the session that just ended is owed a last pass: turns not covered, capturing on, not a logout. */
export function endPassDue(state, env, input) {
  if (state === null || state.turns <= state.covered || !capturing(env) || off(env.KALIBRATE_CAPTURE_AT_END)) {
    return false;
  }
  return !(typeof input === "object" && input !== null && input.reason === "logout");
}

/** The `claude` executable to start: CLAUDE_CODE_EXECPATH when it is a file, else the first `claude` on PATH, else null. */
export function claudeExecutable(env, platform = process.platform) {
  const given = env.CLAUDE_CODE_EXECPATH;
  if (typeof given === "string" && CLAUDE_FILE.test(path.basename(given)) && isFile(given)) {
    return given;
  }
  const name = platform === "win32" ? "claude.exe" : "claude";
  const dirs = String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter((dir) => dir !== "");
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The arguments of the last pass for one session. */
export function endArgs(reason, sessionId) {
  return [
    "-p",
    reason,
    "--resume",
    sessionId,
    "--fork-session",
    "--no-session-persistence",
    "--max-turns",
    String(END_MAX_TURNS),
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...END_TOOLS,
  ];
}

/**
 * Starts the last pass if one is owed, and resolves to what it did ("started", or why not). Never rejects: a pass that
 * cannot start leaves the session as it would have been without one.
 */
export async function startEndPass({ target, root, cwd, sessionId, env, deadlineAt }) {
  try {
    if (!SESSION_ID.test(sessionId)) {
      return "not a session id";
    }
    const executable = claudeExecutable(env);
    if (executable === null) {
      return "no claude executable";
    }
    const page = await fetchSpaces(target, deadlineAt);
    const choice = isSpacesPage(page) ? pickSpace(memberSlugs(page), projectSlugs(root), pickedSpace(root, env)) : null;
    if (choice === null || !("space" in choice)) {
      return "no single space";
    }
    const passArgs = endArgs(captureReason(choice, "claude-code", true), sessionId);
    // A JavaScript entry point (an npm install's cli.js) runs under this Node; a native `claude` starts as itself.
    const script = /\.(?:c|m)?js$/i.test(executable);
    const child = spawn(script ? process.execPath : executable, script ? [executable, ...passArgs] : passArgs, {
      cwd,
      env: { ...env, KALIBRATE_CAPTURE: "off" },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    return "started";
  } catch {
    return "failed";
  }
}
