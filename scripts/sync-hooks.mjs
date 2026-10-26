// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// Copies the KoalaFix hook scripts from a KoalaFix/kalibrate checkout into the plugin, so the koalafix-auto plugin
// (Claude Code, Codex, Cursor) and the Gemini extension run the same fail-open hooks `koalafix init` installs, in
// --user mode. Run it after the hooks change in kalibrate:
//   node scripts/sync-hooks.mjs <path to a KoalaFix/kalibrate checkout>
// It copies every .mjs in packages/adapters/claude-code/src/hooks except the headers helper (an init-only file),
// removes scripts that no longer exist there, rewrites the hook files (scripts/hook-configs.mjs) and records the
// source commit and each file's sha256 in hooks/scripts/SOURCE, which `node scripts/check.mjs` holds the copies to.
// A checkout with uncommitted changes to the hooks is refused, so SOURCE always names code that exists in git.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCopies } from "./copies.mjs";
import { HOOK_FILES, text } from "./hook-configs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.argv[2];
if (checkout === undefined) {
  console.error("usage: node scripts/sync-hooks.mjs <path to a KoalaFix/kalibrate checkout>");
  process.exit(2);
}
const hooksRel = "packages/adapters/claude-code/src/hooks";
const git = (...args) => execFileSync("git", ["-C", path.resolve(checkout), ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", hooksRel) !== "") {
  console.error(`${hooksRel} has uncommitted changes in ${checkout}; commit them first so SOURCE names real code`);
  process.exit(1);
}
const from = path.join(path.resolve(checkout), ...hooksRel.split("/"));
const to = path.join(root, "plugins", "koalafix-auto", "hooks", "scripts");
const skip = new Set(["headers.mjs"]);
const wanted = fs.readdirSync(from).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && !skip.has(name)).sort();
fs.mkdirSync(to, { recursive: true });
for (const name of fs.readdirSync(to)) {
  if (name.endsWith(".mjs") && !wanted.includes(name)) {
    fs.rmSync(path.join(to, name));
  }
}
const lines = [`KoalaFix/kalibrate ${git("rev-parse", "HEAD")} ${hooksRel}`];
for (const name of wanted) {
  const body = fs.readFileSync(path.join(from, name), "utf8").replaceAll("\r\n", "\n");
  fs.writeFileSync(path.join(to, name), body);
  lines.push(`${createHash("sha256").update(body).digest("hex")}  ${name}`);
}
fs.writeFileSync(path.join(to, "SOURCE"), `${lines.join("\n")}\n`);
// The scripts are Apache-2.0 (their SPDX headers say so), so the licence text travels with them.
fs.copyFileSync(path.join(path.resolve(checkout), "LICENSE"), path.join(to, "LICENSE-Apache-2.0.txt"));
for (const [file, value] of Object.entries(HOOK_FILES)) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text(value));
}
// The Copilot plugin installs only its own folder, so it carries the same scripts as an exact copy.
writeCopies(root);
console.log(`copied ${wanted.length} hook scripts from ${lines[0].split(" ")[1].slice(0, 7)} and rewrote ${Object.keys(HOOK_FILES).length} hook files`);
