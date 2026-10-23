// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// Copies the KoalaFix hook scripts from a KoalaFix/kalibrate checkout into the plugin, so the plugin and the Gemini
// extension run the same fail-open hooks `koalafix init` installs, in --user mode. Run it after the hooks change:
//   node scripts/sync-hooks.mjs <path to a KoalaFix/kalibrate checkout>
// It copies every .mjs in packages/adapters/claude-code/src/hooks except the headers helper (an init-only file),
// removes scripts that no longer exist there, and records the source commit in hooks/scripts/SOURCE.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.argv[2];
if (checkout === undefined) {
  console.error("usage: node scripts/sync-hooks.mjs <path to a KoalaFix/kalibrate checkout>");
  process.exit(2);
}
const from = path.join(path.resolve(checkout), "packages", "adapters", "claude-code", "src", "hooks");
const to = path.join(root, "plugins", "koalafix-auto", "hooks", "scripts");
const skip = new Set(["headers.mjs"]);
const wanted = fs.readdirSync(from).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && !skip.has(name));
fs.mkdirSync(to, { recursive: true });
for (const name of fs.readdirSync(to)) {
  if (name.endsWith(".mjs") && !wanted.includes(name)) {
    fs.rmSync(path.join(to, name));
  }
}
for (const name of wanted) {
  fs.copyFileSync(path.join(from, name), path.join(to, name));
}
const commit = execFileSync("git", ["-C", path.resolve(checkout), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(to, "SOURCE"), `KoalaFix/kalibrate ${commit} packages/adapters/claude-code/src/hooks\n`);
console.log(`copied ${wanted.length} hook scripts from ${commit.slice(0, 7)}`);
