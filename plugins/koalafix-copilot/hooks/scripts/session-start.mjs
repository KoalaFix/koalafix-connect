// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Claude Code SessionStart hook (startup, resume, compact). Fetches the session brief from the project's hosted
// KoalaFix server (`GET /api/v1/brief?repo=`, the token from `.kalibrate/token` in the Authorization header) and hands it
// to Claude as session context (Part A 4.6), its team memory framed as data (format.mjs, KOA2-381). The repo it
// reports puts the team's decisions about it first. The first session start on a machine also shows the person, not
// the model, what the hooks do and send and how to turn them off (install-notice.mjs). It fails open: on any problem it prints nothing on stdout, one line on
// stderr, and exits 0, so a down server never blocks a session. When the server is down (no connection, a 5xx, no
// answer in time, or a cool-off from an earlier failure, offline.mjs) it gives the model one line saying team memory is
// offline, so the model works without it and does not claim to have checked it. With no credential and no way to show
// a browser (client.mjs `canShowBrowser`: a Linux container with no display, a Claude Code cloud session) it exits at
// once with nothing on either stream and no network; with a browser, a plugin install starts the sign-in (device.mjs).
//
// A `command` hook, not `mcp_tool`: Claude Code skips mcp_tool hooks on SessionStart at launch because MCP
// servers are not up yet. Budget: 8 s (KALIBRATE_HOOK_BUDGET_MS overrides). Spool: KALIBRATE_HOME or ~/.kalibrate.
//
// Other clients run the same script with `--client <id>` (the output shape: Cursor reads `additional_context`) and
// `--project <absolute dir>` (the trusted root, in place of CLAUDE_PROJECT_DIR). See client.mjs.

import { BUDGETS, IDEMPOTENCY_META, budgetFrom, callTool, connect, fetchBrief, finish, isServerDown, messageOf, runWithBudget } from "./connect.mjs";
import { readHookInput } from "./project.mjs";
import { locateHook, parseHookArgs, quietOutput, sessionStartOutput } from "./client.mjs";
import { NoCredentialError, signInStep } from "./device.mjs";
import { buildContext } from "./format.mjs";
import { OFFLINE_NOTICE } from "./offline.mjs";
import { drainSpool } from "./spool.mjs";
import { keepModel, modelOf, reportedRepo } from "./provenance.mjs";
import { sessionIdOf, sessionKey } from "./wip.mjs";
import { installNotice } from "./install-notice.mjs";

const env = process.env;
const args = parseHookArgs(process.argv.slice(2));
let output = "";
// A plugin install's first session start on this machine tells the person what the hooks do and send, and how to
// turn them off. A project `koalafix init` set up said so when it wrote the hooks, so it shows nothing here.
let plugin = false;
let forPerson = null;
const firstRun = () => (forPerson ??= (plugin ? installNotice(args.client, env) : null) ?? "");
const startOutput = (text) => sessionStartOutput(args.client, text, firstRun() === "" ? null : forPerson);

/** The repo the brief puts first; none when git's files cannot be read, which must never cost the brief. */
function repoOf(root) {
  try {
    return reportedRepo(root);
  } catch {
    return null;
  }
}
const outcome = await runWithBudget(budgetFrom(env, BUDGETS.sessionStart), async (deadlineAt) => {
  const input = await readHookInput();
  if (args.error !== null) {
    throw new Error(args.error);
  }
  // The config comes from the folder Claude Code was started in (or `--project`), never from `input.cwd`: the
  // session may have moved into a subfolder that holds a `.kalibrate/` of its own. The stdin is only drained.
  // Null: no credential and no browser to sign in with, or a plugin hook standing down for the project's own install.
  let located;
  try {
    located = locateHook(args, env, input);
  } catch (error) {
    if (!(error instanceof NoCredentialError)) {
      throw error;
    }
    // A plugin install with no credential: sign in through the browser, with no terminal (device.mjs).
    plugin = true;
    const step = await signInStep({ env, client: args.client, deadlineAt, start: true });
    if (!step.signedIn) {
      output = step.text === null ? "" : startOutput(step.text);
      return;
    }
    located = locateHook(args, env, input);
  }
  if (located === null) {
    return;
  }
  const { found, target } = located;
  plugin = found.user === true;
  // Claude Code names the session's model here only: kept for the session's later hooks to report (KOA2-149).
  const sessionId = sessionIdOf(input);
  if (sessionId !== null) {
    keepModel(sessionKey(found.root, sessionId), modelOf(input), env);
  }
  const brief = await fetchBrief(target, deadlineAt, repoOf(found.root));
  if (brief.trim() === "") {
    throw new Error("the server sent an empty brief");
  }
  output = startOutput(buildContext(brief));
  // The server answered: replay what earlier sessions in this project could not send, within what is left of the
  // budget, one request per call. A spooled call that carries its own idempotency key (a hook's lease close) replays
  // under it, so a call that did land before its hook was cut off is a no-op the second time.
  const keyOf = (entry) => (typeof entry.arguments?.idempotency_key === "string" ? entry.arguments.idempotency_key : entry.id);
  const session = connect(target, deadlineAt);
  await drainSpool(async (entry) => callTool(session, entry.tool, entry.arguments, { [IDEMPOTENCY_META]: keyOf(entry) }), {
    env,
    project: found.root,
    shouldStop: () => deadlineAt - Date.now() < 300,
  });
});
let notice = "";
if (!outcome.ok) {
  notice = output === "" ? `koalafix: session-start skipped: ${messageOf(outcome.error)}\n` : `koalafix: spool replay stopped: ${messageOf(outcome.error)}\n`;
  if (output === "" && isServerDown(outcome.error)) {
    output = startOutput(OFFLINE_NOTICE);
  }
}
finish({ stdout: output === "" ? quietOutput(args.client) : output, stderr: notice });
