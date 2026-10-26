// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// Files the Copilot plugin carries as exact copies. A Copilot plugin installs only its own folder, so it cannot reach
// koalafix-auto's scripts or the koalafix plugin's skill: scripts/sync-hooks.mjs writes the copies, and
// scripts/check.mjs fails when one differs from its original (line endings aside), or when the plugin holds a file
// that is not on the list below. Never edit a copy.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The Copilot plugin, koalafix-auto's copied hook scripts, and the Copilot plugin's copy of them. */
export const PLUGIN = "plugins/koalafix-copilot";
export const SCRIPTS = "plugins/koalafix-auto/hooks/scripts";
export const COPILOT_SCRIPTS = "plugins/koalafix-copilot/hooks/scripts";

/** Copy, by its path, to original. */
export const COPIED_FILES = {
  "plugins/koalafix-copilot/skills/koalafix/SKILL.md": "plugins/koalafix/skills/koalafix/SKILL.md",
  "plugins/koalafix-copilot/LICENSE": "plugins/koalafix-auto/LICENSE",
};

/** The files of a scripts folder that come from kalibrate (run.sh is this repository's own, for Codex only). */
export function scriptFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".mjs") || name === "SOURCE" || name === "LICENSE-Apache-2.0.txt").sort() : [];
}

/** Every file under `root`/`dir`, as repository paths with forward slashes. */
function listFiles(root, dir) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) {
    return [];
  }
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? listFiles(root, `${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
}

/** Writes every copy from its original under `root`, removing scripts the original no longer has. */
export function writeCopies(root) {
  const from = path.join(root, SCRIPTS);
  const to = path.join(root, COPILOT_SCRIPTS);
  const wanted = scriptFiles(from);
  fs.mkdirSync(to, { recursive: true });
  for (const name of scriptFiles(to)) {
    if (!wanted.includes(name)) {
      fs.rmSync(path.join(to, name));
    }
  }
  for (const name of wanted) {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
  for (const [copy, original] of Object.entries(COPIED_FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, copy)), { recursive: true });
    fs.copyFileSync(path.join(root, original), path.join(root, copy));
  }
}

/** Every way a copy under `root` differs from its original, as sentences. */
export function copyProblems(root) {
  const problems = [];
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replaceAll("\r\n", "\n");
  const wanted = scriptFiles(path.join(root, SCRIPTS));
  const have = scriptFiles(path.join(root, COPILOT_SCRIPTS));
  for (const name of wanted) {
    if (!have.includes(name)) {
      problems.push(`${COPILOT_SCRIPTS}/${name} is missing (run: node scripts/sync-hooks.mjs <kalibrate>, or node scripts/copies.mjs)`);
    } else if (read(`${COPILOT_SCRIPTS}/${name}`) !== read(`${SCRIPTS}/${name}`)) {
      problems.push(`${COPILOT_SCRIPTS}/${name} differs from ${SCRIPTS}/${name}; never edit a copy (run: node scripts/copies.mjs)`);
    }
  }
  for (const name of have.filter((name) => !wanted.includes(name))) {
    problems.push(`${COPILOT_SCRIPTS}/${name} is not in ${SCRIPTS} (run: node scripts/copies.mjs)`);
  }
  // Nothing else may ride along in the Copilot plugin: it installs whole onto people's machines.
  const own = ["plugin.json", "mcp.json", "README.md", "com.github.copilot/hooks/hooks.json", "hooks/copilot.mjs"].map((rel) => `${PLUGIN}/${rel}`);
  const allowed = new Set([...own, ...Object.keys(COPIED_FILES), ...wanted.map((name) => `${COPILOT_SCRIPTS}/${name}`)]);
  for (const rel of listFiles(root, PLUGIN)) {
    if (!allowed.has(rel)) {
      problems.push(`${rel} is not a file the Copilot plugin ships; remove it, or add it to scripts/copies.mjs on purpose`);
    }
  }
  for (const [copy, original] of Object.entries(COPIED_FILES)) {
    if (!fs.existsSync(path.join(root, copy))) {
      problems.push(`${copy} is missing (run: node scripts/copies.mjs)`);
    } else if (read(copy) !== read(original)) {
      problems.push(`${copy} differs from ${original}; never edit a copy (run: node scripts/copies.mjs)`);
    }
  }
  return problems;
}

// `node scripts/copies.mjs` rewrites the copies from the originals already in this repository.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeCopies(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(`wrote ${COPILOT_SCRIPTS} and ${Object.keys(COPIED_FILES).length} copied files`);
}
