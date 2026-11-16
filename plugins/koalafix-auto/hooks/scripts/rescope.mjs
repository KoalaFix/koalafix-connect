// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors
// The edit check names the files for the hook's own lease. The prompt hook starts the session's lease named after the
// project, with the paths the prompt names, and none when it names none. The gate then answers `unscoped` at the first
// edit: in warn mode (a plugin install) that is only a note, and the hooks A/B eval of 16 Nov 2026 showed agents read
// the hook's lease as their check-in and edit on without naming a file (5 of 6 runs on tasks whose prompt named no
// path), so teammates never saw which files the session was in. Here, when the person's only open work is unscoped and
// the session holds the hook's own lease, the hook starts the session's next lease on the paths about to change and
// closes the unscoped one, as the prompt hook does when it starts a next lease (lease-close.mjs). A teammate on those
// paths, or any refusal, leaves it to the gate's answer, never `force`: only the person may choose to work alongside.
// Plain ESM, Node 22 APIs only, no dependencies.

import { IDEMPOTENCY_META, ToolError, callTool, isRecord } from "./connect.mjs";
import { closeReplaced } from "./lease-close.mjs";
import { leaseKey, writeState } from "./wip.mjs";

/**
 * Whether the hook should name the files for its own lease: a block that says the person's open work names no paths,
 * with no teammate on these paths, in a session whose state holds the lease the hook started for this folder. Warn
 * mode only: in block mode the gate denies the edit and the agent checks in itself, with its own words for the task.
 */
export function shouldRescope(answer, state, mode = "warn") {
  return mode === "warn" && isRecord(answer) && answer.decision === "block" && answer.reason === "unscoped" && (!Array.isArray(answer.overlaps) || answer.overlaps.length === 0)
    && state !== null && state.autoLease === true && typeof state.lease === "string" && Number.isInteger(state.leases);
}

/** The line the agent reads once the hook has checked it in on `paths`. */
export function rescopedText(lease, paths) {
  const shown = paths.slice(0, 5).map((one) => JSON.stringify(one)).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");
  return `KoalaFix: the hook checked you in on ${shown} (lease ${lease}), so teammates see which files you are changing. Edit on; for files outside these, work(action: "start", paths: [...]) first. The session-end hook closes the lease, or call work(action: "done", lease: "${lease}") with the outcome when you finish.`;
}

/** What Claude Code (and Codex) read for it: context in front of the edit, never a permission decision. */
export function rescopedOutput(client, lease, paths) {
  return client === "claude-code" || client === "codex" ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: rescopedText(lease, paths) } })}\n` : "";
}

/**
 * Starts the session's next lease on `paths`, named `what`, closes the unscoped one, and records the new lease in the
 * session's state. Returns the new lease's short id, or null when the server refused (the gate's answer then stands).
 * A failure to reach the server throws, as any hook call does.
 */
export async function rescope({ session, key, state, what, client, reported, paths, project, server, until, env = process.env }) {
  const n = state.leases + 1;
  const idempotency = leaseKey(key, n);
  let work;
  try {
    work = (await callTool(session, "work", { action: "start", what, agent: { client }, paths, idempotency_key: idempotency }, { [IDEMPOTENCY_META]: idempotency, ...reported })).structured ?? null;
  } catch (error) {
    if (error instanceof ToolError) {
      return null;
    }
    throw error;
  }
  if (!isRecord(work) || typeof work.lease !== "string") {
    return null;
  }
  // The new lease goes in the state first, so the session-end hook closes it even if the budget runs out below.
  writeState(key, { ...state, lease: work.lease, expiresAt: typeof work.expires_at === "string" ? work.expires_at : state.expiresAt, leases: n }, env);
  await closeReplaced(session, project, server, key, state, reported, until, env);
  return work.lease;
}
