// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// The Antigravity adapter (hooks/antigravity.mjs): what it gives a script, what it prints for each Antigravity event,
// that later model calls of a turn start no script, and that every failure prints `{}`. The scripts here are fakes in
// a temp folder, so nothing reaches a server.   node --test tests/antigravity.test.mjs (scripts/check.mjs runs it too)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENT, EVENTS, antigravityOutput, runAdapter, scriptInput, shouldRun, workspaceOf } from "../hooks/antigravity.mjs";
import { HOOK_FILES } from "../scripts/hook-configs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = path.join(ROOT, "hooks", "antigravity.mjs");
const temps = [];
after(() => {
  for (const dir of temps) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A new temp folder, removed when the tests end. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-antigravity-"));
  temps.push(dir);
  return dir;
}

const WORKSPACE = tempDir();
const PAYLOAD = { conversationId: "c-1", cwd: WORKSPACE, workspacePaths: [WORKSPACE], modelName: "gemini-3.8-flash-high", transcriptPath: "/tmp/t.pb", artifactDirectoryPath: "/tmp/brain/c-1" };
const BRIEF = "KoalaFix session brief (added by a hook)";

/** A temp folder holding one fake script per event, each running `body` (an ESM module text). */
function fakeScripts(body) {
  const dir = tempDir();
  for (const { script } of Object.values(EVENTS)) {
    fs.writeFileSync(path.join(dir, `${script}.mjs`), body);
  }
  return dir;
}

/** A fake script that prints what it was given (argv, stdin, working folder) back as hook context. */
const ECHO = `
import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
const context = JSON.stringify({ argv: process.argv.slice(2), input: JSON.parse(input), cwd: process.cwd() });
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "X", additionalContext: context } }));
`;

/** The context an ECHO script sent back through the adapter. */
function echoed(stdout) {
  return JSON.parse(JSON.parse(stdout).injectSteps.at(-1).ephemeralMessage);
}

test("every Antigravity event maps to a koalafix-auto script that exists", () => {
  for (const { script } of Object.values(EVENTS)) {
    assert.ok(fs.existsSync(path.join(ROOT, "plugins", "koalafix-auto", "hooks", "scripts", `${script}.mjs`)), script);
  }
});

test("hooks.json runs the adapter for exactly the events it knows, from the plugin root", () => {
  const groups = HOOK_FILES["hooks.json"];
  assert.deepEqual(Object.keys(groups), ["koalafix"]);
  assert.deepEqual(Object.keys(groups.koalafix).sort(), Object.keys(EVENTS).sort());
  for (const [event, handlers] of Object.entries(groups.koalafix)) {
    assert.deepEqual(handlers.map((handler) => handler.command), [`node ./hooks/antigravity.mjs ${event}`]);
  }
});

test("the script gets only the fields it reads, runs as a --user gemini-cli hook, in the workspace", async () => {
  const scripts = fakeScripts(ECHO);
  const raw = JSON.stringify({ ...PAYLOAD, hookEventName: "PreInvocation", invocationNum: 0, initialNumSteps: 1, lastUserInput: "fix the login bug" });
  const { stdout } = await runAdapter({ event: "PreInvocation", raw, scripts });
  const seen = echoed(stdout);
  assert.deepEqual(seen.argv, ["--user", "--client", CLIENT]);
  assert.deepEqual(seen.input, { session_id: "c-1", cwd: WORKSPACE, prompt: "fix the login bug" });
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(WORKSPACE));
});

test("SessionStart prints the brief as one ephemeral message and leaves the script's notice out", async () => {
  // agy 1.5.14 refuses the whole output when a step's systemMessage is text, so the notice must never ride along.
  const scripts = fakeScripts(`process.stdout.write(JSON.stringify({ systemMessage: "KoalaFix: sign in once", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ${JSON.stringify(BRIEF)} } }));`);
  const { stdout } = await runAdapter({ event: "SessionStart", raw: JSON.stringify({ ...PAYLOAD, hookEventName: "SessionStart", lastUserInput: "hi" }), scripts });
  assert.deepEqual(JSON.parse(stdout), { injectSteps: [{ ephemeralMessage: BRIEF }] });
});

