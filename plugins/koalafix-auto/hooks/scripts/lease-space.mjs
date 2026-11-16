// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Whether a plugin install's automatic WIP lease would land in the space this folder belongs to (KOA2-5).
// `work(start)` names no space: the server files the lease in the person's home space, `general` when they are in it,
// else their first space by slug (core `homeSpace`). A project install's token is scoped to the project's space, so
// its lease is always in the right place. A plugin install's token carries every space the person is in, so the
// prompt hook starts the lease only when that home space is also this folder's space: the one the person picked for
// the folder, else the one named after the project, else their only space when the folder is in a git repository.
// A folder outside any repository with no space of its own (personal notes, a scratch folder) gets no lease, so its
// name never reaches teammates; nor does a repository and branch reach another team's brief.
// Plain ESM, Node 22 APIs only, no dependencies.

import path from "node:path";
import { isSpacesPage, projectSlugs } from "./capture.mjs";
import { findRepository } from "./label.mjs";

/** A space slug as the server makes them (capture.mjs keeps the same rule). */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The space `work(start)` files a lease in, from the person's member spaces in the server's order, or null. */
export function homeSlug(members) {
  return members.includes("general") ? "general" : (members[0] ?? null);
}

/** The person's member spaces in the server's order, or null when the page is not the whole, readable list. */
function memberRows(page) {
  if (!isSpacesPage(page) || (page.next !== null && page.next !== undefined)) {
    return null;
  }
  const rows = page.spaces.filter((row) => isRecord(row) && typeof row.role === "string");
  return rows.some((row) => typeof row.slug !== "string" || !SLUG.test(row.slug)) ? null : rows;
}

/**
 * The space this folder belongs to, or null when it belongs to none of the person's spaces (KFIX-780): the one the
 * person picked for the folder, else the one named after the project, else their only space when the folder is in a
 * git repository. A plugin install's prompt hook sends a recall, which carries the person's prompt, only from a folder
 * that has one, so a prompt typed in a personal or unrelated folder never leaves the machine.
 * Every row with a role is a member space, as core's `memberSpaces` counts them; an org admin's view-only rows have
 * none. A list that is not a `SpacesPage`, has a next page, or holds a slug the hook cannot read gives null.
 * @param {unknown} page the person's `GET /api/v1/spaces` answer
 * @param {string} root the folder the session runs in
 * @param {string | null} picked the space the person picked for this folder before (spaces.mjs), or null
 * @param {string} [home] the home folder, above which no repository is looked for
 */
export function folderSpace(page, root, picked, home) {
  const rows = memberRows(page);
  if (rows === null) {
    return null;
  }
  const members = rows.map((row) => row.slug);
  const chosen = picked !== null && members.includes(picked) ? picked : (projectSlugs(root, home).find((slug) => members.includes(slug)) ?? null);
  if (chosen !== null) {
    return chosen;
  }
  return members.length === 1 && findRepository(path.resolve(root), home) !== null ? members[0] : null;
}

/**
 * The slug the automatic lease would land in when that is this folder's space, else null (start no lease): the
 * folder's space (`folderSpace`) must be the person's home space, and a viewer's home space refuses the lease.
 * @param {unknown} page the person's `GET /api/v1/spaces` answer
 * @param {string} root the folder the session runs in
 * @param {string | null} picked the space the person picked for this folder before (spaces.mjs), or null
 * @param {string} [home] the home folder, above which no repository is looked for
 */
export function autoLeaseSpace(page, root, picked, home) {
  const rows = memberRows(page);
  const target = rows === null ? null : homeSlug(rows.map((row) => row.slug));
  if (target === null || rows.find((row) => row.slug === target)?.role === "viewer") {
    return null;
  }
  return folderSpace(page, root, picked, home) === target ? target : null;
}
