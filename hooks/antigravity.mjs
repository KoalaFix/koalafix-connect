// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// The Antigravity CLI adapter: `node ./hooks/antigravity.mjs <event>`, one command per Antigravity hook event. The
// repository root is the Antigravity plugin (.antigravity-plugin/plugin.json, mcp_config.json, hooks.json), as it is
// the Gemini CLI extension. It runs the same --user hook scripts koalafix-auto and the extension run
// (plugins/koalafix-auto/hooks/scripts/, copied from KoalaFix/kalibrate and never edited here), so the guards,
// redaction, spool and browser sign-in are the same code. It only reshapes, as measured on agy 1.5.14:
// - Input: Antigravity sends camelCase (`conversationId`, `cwd`, `workspacePaths`, `lastUserInput`, `invocationNum`,
//   `continuationActive`). The script gets the fields it reads, under the names it reads them by: `session_id`,
//   `cwd`, `source`, `prompt` (prompt hook only) and `stop_hook_active`. Never the transcript, whose format is
//   Antigravity's own. The script runs in the workspace folder, as it does under the other clients.
// - Output: the scripts print `hookSpecificOutput.additionalContext`; Antigravity reads `injectSteps`. The context goes
//   back as one `ephemeralMessage`: the model sees it for the rest of the conversation, and `lastUserInput` stays what
//   the person typed. A `userMessage` would replace `lastUserInput` for every later hook (so the next recall would
//   search the brief), and Antigravity refuses the whole output when a step carries `systemMessage` as text, so a
//   script's notice for the person (`systemMessage`) is left out: the context already carries the sign-in link.
// - PreInvocation runs before every model call of a turn (`invocationNum` 0, 1, 2 ...). The recall runs on the first
//   only; the others print `{}` without starting a script.
// - Stop: a hold the script prints (`decision: "block"`) becomes Antigravity's `decision: "continue"` with the reason.
//   Antigravity has no SessionEnd, so a lease the prompt hook started ends by itself.
// The scripts run as `gemini-cli`, the client Antigravity replaces, until kalibrate's client list knows `antigravity`.
// Fails open like the scripts: an unknown event, no Node script, a crash, a timeout or output it cannot read all print
// `{}` and exit 0, so Antigravity carries on unchanged. The script's own stderr notices pass through.
// Plain ESM, Node 22 APIs only, no dependencies.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/** Each Antigravity event, the script it runs and how long the script may take (under the hook's timeout). */
export const EVENTS = {
  SessionStart: { script: "session-start", ms: 9_500 },
  PreInvocation: { script: "prompt", ms: 4_500 },
  Stop: { script: "stop", ms: 4_500 },
};

/** The `--client` the scripts run as: Gemini CLI, which Antigravity CLI replaces for personal Google accounts. */
export const CLIENT = "gemini-cli";

/** Antigravity sends a prompt and some paths; anything bigger than this is not a hook payload. */
const MAX_INPUT = 16 * 1024 * 1024;

/** How long to wait for stdin to end. A host that leaves it open must not stall a model call. */
const STDIN_MS = 1_000;

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "koalafix-auto", "hooks", "scripts");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/** The workspace folder Antigravity reported: `cwd`, else the first of `workspacePaths`, else null. */
export function workspaceOf(input) {
  if (nonEmpty(input.cwd)) {
    return input.cwd;
  }
  const first = Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : undefined;
  return nonEmpty(first) ? first : null;
}

/** The fields of an Antigravity payload a script reads, under the names it reads them by. */
export function scriptInput(event, input) {
  const slim = {};
  if (nonEmpty(input.conversationId)) {
    slim.session_id = input.conversationId;
  }
  const cwd = workspaceOf(input);
  if (cwd !== null) {
    slim.cwd = cwd;
  }
  if (event === "SessionStart") {
    slim.source = "startup";
  }
  if (event === "PreInvocation" && typeof input.lastUserInput === "string") {
    slim.prompt = input.lastUserInput;
  }
  if (event === "Stop" && input.continuationActive === true) {
    slim.stop_hook_active = true;
  }
  return slim;
}

/** Whether `event` with this input runs its script at all: PreInvocation only on a turn's first model call. */
export function shouldRun(event, input) {
  if (event !== "PreInvocation") {
    return true;
  }
  return input.invocationNum === undefined || input.invocationNum === 0;
}

