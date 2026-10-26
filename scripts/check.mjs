// SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
// Copyright 2026 KoalaFix PTY LTD

// The checks this repository runs before a change ships, with no network and no dependencies:
//   node scripts/check.mjs [<path to a KoalaFix/kalibrate checkout>]
// 1. Every JSON file parses.
// 2. The hook files are exactly what scripts/hook-configs.mjs writes, and every script they name exists.
// 3. Every copied hook script matches the sha256 recorded in hooks/scripts/SOURCE. With a kalibrate checkout given,
//    each copy must also equal the file in git at the commit SOURCE names (`git show <commit>:<path>`), so a hand
//    edit with a fresh hash in SOURCE still fails, and the checkout's own files must not have moved on since that
//    commit (the copies are not behind).
// 4. No file holds a token, a key or a bearer header, and no hook file names a server: the scripts find the
//    person's server and token at run time, so the bundle carries neither.
// 5. The listed koalafix plugin stays hook-free, so the OpenAI directory still takes it.
// Exits 1 and names each problem.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_FILES, text } from "./hook-configs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "plugins", "koalafix-auto", "hooks", "scripts");
const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git" || entry.name === "node_modules") {
      return [];
    }
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const rel = (full) => path.relative(root, full).replaceAll("\\", "/");
const read = (full) => fs.readFileSync(full, "utf8").replaceAll("\r\n", "\n");
const files = walk(root);

for (const full of files.filter((file) => file.endsWith(".json"))) {
  try {
    JSON.parse(read(full));
  } catch (error) {
    problems.push(`${rel(full)} is not valid JSON: ${error.message}`);
  }
}

for (const [file, value] of Object.entries(HOOK_FILES)) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    problems.push(`${file} is missing (run: node scripts/hook-configs.mjs)`);
    continue;
  }
  const body = read(full);
  if (body !== text(value)) {
    problems.push(`${file} differs from scripts/hook-configs.mjs (run: node scripts/hook-configs.mjs)`);
  }
  for (const [, name] of body.matchAll(/hooks\/scripts\/([a-z-]+\.(?:mjs|sh))/g)) {
    if (!fs.existsSync(path.join(scripts, name))) {
      problems.push(`${file} runs hooks/scripts/${name}, which is not in plugins/koalafix-auto/hooks/scripts`);
    }
  }
  if (/https?:\/\//.test(body)) {
    problems.push(`${file} names a server; the hook scripts must find it from the person's own credential`);
  }
}

const [head, ...entries] = read(path.join(scripts, "SOURCE")).trim().split("\n");
const recorded = new Map(entries.map((line) => line.split(/\s+/)).map(([hash, name]) => [name, hash]));
const copies = fs.readdirSync(scripts).filter((name) => name.endsWith(".mjs"));
for (const name of copies) {
  const hash = createHash("sha256").update(read(path.join(scripts, name))).digest("hex");
  if (recorded.get(name) !== hash) {
    problems.push(`hooks/scripts/${name} does not match SOURCE: re-copy it with scripts/sync-hooks.mjs, never edit it here`);
  }
}
for (const name of recorded.keys()) {
  if (!copies.includes(name)) {
    problems.push(`hooks/scripts/${name} is in SOURCE but missing`);
  }
}

const checkout = process.argv[2];
if (checkout !== undefined) {
  const [, commit = "", hooksRel = ""] = head.split(" ");
  const git = (...args) => execFileSync("git", ["-C", path.resolve(checkout), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const name of copies) {
    let atCommit = null;
    try {
      atCommit = git("show", `${commit}:${hooksRel}/${name}`).replaceAll("\r\n", "\n");
    } catch {
      // not in that commit, or the commit is not in this checkout: reported just below
    }
    if (atCommit !== read(path.join(scripts, name))) {
      problems.push(`hooks/scripts/${name} is not the file at kalibrate ${commit.slice(0, 7)} named in SOURCE; re-copy it with scripts/sync-hooks.mjs`);
      continue;
    }
    const theirs = path.join(path.resolve(checkout), ...hooksRel.split("/"), name);
    if (!fs.existsSync(theirs) || read(theirs) !== atCommit) {
      problems.push(`hooks/scripts/${name} is behind ${checkout}: it changed after ${commit.slice(0, 7)}; run scripts/sync-hooks.mjs`);
    }
  }
}

// kal_ tokens, bearer headers with a value, private keys, and the common provider key shapes.
const SECRET = /\bkal_[A-Za-z0-9_-]{16,}|Bearer\s+(?!\$\{|<)[A-Za-z0-9._~+/-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/=]{20,}|\bsk-[A-Za-z0-9]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}/;
for (const full of files.filter((file) => /\.(json|mjs|js|md|mdc|sh|txt|toml)$|SOURCE$/.test(file) && rel(file) !== "scripts/check.mjs")) {
  if (SECRET.test(read(full))) {
    problems.push(`${rel(full)} holds something that looks like a token or key`);
  }
}

const listed = path.join(root, "plugins", "koalafix");
if (fs.existsSync(path.join(listed, "hooks")) || files.some((file) => rel(file).startsWith("plugins/koalafix/") && /hooks?\.json$/.test(file))) {
  problems.push("plugins/koalafix has hooks: the listed plugin must stay hook-free (OpenAI refuses directory plugins with hooks)");
}
for (const manifest of [".claude-plugin", ".codex-plugin", ".cursor-plugin"].map((dir) => path.join(listed, dir, "plugin.json"))) {
  if (fs.existsSync(manifest) && "hooks" in JSON.parse(read(manifest))) {
    problems.push(`${rel(manifest)} names hooks: the listed plugin must stay hook-free`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${files.length} files, ${copies.length} hook scripts from ${head.split(" ")[1].slice(0, 7)}, ${Object.keys(HOOK_FILES).length} hook files`);
