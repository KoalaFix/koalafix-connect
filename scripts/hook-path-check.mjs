// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// Runs koalafix-auto's Claude Code hook lines and its MCP headers helper the way Claude Code runs them, with no
// credentials and no network, and fails when one does not find Node or does not exit 0 (KFIX-698).
//   node scripts/hook-path-check.mjs
// macOS: each line through /bin/sh -c with launchd's short PATH (/usr/bin:/bin:/usr/sbin:/sbin), the PATH a desktop
// app opened from the Dock hands its hooks, which misses Homebrew's Node. A control runs the old exec form's `node`
// with the same PATH and must fail, so the check is known to bite.
// Windows: each hook line through Git Bash and through Windows PowerShell (Claude Code's two hook shells), and the
// helper through cmd.exe (the shell Claude Code runs a headersHelper in), with sh on PATH and with it taken away.
// The person's home is an empty folder, so the scripts find no credential: session-start prints its first-run
// message, headers.mjs prints {}, and the others print nothing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "koalafix-auto");
const hooks = JSON.parse(fs.readFileSync(path.join(plugin, "hooks", "claude-code.json"), "utf8")).hooks;
const helper = JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8")).mcpServers.koalafix.headersHelper;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "koalafix-home-"));
const NO_NODE = "no Node.js found";
const UNKNOWN_HOOK = "run.sh was given no known hook";
const SHORT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const problems = [];
let runs = 0;

/** Claude Code fills in ${CLAUDE_PLUGIN_ROOT} before any shell sees the line. */
const fill = (line) => line.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin);

function env(extra = {}) {
  return { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: plugin, KALIBRATE_SERVER_URL: "", CLAUDE_CODE_MCP_SERVER_URL: "https://mcp.koalafix.com/mcp", ...extra };
}

function run(label, file, args, options, expect) {
  runs++;
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000, ...options });
  const stdout = (result.stdout ?? "").trim();
  const stderr = result.stderr ?? "";
  const wrong = [];
  if (result.status !== 0) {
    wrong.push(`exit ${result.status ?? result.signal ?? result.error?.message}`);
  }
  if (stderr.includes(NO_NODE)) {
    wrong.push("run.sh found no Node");
  }
  // run.sh exits 0 for a hook name it does not know, so exit 0 alone passed a hook that never ran (3 to 10 Nov 2026).
  if (stderr.includes(UNKNOWN_HOOK)) {
    wrong.push("run.sh was given a hook name it does not accept");
  }
  if (expect.stdout !== undefined && !expect.stdout(stdout)) {
    wrong.push(`unexpected stdout ${JSON.stringify(stdout.slice(0, 120))}`);
  }
  console.log(`${wrong.length === 0 ? "ok  " : "FAIL"} ${label}${wrong.length === 0 ? "" : `: ${wrong.join("; ")}`}`);
  if (wrong.length > 0) {
    problems.push(`${label}: ${wrong.join("; ")}\n${stderr.trim().slice(0, 400)}`);
  }
}

/** What each event prints for a person with no credential. */
function expectFor(event) {
  return event === "SessionStart" ? { stdout: (out) => out.includes("KoalaFix") } : { stdout: (out) => out === "" || out.startsWith("{") };
}

function input(event) {
  return JSON.stringify({ session_id: "hook-path-check", hook_event_name: event, cwd: home, prompt: "hello", transcript_path: path.join(home, "none.jsonl") });
}

const lines = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((hook) => ({ event, command: fill(hook.command) }))));
// One line per event; the list grows when a hook is added, so a dropped hook fails here too.
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd", "SubagentStart"];
const found = lines.map((line) => line.event).sort().join(", ");
if (found !== [...EVENTS].sort().join(", ")) {
  problems.push(`expected the Claude Code hooks ${EVENTS.join(", ")}, found ${found}`);
}

if (process.platform === "darwin" || process.platform === "linux") {
  for (const { event, command } of lines) {
    run(`${event} via /bin/sh, PATH=${SHORT_PATH}`, "/bin/sh", ["-c", command], { input: input(event), env: env({ PATH: SHORT_PATH }) }, expectFor(event));
  }
  run(`headersHelper via /bin/sh, PATH=${SHORT_PATH}`, "/bin/sh", ["-c", fill(helper)], { input: "", env: env({ PATH: SHORT_PATH }) }, { stdout: (out) => out === "{}" });
  // The control: the old exec form, `node` looked up on the short PATH, must not be found, or this check proves nothing.
  if (process.platform === "darwin") {
    const control = spawnSync("node", ["--version"], { env: env({ PATH: SHORT_PATH }), encoding: "utf8" });
    if (control.status === 0) {
      problems.push(`control: node is on ${SHORT_PATH} on this runner, so the short PATH test does not bite`);
    } else {
      console.log(`ok   control: node is not found on ${SHORT_PATH} (the old exec form would fail here)`);
    }
  }
} else if (process.platform === "win32") {
  for (const { event, command } of lines) {
    run(`${event} via Git Bash`, "bash", ["-c", command], { input: input(event), env: env() }, expectFor(event));
    run(`${event} via Windows PowerShell`, "powershell.exe", ["-NoProfile", "-Command", command], { input: input(event), env: env() }, expectFor(event));
  }
  const withoutSh = (process.env.PATH ?? "").split(";").filter((dir) => dir !== "" && !fs.existsSync(path.join(dir, "sh.exe"))).join(";");
  for (const [label, PATH] of [["sh on PATH", process.env.PATH ?? ""], ["no sh on PATH", withoutSh]]) {
    run(`headersHelper via cmd.exe, ${label}`, process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${fill(helper)}"`], { input: "", env: env({ PATH }), windowsVerbatimArguments: true }, { stdout: (out) => out === "{}" });
  }
} else {
  problems.push(`no check for ${process.platform}`);
}

fs.rmSync(home, { recursive: true, force: true });
if (problems.length > 0) {
  console.error(`\n${problems.length} of ${runs} failed:\n${problems.join("\n\n")}`);
  process.exit(1);
}
console.log(`\nok: ${runs} runs found Node and exited 0 on ${process.platform}`);