function parsed(printed) {
  const text = printed.trim();
  if (text === "") {
    return null;
  }
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The context a script printed, in any of the shapes the scripts use, or null. */
export function contextOf(printed) {
  const value = parsed(printed);
  if (value === null) {
    return null;
  }
  const nested = isRecord(value.hookSpecificOutput) ? value.hookSpecificOutput.additionalContext : undefined;
  for (const candidate of [nested, value.additionalContext, value.additional_context]) {
    if (nonEmpty(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** A Stop hold the script printed (`decision: "block"` with a reason), or null. */
export function holdOf(printed) {
  const value = parsed(printed);
  return value !== null && value.decision === "block" && nonEmpty(value.reason) ? value.reason : null;
}

/** What this adapter prints for `event`, given what the script printed. */
export function antigravityOutput(event, printed) {
  if (event === "SessionStart" || event === "PreInvocation") {
    const context = contextOf(printed);
    return context === null ? {} : { injectSteps: [{ ephemeralMessage: context }] };
  }
  if (event === "Stop") {
    const reason = holdOf(printed);
    return reason === null ? {} : { decision: "continue", reason };
  }
  return {};
}

/** The folder to run the script in: the workspace when it is a folder on this machine, else this process's own. */
function runFolder(input) {
  const dir = workspaceOf(input);
  try {
    return dir !== null && fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs the script for `event` on `raw` (Antigravity's stdin) and returns `{ stdout, stderr }` for Antigravity. Never
 * throws. `spent` is the time this process has already used: Antigravity's timeout runs from the spawn.
 * @param {{ event: string, raw: string, scripts?: string, execPath?: string, ms?: number, spent?: number, env?: NodeJS.ProcessEnv }} options
 */
export async function runAdapter({ event, raw, scripts = SCRIPTS, execPath = process.execPath, ms, spent = 0, env = process.env }) {
  const quiet = { stdout: "{}\n", stderr: "" };
  const spec = Object.hasOwn(EVENTS, event) ? EVENTS[event] : null;
  if (spec === null) {
    return { ...quiet, stderr: `koalafix: antigravity hook skipped: unknown event ${JSON.stringify(String(event).slice(0, 40))}\n` };
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }
  if (!isRecord(input)) {
    return { ...quiet, stderr: "koalafix: antigravity hook skipped: the hook input was not a JSON object\n" };
  }
  if (!shouldRun(event, input)) {
    return quiet;
  }
  const script = path.join(scripts, `${spec.script}.mjs`);
  const budget = Math.max(200, Math.round((ms ?? spec.ms) - spent));
  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const end = (value) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(execPath, [script, "--user", "--client", CLIENT], { cwd: runFolder(input), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      end({ ok: false, stdout, stderr: `koalafix: antigravity hook skipped: ${error.message}\n` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      end({ ok: false, stdout, stderr: `${stderr}koalafix: antigravity hook skipped: ${spec.script} took longer than ${budget} ms\n` });
    }, budget);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => end({ ok: false, stdout, stderr: `${stderr}koalafix: antigravity hook skipped: ${error.message}\n` }));
    child.on("close", () => end({ ok: true, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(scriptInput(event, input)));
  });
  const output = result.ok ? antigravityOutput(event, result.stdout) : {};
  return { stdout: `${JSON.stringify(output)}\n`, stderr: result.stderr };
}

/** Reads stdin to its end, for at most STDIN_MS and MAX_INPUT bytes, as text ("" past the size limit). */
async function readStdin() {
  const chunks = [];
  let size = 0;
  let timer;
  const read = (async () => {
    try {
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_INPUT) {
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      // a broken pipe reads as what arrived
    }
  })();
  await Promise.race([read, new Promise((resolve) => (timer = setTimeout(resolve, STDIN_MS)))]);
  clearTimeout(timer);
  return size > MAX_INPUT ? "" : Buffer.concat(chunks).toString("utf8");
}

/** Whether `argv1` is this file, through any junction or symlink in either path. */
export function isEntry(argv1) {
  try {
    return argv1 !== undefined && fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1])) {
  const raw = await readStdin();
  const { stdout, stderr } = await runAdapter({ event: process.argv[2] ?? "", raw, spent: performance.now() });
  process.exitCode = 0;
  process.stdin.destroy();
  // Exit once both are flushed, so a stdin a host left open cannot keep the process alive.
  const write = (stream, text) => (text === "" ? Promise.resolve() : new Promise((resolve) => stream.write(text, resolve)));
  await Promise.all([write(process.stderr, stderr), write(process.stdout, stdout)]);
  process.exit(0);
}
