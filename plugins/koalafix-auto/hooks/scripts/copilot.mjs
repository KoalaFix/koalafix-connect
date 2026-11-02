// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The GitHub Copilot hook: `node copilot.mjs <event> [--project <absolute dir> | --user]`, one command per Copilot
// hook event. It runs the shared hook script for the event as `--client copilot`, so the guards, redaction, spool,
// lease and sign-in are the same code every other client runs, and it only reshapes what goes in and comes out:
// - Input: Copilot's camelCase payload already carries what the scripts read (`sessionId`, `cwd`, `prompt`,
//   `stop_hook_active`), so the script gets those fields and nothing else: never the model-facing prompt.
// - Output: the scripts print Claude Code's `hookSpecificOutput.additionalContext`, which Copilot ignores (tested on
//   Copilot CLI 1.0.103). This prints the field each Copilot event reads:
//   - sessionStart: `additionalContext`, the brief (or the sign-in link and code on first use).
//   - userPromptTransformed: `modifiedTransformedPrompt`, the content the model receives with the recall block after
//     it. Copilot drops the output of a command `userPromptSubmitted` hook, so this event is the per-prompt route.
//   - agentStop: `decision: "block"` and `reason`, the fields Claude Code reads too.
//   - sessionEnd: nothing (Copilot ignores the output); the script closes the lease.
// `koalafix init` writes `--project <dir>` (the project's `.kalibrate/config.json`, as every project install); the
// koalafix-copilot plugin passes no flag, which runs the scripts as `--user` (the person's own credential).
// Fails open like the scripts: an unknown event, a refused flag, no script, a crash, a timeout or output it cannot
// read all print `{}` and exit 0, so Copilot carries on unchanged. The script's own stderr notices pass through.
// Plain ESM, Node 22 APIs only, no dependencies.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/** Each Copilot event, the script it runs and how long the script may take (under the hook's timeoutSec). */
export const EVENTS = {
  sessionStart: { script: "session-start", ms: 9_500 },
  userPromptTransformed: { script: "prompt", ms: 4_500 },
  agentStop: { script: "stop", ms: 4_500 },
  sessionEnd: { script: "session-end", ms: 4_500 },
};

/** The `--client` the scripts run as: it names the hook to the server as `kalibrate-copilot-hook`. */
export const CLIENT = "copilot";

/** Copilot sends at most a prompt and a transformed copy; anything bigger than this is not a hook payload. */
const MAX_INPUT = 16 * 1024 * 1024;

/** How long to wait for stdin to end. Copilot CLI closes it at once; a host that leaves it open must not stall a prompt. */
const STDIN_MS = 1_000;

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The flags passed on to the script after `--client copilot`: `--project <dir>` (or `--project=<dir>`) as given, or
 * `--user` when there is none. Anything else is refused (null), so the hook never runs a script with a flag it did
 * not mean; the script itself checks that the folder is absolute.
 * @param {readonly string[]} rest the arguments after the event
 */
export function scriptFlags(rest) {
  if (rest.length === 0) {
    return ["--user"];
  }
  if (rest.length === 1 && rest[0] === "--user") {
    return ["--user"];
  }
  if (rest.length === 1 && /^--project=./s.test(rest[0])) {
    return [rest[0]];
  }
  if (rest.length === 2 && rest[0] === "--project" && typeof rest[1] === "string" && rest[1] !== "" && !rest[1].startsWith("--")) {
    return ["--project", rest[1]];
  }
  return null;
}

/** The fields of a Copilot payload the scripts read, under the names they read them by. */
export function slimInput(input) {
  const slim = {};
  // `session_id` is the VS Code compatible format's name (PascalCase events); the scripts read either.
  for (const name of ["sessionId", "session_id", "cwd", "prompt", "source", "reason", "stop_hook_active"]) {
    if (input[name] !== undefined) {
      slim[name] = input[name];
    }
  }
  return slim;
}

