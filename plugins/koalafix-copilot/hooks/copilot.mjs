// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// The GitHub Copilot adapter: `node copilot.mjs <event>`, one command per Copilot hook event. It runs the same --user
// hook script koalafix-auto runs (hooks/scripts/, copied from KoalaFix/kalibrate by scripts/sync-hooks.mjs and never
// edited here), so the guards, redaction, spool and browser sign-in are the same code. It only reshapes:
// - Input: Copilot's camelCase payload already carries what the scripts read (`sessionId`, `cwd`, `prompt`,
//   `stop_hook_active`), so the script gets those fields and nothing else: never the model-facing prompt.
// - Output: the scripts print Claude Code's `hookSpecificOutput.additionalContext`, which Copilot ignores (tested on
//   Copilot CLI 1.0.103). This prints the field each Copilot event reads:
//   - sessionStart: `additionalContext`, the brief (or the sign-in link and code on first use).
//   - userPromptTransformed: `modifiedTransformedPrompt`, the content the model receives with the recall block after
//     it. Copilot drops the output of a command `userPromptSubmitted` hook, so this event is the per-prompt route.
//   - agentStop: `decision: "block"` and `reason`, the fields Claude Code reads too.
//   - sessionEnd: nothing (Copilot ignores the output); the script closes the lease.
// Fails open like the scripts: an unknown event, no Node script, a crash, a timeout or output it cannot read all
// print `{}` and exit 0, so Copilot carries on unchanged. The script's own stderr notices pass through.
// Plain ESM, Node 22 APIs only, no dependencies.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Each Copilot event, the script it runs and how long the script may take (under the hook's timeoutSec). */
export const EVENTS = {
  sessionStart: { script: "session-start", ms: 9_500 },
  userPromptTransformed: { script: "prompt", ms: 4_500 },
  agentStop: { script: "stop", ms: 4_500 },
  sessionEnd: { script: "session-end", ms: 4_500 },
};

/**
 * The `--client` the scripts run as. Their client list has no `copilot` yet, and `claude-code` prints the shapes this
 * adapter reads. Once client.mjs knows `copilot` (a kalibrate change, after the KOA2-286 re-sync), switch it here so
 * the server files Copilot's calls under their own client family.
 */
export const CLIENT = "claude-code";

/** Copilot sends at most a prompt and a transformed copy; anything bigger than this is not a hook payload. */
const MAX_INPUT = 16 * 1024 * 1024;

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a Copilot payload the scripts read, under the names they read them by. */
export function slimInput(input) {
  const slim = {};
  for (const name of ["sessionId", "cwd", "prompt", "source", "reason", "stop_hook_active"]) {
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

/** What this adapter prints for `event`, given Copilot's input and what the script printed. */
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
 * @param {{ event: string, raw: string, scripts?: string, execPath?: string, ms?: number, env?: NodeJS.ProcessEnv }} options
 */
export async function runAdapter({ event, raw, scripts = SCRIPTS, execPath = process.execPath, ms, env = process.env }) {
  const quiet = { stdout: "{}\n", stderr: "" };
  const spec = Object.hasOwn(EVENTS, event) ? EVENTS[event] : null;
  if (spec === null) {
    return { ...quiet, stderr: `koalafix: copilot hook skipped: unknown event ${JSON.stringify(String(event).slice(0, 40))}\n` };
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
      child = spawn(execPath, [script, "--user", "--client", CLIENT], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      end({ ok: false, stdout, stderr: `koalafix: copilot hook skipped: ${error.message}\n` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      end({ ok: false, stdout, stderr: `${stderr}koalafix: copilot hook skipped: ${spec.script} took longer than ${ms ?? spec.ms} ms\n` });
    }, ms ?? spec.ms);
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

/** Reads stdin to the end (or MAX_INPUT bytes), as text. */
async function readStdin() {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT) {
        return "";
      }
      chunks.push(chunk);
    }
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { stdout, stderr } = await runAdapter({ event: process.argv[2] ?? "", raw: await readStdin() });
  process.exitCode = 0;
  if (stderr !== "") {
    process.stderr.write(stderr);
  }
  process.stdout.write(stdout);
}
