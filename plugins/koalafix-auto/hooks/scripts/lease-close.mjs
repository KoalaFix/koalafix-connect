// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Closing a hook-started WIP lease that the session-end hook never will (KOA2-531). Two cases left one open for good,
// because the server extends a person's open leases on every later call from the same client:
// - The prompt or Stop hook starts the session's next lease once the end time it was given has passed. The lease it
//   replaces was extended since, so it was still open: it is closed first, under the idempotency key the session-end
//   hook would have used for it.
// - A session that never runs its session-end hook (a Claude Desktop session left open or closed with the app, a killed
//   process) keeps its lease. A later session start on the machine closes the lease of every session that has been
//   quiet for six hours (its state file, transcript and subagent transcripts untouched), and forgets a session quiet
//   for a week. A later prompt in a session it closed starts a new lease.
// A close the server did not confirm goes to the spool (spool.mjs), tagged with the session's project and server: the
// next session start in that project, or in any project on that same server, replays it under the same idempotency
// key, so a close that did land is a no-op the second time.
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { IDEMPOTENCY_META, ToolError, callTool } from "./connect.mjs";
import { forgetModel } from "./provenance.mjs";
import { appendSpool } from "./spool.mjs";
import { readState, removeState, statePath, writeState } from "./wip.mjs";

/**
 * A session whose state file and transcripts have not changed for this long is quiet. Longer than the server's two-hour
 * lease time: a live turn can sit silent that long (a long command, a wait), and closing a live lease costs teammates
 * its collision warnings until the session's next turn.
 */
export const QUIET_MS = 6 * 60 * 60 * 1000;

/** A session quiet for this long is forgotten: its state file goes. */
export const FORGET_MS = 7 * 24 * 60 * 60 * 1000;

/** The outcome of a lease the hook replaced with the session's next one. */
export const NEXT_OUTCOME = "the session went on past this lease's end time, so the hook started its next one (closed by the KoalaFix hook)";

/** The outcome of a quiet session's lease. */
export const QUIET_OUTCOME = "the session went quiet and never ran its session-end hook (closed by the KoalaFix hook at a later session start)";

/** The refusals that mean the lease is closed already: it ended, or the server no longer has it. */
const ALREADY_CLOSED = new Set(["not_active", "not_found"]);

/** The `work(done)` for the lease the session's state holds, under the idempotency key session-end uses for it. */
export function closeArgs(key, state, outcome) {
  return { action: "done", lease: state.lease, outcome, idempotency_key: `hook-wip-done:${key}:${state.leases}` };
}

/** "closed", "refused" (the lease had already ended), or "unsent": no answer by `until`, or any other error. */
function sendBy(session, pending, meta, until) {
  let timer;
  const cutoff = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, until - Date.now()), "unsent");
  });
  const call = callTool(session, "work", pending, { [IDEMPOTENCY_META]: pending.idempotency_key, ...meta }).then(
    () => "closed",
    (error) => (error instanceof ToolError && ALREADY_CLOSED.has(error.code) ? "refused" : "unsent"),
  );
  return Promise.race([call, cutoff]).finally(() => clearTimeout(timer));
}

/**
 * Closes the lease `state` holds before the hook starts the session's next one, by `until` (ms since the epoch); a
 * close the server has not confirmed by then is spooled for `project` on `server` (the target's MCP url). Never throws.
 * Returns whether the lease is taken care of: false when there was none, or when its close could not even be spooled
 * (the state then keeps it, and the next hook tries again).
 */
export async function closeReplaced(session, project, server, key, state, meta, until, env = process.env) {
  if (state === null || state.lease === null) {
    return false;
  }
  const pending = closeArgs(key, state, NEXT_OUTCOME);
  try {
    if ((await sendBy(session, pending, meta, until)) === "unsent") {
      appendSpool({ source: "lease-next", project, server, tool: "work", arguments: pending, reason: "the close was not confirmed before the hook's budget ran out" }, env);
    }
    return true;
  } catch {
    return false;
  }
}

/** Whether a path is one a hook may read the time of: absolute and local (a network path can send the login to a host). */
function readable(file) {
  return typeof file === "string" && path.isAbsolute(file) && !/^[\\/]{2}/.test(file);
}

function mtimeOf(file) {
  try {
    return readable(file) ? fs.statSync(file).mtimeMs : 0;
  } catch {
    return 0;
  }
}

/**
 * The last time anything in the session moved: its state file, its transcript, or a subagent's transcript (Claude Code
 * keeps those in `<transcript without .jsonl>/subagents/`), whichever is latest.
 */
function lastActive(file, transcript) {
  let latest = Math.max(mtimeOf(file), mtimeOf(transcript));
  if (readable(transcript) && transcript.endsWith(".jsonl")) {
    const subagents = path.join(transcript.slice(0, -".jsonl".length), "subagents");
    try {
      for (const name of fs.readdirSync(subagents).slice(0, 200)) {
        latest = Math.max(latest, mtimeOf(path.join(subagents, name)));
      }
    } catch {
      // no subagents
    }
  }
  return latest;
}

/**
 * At a session start: each session on this machine that still holds a lease but has been quiet for QUIET_MS gets its
 * close spooled for its own project and server, and its state forgets the lease, keeping its time so the session stays
 * quiet. A state quiet for FORGET_MS is removed. A state from hooks that did not record the project keeps its lease: no
 * server can be shown to be its own. A state another hook changed meanwhile is left alone. Never throws. Returns how
 * many closes it spooled.
 */
export function sweepQuiet(env = process.env, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(path.dirname(statePath("x", env)));
  } catch {
    return 0;
  }
  let spooled = 0;
  for (const name of names) {
    const key = /^([0-9a-f]{32})\.json$/.exec(name)?.[1];
    const state = key === undefined ? null : readState(key, env);
    if (state === null) {
      continue;
    }
    try {
      const file = statePath(key, env);
      const written = fs.statSync(file).mtimeMs;
      const active = lastActive(file, state.transcript);
      if (now - active < QUIET_MS) {
        continue;
      }
      const closing = state.lease !== null && state.root !== null;
      // A prompt or session-end hook that wrote or removed the state since it was read wins.
      if (fs.statSync(file).mtimeMs !== written || readState(key, env)?.lease !== state.lease) {
        continue;
      }
      if (closing) {
        const server = state.server ?? undefined;
        appendSpool({ source: "quiet-session", project: state.root, server, tool: "work", arguments: closeArgs(key, state, QUIET_OUTCOME), reason: "the session went quiet with its lease open" }, env, new Date(now));
        spooled++;
      }
      if (now - active >= FORGET_MS) {
        removeState(key, env);
        forgetModel(key, env);
      } else if (closing) {
        writeState(key, { ...state, lease: null, expiresAt: null }, env);
        const when = new Date(written);
        fs.utimesSync(file, when, when);
      }
    } catch {
      // One state that cannot be read or written never costs the session start the rest.
    }
  }
  return spooled;
}