/** The context a script printed, in any of the shapes the scripts use, or null. */
export function contextOf(printed) {
  const text = printed.trim();
  if (text === "") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const nested = isRecord(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput.additionalContext : undefined;
  for (const value of [nested, parsed.additionalContext, parsed.additional_context]) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

/** A Stop hold the script printed (`decision: "block"` with a reason), or null. */
export function holdOf(printed) {
  try {
    const parsed = JSON.parse(printed.trim());
    return isRecord(parsed) && parsed.decision === "block" && typeof parsed.reason === "string" && parsed.reason.trim() !== "" ? parsed.reason : null;
  } catch {
    return null;
  }
}

/** What this hook prints for `event`, given Copilot's input and what the script printed. */
export function copilotOutput(event, input, printed) {
  if (event === "sessionStart") {
    const context = contextOf(printed);
    return context === null ? {} : { additionalContext: context };
  }
  if (event === "userPromptTransformed") {
    const context = contextOf(printed);
    const content = input.transformedPrompt;
    // Copilot rejects an empty override, and the model must always get the whole of what it would have got.
    if (context === null || typeof content !== "string" || content === "") {
      return {};
    }
    return { modifiedTransformedPrompt: `${content}\n\n${context}` };
  }
  if (event === "agentStop") {
    const reason = holdOf(printed);
    return reason === null ? {} : { decision: "block", reason };
  }
  return {};
}

/**
 * Runs the script for `event` on `raw` (Copilot's stdin) and returns `{ stdout, stderr }` for Copilot. Never throws.
 * `spent` is the time this process has already used: Copilot's timeout runs from the spawn, so the script gets the rest.
 * @param {{ event: string, raw: string, rest?: readonly string[], scripts?: string, execPath?: string, ms?: number, spent?: number, env?: NodeJS.ProcessEnv }} options
 */
export async function runCopilotHook({ event, raw, rest = [], scripts = SCRIPTS, execPath = process.execPath, ms, spent = 0, env = process.env }) {
  const quiet = { stdout: "{}\n", stderr: "" };
  const spec = Object.hasOwn(EVENTS, event) ? EVENTS[event] : null;
  if (spec === null) {
    return { ...quiet, stderr: `koalafix: copilot hook skipped: unknown event ${JSON.stringify(String(event).slice(0, 40))}\n` };
  }
  const flags = scriptFlags(rest);
  if (flags === null) {
    return { ...quiet, stderr: "koalafix: copilot hook skipped: it takes an event, then --project <dir> or --user\n" };
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }
  if (!isRecord(input)) {
    return { ...quiet, stderr: "koalafix: copilot hook skipped: the hook input was not a JSON object\n" };
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
      child = spawn(execPath, [script, "--client", CLIENT, ...flags], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      end({ ok: false, stdout, stderr: `koalafix: copilot hook skipped: ${error.message}\n` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      end({ ok: false, stdout, stderr: `${stderr}koalafix: copilot hook skipped: ${spec.script} took longer than ${budget} ms\n` });
    }, budget);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => end({ ok: false, stdout, stderr: `${stderr}koalafix: copilot hook skipped: ${error.message}\n` }));
    child.on("close", () => end({ ok: true, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(slimInput(input)));
  });
  const output = result.ok ? copilotOutput(event, input, result.stdout) : {};
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

/** Whether `argv1` is this file, through any junction or symlink in either path (a linked ~/.copilot, say). */
export function isEntry(argv1) {
  try {
    return argv1 !== undefined && fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1])) {
  const raw = await readStdin();
  const { stdout, stderr } = await runCopilotHook({ event: process.argv[2] ?? "", rest: process.argv.slice(3), raw, spent: performance.now() });
  process.exitCode = 0;
  process.stdin.destroy();
  // Exit once both are flushed, so a stdin a host left open cannot keep the process alive.
  const write = (stream, text) => (text === "" ? Promise.resolve() : new Promise((resolve) => stream.write(text, resolve)));
  await Promise.all([write(process.stderr, stderr), write(process.stdout, stdout)]);
  process.exit(0);
}
