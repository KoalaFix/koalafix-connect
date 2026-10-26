// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The Stop hook's decision capture (KOA2-286): once per session, the hook holds the turn with a reason that tells the
// model to save each decision the session made about the team's shared work with `remember` (kind decision, lane
// team), in its own words. The model in the session does the writing: the hook makes no model call and sends no
// transcript, and the reason never carries the person's prompt. The only request it adds is one read of the person's
// spaces (`GET /api/v1/spaces`), made once, on the turn it holds.
// Which space: the person's only member space; else the member space named after this project (the slug
// `koalafix init` gives a project's space: the repository's name, or the folder's); else none, and the reason tells
// the model to ask the person which space before it saves. No member space, nothing to save to: no hold.
// Plain ESM, Node 22 APIs only, no dependencies.

import path from "node:path";
import { findRepository, remoteName } from "./label.mjs";

/** How many spaces an "ask the person" reason lists by name. */
export const MAX_LISTED_SPACES = 8;

/** A space slug as the server makes them. Anything else is never put into a reason. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A name as `koalafix init` slugs it into a space (cli `spaceFor`): accents dropped, lower case, every run of other
 * characters one `-`, at most 40 characters, no `-` at either end. Null when nothing is left.
 */
export function slugOf(name) {
  const slug = String(name)
    .trim()
    .slice(0, 80)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? null : slug;
}

/**
 * The slugs a space named after this project could have: the repository's `origin` name, the repository's folder,
 * then the project folder itself. Read from files, never by running git.
 */
export function projectSlugs(root, home) {
  const resolved = path.resolve(root);
  const repo = findRepository(resolved, home);
  const names = repo === null ? [path.basename(resolved)] : [remoteName(repo.commonDir), path.basename(repo.top), path.basename(resolved)];
  return [...new Set(names.filter((name) => typeof name === "string").map(slugOf).filter((slug) => slug !== null))];
}

/** The slugs of the spaces the person is a member of, from a `SpacesPage` (an org admin's view-only rows dropped). */
export function memberSlugs(page) {
  const rows = isRecord(page) && Array.isArray(page.spaces) ? page.spaces : [];
  return rows.filter((row) => isRecord(row) && typeof row.role === "string" && typeof row.slug === "string" && SLUG.test(row.slug)).map((row) => row.slug);
}

/**
 * Where the session's decisions go: `{ space }` for the person's only space or the one named after the project,
 * `{ ask }` (the spaces to offer) when there are several and none is, null when the person is in no space.
 */
export function pickSpace(members, slugs) {
  if (members.length === 0) {
    return null;
  }
  if (members.length === 1) {
    return { space: members[0] };
  }
  const named = slugs.find((slug) => members.includes(slug));
  return named === undefined ? { ask: members.slice(0, MAX_LISTED_SPACES) } : { space: named };
}

/** Whether the client is already continuing the turn because of a stop hook: Claude Code, Codex, Gemini CLI, Cursor. */
export function continuing(input) {
  if (!isRecord(input)) {
    return false;
  }
  return input.stop_hook_active === true || (typeof input.loop_count === "number" && input.loop_count > 0);
}

const WHAT = "save each decision this session made about the team's shared work (code, conventions, process, ownership, handoffs), so teammates' assistants know it";
const RULES = [
  "Write each one in your own words: one or two sentences on what was decided and why.",
  "Never quote the person's messages or copy any prompt text, and do not set user_words.",
  "Leave out anything personal (health, HR, pay, private life) and any secret, token or credential.",
  "Skip any decision you already saved to the team this session.",
].join(" ");

/**
 * How the held turn ends. The person hears in one line what went to the team, and nothing at all when nothing did, so
 * a session that decided nothing ends on its own answer. Gemini CLI replaces the answer it held with the next one, so
 * there the model always gives its answer again.
 */
function ending(client) {
  const told = "one short line telling the person what you saved to the team";
  if (client === "gemini-cli") {
    return `If nothing team-relevant was decided, or it is already saved, save nothing. Then give the person your previous answer again, with ${told} if you saved any.`;
  }
  return `If you save nothing now (nothing team-relevant was decided, or it is already saved), stop at once and write nothing at all: no reply, no closing line, no offer and no mention of this note. If you saved any, write ${told}, then finish.`;
}

/** The reason the Stop hook holds the turn with, for a `pickSpace` answer. */
export function captureReason(choice, client = "claude-code") {
  const head = "KoalaFix (a hook, once per session): before you finish,";
  if ("space" in choice) {
    const call = `For each one call the koalafix remember tool with kind "decision", lane "team", space "${choice.space}".`;
    return `${head} ${WHAT}. ${call} ${RULES} ${ending(client)}`;
  }
  const listed = choice.ask.map((slug) => `"${slug}"`).join(", ");
  return [
    `${head} ${WHAT}. The person is in several KoalaFix spaces (${listed}) and none is named for this project, so do not save yet:`,
    "list each decision in one short line and ask the person which space it belongs in; once they answer, call the koalafix remember tool",
    `with kind "decision", lane "team" and that space. ${RULES} ${ending(client)}`,
  ].join(" ");
}

/** The person's spaces over the read API: `GET <server>/api/v1/spaces` answers a `SpacesPage`. */
export async function fetchSpaces(target, deadlineAt) {
  const info = target.clientInfo ?? { name: "kalibrate-claude-code-hook", version: "0.2.0" };
  const headers = { accept: "application/json", authorization: `Bearer ${target.token}`, "user-agent": `${info.name}/${info.version}` };
  const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  const response = await fetch(`${target.api}/api/v1/spaces`, { method: "GET", headers, redirect: "error", signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET /api/v1/spaces answered HTTP ${response.status}`);
  }
  return JSON.parse(await response.text());
}
