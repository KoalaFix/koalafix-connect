// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// The Copilot adapter (plugins/koalafix-copilot/hooks/copilot.mjs): what it gives a script, what it prints for each
// Copilot event, and that every failure prints `{}`. The scripts here are fakes in a temp folder, so nothing reaches
// a server.   node --test tests/copilot.test.mjs (scripts/check.mjs runs it too)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENT, EVENTS, contextOf, copilotOutput, runAdapter, slimInput } from "../plugins/koalafix-copilot/hooks/copilot.mjs";
import { COPIED_FILES, COPILOT_SCRIPTS, SCRIPTS, copyProblems, writeCopies } from "../scripts/copies.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = path.join(ROOT, "plugins", "koalafix-copilot", "hooks", "copilot.mjs");
const temps = [];
after(() => {
  for (const dir of temps) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A new temp folder, removed when the tests end. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-copilot-"));
  temps.push(dir);
  return dir;
}

const SESSION = { sessionId: "s-1", timestamp: 1793001141827, cwd: path.resolve("/work/app") };
const BRIEF = "KoalaFix team brief (added by a hook)";

/** A temp folder holding one fake script per event, each running `body` (an ESM module text). */
function fakeScripts(body) {
  const dir = tempDir();
  for (const { script } of Object.values(EVENTS)) {
    fs.writeFileSync(path.join(dir, `${script}.mjs`), body);
  }
  return dir;
}

/** A fake script that prints what it was given (its argv and stdin) back as Claude Code context. */
const ECHO = `
import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
const context = JSON.stringify({ argv: process.argv.slice(2), input: JSON.parse(input) });
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "X", additionalContext: context } }));
`;

test("every Copilot event maps to a copied script that exists", () => {
  const scripts = path.join(ROOT, COPILOT_SCRIPTS);
  for (const { script } of Object.values(EVENTS)) {
    assert.ok(fs.existsSync(path.join(scripts, `${script}.mjs`)), script);
  }
});

test("the script gets only the fields it reads, and runs as a --user hook", async () => {
  const scripts = fakeScripts(ECHO);
  const raw = JSON.stringify({ ...SESSION, prompt: "fix the login bug", transformedPrompt: "<current_datetime>x</current_datetime>\n\nfix the login bug" });
  const { stdout } = await runAdapter({ event: "userPromptTransformed", raw, scripts });
  const out = JSON.parse(stdout);
  const echoed = JSON.parse(out.modifiedTransformedPrompt.split("\n\n").at(-1));
  assert.deepEqual(echoed.argv, ["--user", "--client", CLIENT]);
  assert.deepEqual(echoed.input, { sessionId: "s-1", cwd: SESSION.cwd, prompt: "fix the login bug" });
});

test("sessionStart prints the brief as additionalContext, the field Copilot reads", async () => {
  const scripts = fakeScripts(`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ${JSON.stringify(BRIEF)} } }));`);
  const { stdout } = await runAdapter({ event: "sessionStart", raw: JSON.stringify({ ...SESSION, source: "new" }), scripts });
  assert.deepEqual(JSON.parse(stdout), { additionalContext: BRIEF });
});

test("userPromptTransformed keeps the whole model-facing content and adds the recall after it", () => {
  const printed = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Recall: clear" } });
  const input = { prompt: "p", transformedPrompt: "<current_datetime>t</current_datetime>\n\np" };
  assert.deepEqual(copilotOutput("userPromptTransformed", input, printed), { modifiedTransformedPrompt: `${input.transformedPrompt}\n\nRecall: clear` });
});

test("userPromptTransformed changes nothing without a recall or without content to keep", () => {
  const printed = JSON.stringify({ hookSpecificOutput: { additionalContext: "Recall: clear" } });
  assert.deepEqual(copilotOutput("userPromptTransformed", { transformedPrompt: "p" }, ""), {});
  assert.deepEqual(copilotOutput("userPromptTransformed", { transformedPrompt: "" }, printed), {});
  assert.deepEqual(copilotOutput("userPromptTransformed", {}, printed), {});
  assert.deepEqual(copilotOutput("userPromptTransformed", { transformedPrompt: 7 }, printed), {});
});

test("agentStop passes a hold through and nothing else", () => {
  assert.deepEqual(copilotOutput("agentStop", {}, JSON.stringify({ decision: "block", reason: "start the lease" })), { decision: "block", reason: "start the lease" });
  assert.deepEqual(copilotOutput("agentStop", {}, JSON.stringify({ decision: "block", reason: " " })), {});
  assert.deepEqual(copilotOutput("agentStop", {}, JSON.stringify({ decision: "allow" })), {});
  assert.deepEqual(copilotOutput("agentStop", {}, ""), {});
});

test("sessionEnd prints nothing Copilot would act on", () => {
  assert.deepEqual(copilotOutput("sessionEnd", {}, JSON.stringify({ hookSpecificOutput: { additionalContext: "x" } })), {});
});

test("contextOf reads every shape the scripts print and nothing else", () => {
  assert.equal(contextOf(JSON.stringify({ hookSpecificOutput: { additionalContext: "a" } })), "a");
  assert.equal(contextOf(JSON.stringify({ additional_context: "b" })), "b");
  assert.equal(contextOf(JSON.stringify({ additionalContext: "c" })), "c");
  assert.equal(contextOf(""), null);
  assert.equal(contextOf("{}"), null);
  assert.equal(contextOf("not json"), null);
  assert.equal(contextOf("[1]"), null);
  assert.equal(contextOf(JSON.stringify({ additionalContext: "  " })), null);
});

test("slimInput never passes the model-facing prompt to a script", () => {
  const slim = slimInput({ ...SESSION, prompt: "p", transformedPrompt: "secret attachment text", transcriptPath: "/t", stop_hook_active: true });
  assert.deepEqual(slim, { sessionId: "s-1", cwd: SESSION.cwd, prompt: "p", stop_hook_active: true });
});

test("a script that crashes or prints junk gives {} and its stderr", async () => {
  const scripts = fakeScripts(`process.stderr.write("koalafix: prompt hook skipped: server down\\n"); process.stdout.write("garbage"); process.exit(1);`);
  const result = await runAdapter({ event: "userPromptTransformed", raw: JSON.stringify({ ...SESSION, prompt: "p", transformedPrompt: "p" }), scripts });
  assert.equal(result.stdout, "{}\n");
  assert.match(result.stderr, /server down/);
});

test("a script that hangs is stopped and gives {}", async () => {
  const scripts = fakeScripts("setInterval(() => {}, 1000);");
  const result = await runAdapter({ event: "sessionStart", raw: JSON.stringify(SESSION), scripts, ms: 300 });
  assert.equal(result.stdout, "{}\n");
  assert.match(result.stderr, /took longer than 300 ms/);
});

test("a missing script, an unknown event or input that is not an object gives {}", async () => {
  const empty = tempDir();
  assert.equal((await runAdapter({ event: "sessionStart", raw: JSON.stringify(SESSION), scripts: empty })).stdout, "{}\n");
  assert.equal((await runAdapter({ event: "userPromptSubmitted", raw: JSON.stringify(SESSION), scripts: empty })).stdout, "{}\n");
  assert.equal((await runAdapter({ event: "toString", raw: JSON.stringify(SESSION), scripts: empty })).stdout, "{}\n");
  assert.equal((await runAdapter({ event: "sessionStart", raw: "[]", scripts: empty })).stdout, "{}\n");
  assert.equal((await runAdapter({ event: "sessionStart", raw: "", scripts: empty })).stdout, "{}\n");
});

test("a Node that cannot start gives {}", async () => {
  const scripts = fakeScripts(ECHO);
  const result = await runAdapter({ event: "sessionStart", raw: JSON.stringify(SESSION), scripts, execPath: path.join(scripts, "no-such-node") });
  assert.equal(result.stdout, "{}\n");
  assert.match(result.stderr, /copilot hook skipped/);
});

test("the snake_case session_id of Copilot's VS Code compatible format reaches the script", () => {
  assert.deepEqual(slimInput({ session_id: "s-2", cwd: "/w", hook_event_name: "SessionEnd" }), { session_id: "s-2", cwd: "/w" });
});

/** Runs the real entry point as Copilot does: `node <path> <event>` with the payload on stdin. */
function runEntry(file, event, input) {
  return spawnSync(process.execPath, [file, event], { input, encoding: "utf8", timeout: 10_000 });
}

test("the entry point prints {} and exits 0 for an event it does not handle", () => {
  const run = runEntry(ADAPTER, "userPromptSubmitted", JSON.stringify(SESSION));
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "{}\n");
});

