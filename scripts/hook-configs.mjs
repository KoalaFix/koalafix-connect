// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// The hook files for every client that lets a plugin or extension run hooks, written from one table so they stay in
// step with each other and with `koalafix init`: the same four scripts, the same --user mode, the same timeouts.
//   node scripts/hook-configs.mjs          rewrites the files
//   node scripts/hook-configs.mjs --check  exits 1 when a file differs from what this table writes
// Each client starts `node` with no shell between where it can (Claude Code's exec form), or with a command that
// parses the same in sh, cmd and PowerShell. Codex on macOS and Linux goes through run.sh, which also finds a Node
// that a desktop app's short PATH misses. No file here holds a token or a server address: the scripts read the
// person's own credential from ~/.kalibrate/credentials.json at run time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The four hooks: the script each runs and its timeout in seconds (the scripts keep their own, shorter budgets). */
const HOOKS = {
  sessionStart: { script: "session-start", timeout: 10 },
  prompt: { script: "prompt", timeout: 5 },
  stop: { script: "stop", timeout: 5 },
  sessionEnd: { script: "session-end", timeout: 5 },
};

const SCRIPTS = "hooks/scripts";

/** Claude Code: exec form, so no shell parses the path (Git Bash, or PowerShell on Windows without it). */
function claudeCode() {
  const hook = (key) => {
    const { script, timeout } = HOOKS[key];
    return { type: "command", command: "node", args: [`\${CLAUDE_PLUGIN_ROOT}/${SCRIPTS}/${script}.mjs`, "--user"], timeout };
  };
  return {
    description: "KoalaFix team memory, automatic: the brief at session start, recall on each prompt, and once a session your AI saves the decisions it made to the team. Does nothing in a project with its own koalafix init install. Needs Node.js 22 or later; without it the hooks do nothing.",
    hooks: {
      SessionStart: [{ matcher: "startup|resume|compact", hooks: [hook("sessionStart")] }],
      UserPromptSubmit: [{ hooks: [hook("prompt")] }],
      Stop: [{ hooks: [hook("stop")] }],
      SessionEnd: [{ hooks: [hook("sessionEnd")] }],
    },
  };
}

/**
 * Codex: it fills in ${PLUGIN_ROOT} itself (seen in Codex 0.145's hooks/list). run.sh on macOS and Linux, node straight
 * away on Windows. `|| printf` makes sure a missing file can never end the command with exit 2, which Codex reads as
 * "block this prompt" (dash exits 2 when sh cannot open the script).
 */
function codex() {
  const hook = (key, timeout = HOOKS[key].timeout) => {
    const { script } = HOOKS[key];
    return {
      type: "command",
      command: `sh "\${PLUGIN_ROOT}/${SCRIPTS}/run.sh" ${script} --user --client codex || printf '{}\\n'`,
      command_windows: `node "\${PLUGIN_ROOT}/${SCRIPTS}/${script}.mjs" --user --client codex`,
      timeout,
    };
  };
  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [hook("sessionStart")] }],
      UserPromptSubmit: [{ hooks: [hook("prompt")] }],
      Stop: [{ hooks: [hook("stop")] }],
      // Codex gives a SessionEnd hook at most 3 s.
      SessionEnd: [{ hooks: [hook("sessionEnd", 3)] }],
    },
  };
}

/**
 * Cursor: ${CURSOR_PLUGIN_ROOT}, which Cursor documents as the plugin folder. Not a relative path: if Cursor ran plugin
 * hooks from the workspace, as it does project hooks, `./hooks/...` would run a script the repository ships. If the
 * variable is not filled in, the path is wrong in every shell and the hook does nothing, which is the safe way to fail.
 */
function cursor() {
  const hook = (key) => {
    const { script, timeout } = HOOKS[key];
    return { command: `node "\${CURSOR_PLUGIN_ROOT}/${SCRIPTS}/${script}.mjs" --user --client cursor`, timeout };
  };
  return {
    version: 1,
    hooks: {
      sessionStart: [hook("sessionStart")],
      beforeSubmitPrompt: [hook("prompt")],
      stop: [hook("stop")],
      sessionEnd: [hook("sessionEnd")],
    },
  };
}

/** Gemini CLI: the extension is this repository, so the scripts sit under ${extensionPath}. Timeouts in ms. */
function gemini() {
  const hook = (key, name) => {
    const { script, timeout } = HOOKS[key];
    return { type: "command", name, command: `node "\${extensionPath}/plugins/koalafix-auto/${SCRIPTS}/${script}.mjs" --user --client gemini-cli`, timeout: timeout * 1000 };
  };
  return {
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [hook("sessionStart", "koalafix-session-start")] }],
      BeforeAgent: [{ matcher: "*", hooks: [hook("prompt", "koalafix-prompt")] }],
      // AfterAgent is Gemini CLI's end of a turn: stop.mjs only captures the session's decisions there, once a session.
      AfterAgent: [{ matcher: "*", hooks: [hook("stop", "koalafix-capture")] }],
      // At SessionEnd stop.mjs prints what is open (it holds nothing there), and session-end.mjs closes any lease.
      SessionEnd: [{ matcher: "*", hooks: [hook("stop", "koalafix-session-end"), hook("sessionEnd", "koalafix-wip-end")] }],
    },
  };
}

/** Every hook file, by its path in this repository. */
export const HOOK_FILES = {
  "plugins/koalafix-auto/hooks/claude-code.json": claudeCode(),
  "plugins/koalafix-auto/hooks/codex.json": codex(),
  "plugins/koalafix-auto/hooks/cursor.json": cursor(),
  "hooks/hooks.json": gemini(),
};

export const text = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, value] of Object.entries(HOOK_FILES)) {
    const full = path.join(root, file);
    const want = text(value);
    const have = fs.existsSync(full) ? fs.readFileSync(full, "utf8").replaceAll("\r\n", "\n") : null;
    if (have === want) {
      continue;
    }
    if (check) {
      console.error(`${file} differs from scripts/hook-configs.mjs; run: node scripts/hook-configs.mjs`);
      stale++;
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, want);
      console.log(`wrote ${file}`);
    }
  }
  process.exit(stale === 0 ? 0 : 1);
}
