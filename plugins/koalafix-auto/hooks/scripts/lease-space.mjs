// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Whether a plugin install's automatic WIP lease would land in the space this folder belongs to (KOA2-5).
// `work(start)` names no space: the server files the lease in the person's home space, `general` when they are in it,
// else their first space by slug (core `homeSpace`). A project install's token is scoped to the project's space, so
// its lease is always in the right place. A plugin install's token carries every space the person is in, so the
// prompt hook starts the lease only when that home space is also the space this folder's decisions go to (capture.mjs
// `pickSpace`: the folder's pick, else the person's only space, else the one named after the project). Otherwise it
// starts none, and the lease's label (the repository and branch) never shows in another team's brief.
// Plain ESM, Node 22 APIs only, no dependencies.

import { isSpacesPage, memberSlugs, pickSpace, projectSlugs } from "./capture.mjs";

/** The space `work(start)` files a lease in, from the person's member spaces in the server's order, or null. */
export function homeSlug(members) {
  return members.includes("general") ? "general" : (members[0] ?? null);
}

/**
 * The slug the automatic lease would land in when that is this folder's space, else null (start no lease).
 * A page that is not a `SpacesPage`, or has a next page, is not the whole list, so it starts none.
 * @param {unknown} page the person's `GET /api/v1/spaces` answer
 * @param {string} root the folder the session runs in
 * @param {string | null} picked the space the person picked for this folder before (spaces.mjs), or null
 * @param {string} [home] the home folder, above which no repository is looked for
 */
export function autoLeaseSpace(page, root, picked, home) {
  if (!isSpacesPage(page) || (page.next !== null && page.next !== undefined)) {
    return null;
  }
  const members = memberSlugs(page);
  const target = homeSlug(members);
  const choice = pickSpace(members, projectSlugs(root, home), picked);
  return target !== null && choice !== null && choice.space === target ? target : null;
}