test("SessionStart gives the script a startup source and no prompt", () => {
  assert.deepEqual(scriptInput("SessionStart", { ...PAYLOAD, lastUserInput: "hi" }), { session_id: "c-1", cwd: WORKSPACE, source: "startup" });
});

test("later model calls of a turn start no script and print {}", async () => {
  const marker = path.join(tempDir(), "ran");
  const scripts = fakeScripts(`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x"); process.stdout.write(JSON.stringify({ additionalContext: "recall" }));`);
  const raw = JSON.stringify({ ...PAYLOAD, hookEventName: "PreInvocation", invocationNum: 1, lastUserInput: "fix it" });
  const result = await runAdapter({ event: "PreInvocation", raw, scripts });
  assert.equal(result.stdout, "{}\n");
  assert.equal(fs.existsSync(marker), false);
  assert.equal(shouldRun("PreInvocation", { invocationNum: 0 }), true);
  assert.equal(shouldRun("PreInvocation", { invocationNum: 2 }), false);
  assert.equal(shouldRun("Stop", { invocationNum: 2 }), true);
});

test("a prompt hook with nothing to add prints {}", () => {
  assert.deepEqual(antigravityOutput("PreInvocation", "{}\n"), {});
  assert.deepEqual(antigravityOutput("PreInvocation", ""), {});
});

test("Stop turns a hold into Antigravity's continue, and passes an active continuation as stop_hook_active", async () => {
  assert.deepEqual(antigravityOutput("Stop", JSON.stringify({ decision: "block", reason: "Save the decision first" })), { decision: "continue", reason: "Save the decision first" });
  assert.deepEqual(antigravityOutput("Stop", JSON.stringify({ decision: "block", reason: " " })), {});
  assert.deepEqual(antigravityOutput("Stop", "{}"), {});
  const input = scriptInput("Stop", { ...PAYLOAD, continuationActive: true, fullyIdle: true, terminationReason: "NO_TOOL_CALL", lastUserInput: "x" });
  assert.deepEqual(input, { session_id: "c-1", cwd: WORKSPACE, stop_hook_active: true });
});

test("the workspace falls back to the first workspace path, and a missing one is left out", () => {
  assert.equal(workspaceOf({ workspacePaths: ["/w/one", "/w/two"] }), "/w/one");
  assert.equal(workspaceOf({ cwd: "", workspacePaths: [] }), null);
  assert.deepEqual(scriptInput("PreInvocation", { conversationId: "c-2", lastUserInput: "q" }), { session_id: "c-2", prompt: "q" });
});

test("every failure prints {} and says why on stderr", async () => {
  const unknown = await runAdapter({ event: "SessionEnd", raw: JSON.stringify(PAYLOAD) });
  assert.equal(unknown.stdout, "{}\n");
  assert.match(unknown.stderr, /unknown event "SessionEnd"/);

  const notJson = await runAdapter({ event: "SessionStart", raw: "not json" });
  assert.equal(notJson.stdout, "{}\n");
  assert.match(notJson.stderr, /not a JSON object/);

  const missing = await runAdapter({ event: "SessionStart", raw: JSON.stringify(PAYLOAD), scripts: tempDir() });
  assert.equal(missing.stdout, "{}\n");

  const slow = await runAdapter({ event: "SessionStart", raw: JSON.stringify(PAYLOAD), scripts: fakeScripts("setTimeout(() => {}, 60_000);"), ms: 300 });
  assert.equal(slow.stdout, "{}\n");
  assert.match(slow.stderr, /took longer than/);

  const garbage = await runAdapter({ event: "SessionStart", raw: JSON.stringify(PAYLOAD), scripts: fakeScripts('process.stdout.write("brief, not JSON");') });
  assert.equal(garbage.stdout, "{}\n");

  const crash = await runAdapter({ event: "Stop", raw: JSON.stringify(PAYLOAD), scripts: fakeScripts('process.stderr.write("koalafix: boom\\n"); process.exit(3);') });
  assert.equal(crash.stdout, "{}\n");
  assert.match(crash.stderr, /koalafix: boom/);
});

test("run as a command, the adapter exits 0 with {} on an event it does not know", () => {
  const result = spawnSync(process.execPath, [ADAPTER, "PostInvocation"], { input: JSON.stringify(PAYLOAD), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{}\n");
});