test("the entry point still runs when its folder is reached through a junction or symlink", (t) => {
  const link = path.join(tempDir(), "linked-hooks");
  try {
    fs.symlinkSync(path.dirname(ADAPTER), link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`cannot make a link here: ${error.message}`);
    return;
  }
  const run = runEntry(path.join(link, "copilot.mjs"), "userPromptSubmitted", JSON.stringify(SESSION));
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "{}\n");
});

/** A minimal repository tree with the originals the Copilot plugin copies, and the plugin's own files. */
function fakeRepo() {
  const root = tempDir();
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put(`${SCRIPTS}/prompt.mjs`, "// prompt\n");
  put(`${SCRIPTS}/SOURCE`, "KoalaFix/kalibrate abc hooks\n");
  put(`${SCRIPTS}/run.sh`, "#!/bin/sh\n");
  for (const original of Object.values(COPIED_FILES)) {
    put(original, `original ${original}\n`);
  }
  for (const own of ["plugin.json", "mcp.json", "README.md", "com.github.copilot/hooks/hooks.json", "hooks/copilot.mjs"]) {
    put(`plugins/koalafix-copilot/${own}`, "{}\n");
  }
  return root;
}

test("writeCopies makes copies that copyProblems accepts, and leaves Codex's run.sh out", () => {
  const root = fakeRepo();
  writeCopies(root);
  assert.deepEqual(copyProblems(root), []);
  assert.equal(fs.existsSync(path.join(root, COPILOT_SCRIPTS, "run.sh")), false);
});

test("copyProblems names an edited copy, a missing copy, a stray script and any file the plugin should not ship", () => {
  const root = fakeRepo();
  writeCopies(root);
  fs.appendFileSync(path.join(root, COPILOT_SCRIPTS, "prompt.mjs"), "// edited\n");
  fs.rmSync(path.join(root, Object.keys(COPIED_FILES)[0]));
  fs.writeFileSync(path.join(root, COPILOT_SCRIPTS, "extra.mjs"), "");
  fs.writeFileSync(path.join(root, COPILOT_SCRIPTS, "evil.cjs"), "");
  fs.writeFileSync(path.join(root, "plugins/koalafix-copilot/hooks/extra.mjs"), "");
  const problems = copyProblems(root).join("\n");
  assert.match(problems, /prompt\.mjs differs/);
  assert.match(problems, /SKILL\.md is missing|LICENSE is missing/);
  assert.match(problems, /scripts\/extra\.mjs is not in/);
  assert.match(problems, /evil\.cjs is not a file the Copilot plugin ships/);
  assert.match(problems, /hooks\/extra\.mjs is not a file the Copilot plugin ships/);
});
