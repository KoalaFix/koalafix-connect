// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The decision capture's last pass, for Claude Code: a session that ends with finished turns no capture covered gets
// one more capture after it ends, since a SessionEnd hook cannot hold a turn. The session-end hook starts
// `claude -p --resume <session> --fork-session --no-session-persistence` with the capture's reason, detached, so the
// session's own conversation is in the model's context and it saves only what it has not saved yet. The fork is never
// written to disk, and the session's own transcript is left as it was. The run is unattended, so its own hooks hold
// nothing and start no pass of their own (capture.mjs `capturing`); it is also given KALIBRATE_CAPTURE=off. It can
// call only the koalafix `remember` and `recall` tools, for at most END_MAX_TURNS turns, on the person's own Claude
// Code sign-in: one model call, which KALIBRATE_CAPTURE_AT_END=off turns off.
// No pass when the session ended by logging out, when every turn was covered, when the person must pick a space (they
// are gone), or when no `claude` executable can be found (CLAUDE_CODE_EXECPATH, which may also name a `.js` entry
// point run under Node, else `claude` on PATH; a Windows install that is only an npm `.cmd` shim is not started).
// Other clients have no headless resume a hook can start.
// Plain ESM, Node 22 APIs only, no dependencies.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { captureReason, capturing, fetchSpaces, isSpacesPage, memberSlugs, pickSpace, projectSlugs } from "./capture.mjs";

/** The tools the last pass may call: the plugin's server, then a `koalafix init` project's. */
export const END_TOOLS = ["mcp__plugin_koalafix_koalafix__remember", "mcp__plugin_koalafix_koalafix__recall", "mcp__koalafix__remember", "mcp__koalafix__recall"];

/** The most turns the last pass may take. */
export const END_MAX_TURNS = 8;

function off(value) {
  return ["off", "0", "false", "no"].includes(String(value ?? "").trim().toLowerCase());
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
  if (typeof given === "string" && given !== "" && isFile(given)) {
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
  return ["-p", reason, "--resume", sessionId, "--fork-session", "--no-session-persistence", "--max-turns", String(END_MAX_TURNS), "--allowedTools", ...END_TOOLS];
}

/**
 * Starts the last pass if one is owed, and resolves to what it did ("started", or why not). Never rejects: a pass that
 * cannot start leaves the session as it would have been without one.
 */
export async function startEndPass({ target, root, cwd, sessionId, env, deadlineAt }) {
  try {
    const executable = claudeExecutable(env);
    if (executable === null) {
      return "no claude executable";
    }
    const page = await fetchSpaces(target, deadlineAt);
    const choice = isSpacesPage(page) ? pickSpace(memberSlugs(page), projectSlugs(root)) : null;
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
