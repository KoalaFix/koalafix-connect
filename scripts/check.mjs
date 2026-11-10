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
// 5. The listed koalafix plugin runs nothing on the machine, so the OpenAI and Claude directories take it: no hooks, no
//    headersHelper, no headers, no displayName in its Claude manifest (the Claude directory refused koalafix-auto 0.5.3
//    and 0.5.9 for command hooks and a headersHelper, accepted only from Verified organisations, and flagged a field
//    from another tool's manifest), and its skill identical to koalafix-auto's copy (scripts/copies.mjs, in 6).
// 6. The Copilot plugin's copies (scripts, skill, licence) equal their originals (scripts/copies.mjs), it ships no
//    other file, its adapter exists, its marketplace entry matches its name, version and folder, its mcp.json names
//    exactly the koalafix plugin's server, and the adapter's tests pass.
// 7. koalafix-auto's copy of the koalafix server (Claude Code) has the koalafix plugin's URL and runs a copied helper
//    with --user, and the listed plugin names no helper.
// 8. The Claude marketplace lists koalafix (the directory plugin) and koalafix-auto, each whole on its own: no
//    dependency (claude.ai skips them, so people had to add koalafix by hand) and koalafix-auto's own copy of the skill
//    at a path only its Claude manifest names; every Claude plugin and marketplace description is at most 500
//    characters, as claude.ai's upload refuses longer ones.
// 9. Every file in the listed koalafix plugin is a type the Claude directory takes from an unverified organisation:
//    Markdown (.md), text, JSON, YAML, or a real PNG, JPEG, GIF, WebP or ICO, judged by name and content; UTF-8, no
//    NUL, no #!, no package config. The directory refused 0.2.1 for a clean UTF-8 .mdc rule, so the extension counts.
// Exits 1 and names each problem.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyProblems } from "./copies.mjs";
import { HEADERS_HELPER, HOOK_FILES, text } from "./hook-configs.mjs";

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
  for (const [, name] of body.matchAll(/\$\{PLUGIN_ROOT\}\/(hooks\/[a-z-]+\.mjs)/g)) {
    if (!fs.existsSync(path.join(root, "plugins", "koalafix-copilot", name))) {
      problems.push(`${file} runs ${name}, which is not in plugins/koalafix-copilot`);
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

problems.push(...copyProblems(root));
const copilot = path.join(root, "plugins", "koalafix-copilot");
const copilotManifest = JSON.parse(read(path.join(copilot, "plugin.json")));
const copilotListing = JSON.parse(read(path.join(root, ".github", "plugin", "marketplace.json"))).plugins.find((entry) => entry.name === copilotManifest.name);
if (copilotListing === undefined) {
  problems.push(`.github/plugin/marketplace.json does not list ${copilotManifest.name}, the name in plugins/koalafix-copilot/plugin.json`);
} else {
  if (copilotListing.version !== copilotManifest.version) {
    problems.push(`.github/plugin/marketplace.json lists ${copilotManifest.name} at ${copilotListing.version}, but its plugin.json says ${copilotManifest.version}`);
  }
  if (String(copilotListing.source).replace(/^\.\//, "") !== "plugins/koalafix-copilot") {
    problems.push(`.github/plugin/marketplace.json points ${copilotManifest.name} at ${copilotListing.source}, not ./plugins/koalafix-copilot`);
  }
}
// The Copilot plugin names the same one server as the koalafix plugin, and nothing else.
const servers = (file) => JSON.parse(read(file)).mcpServers ?? {};
const wanted = JSON.stringify(Object.fromEntries(Object.entries(servers(path.join(listed, ".mcp.json"))).map(([name, entry]) => [name, entry.url])));
const shipped = JSON.stringify(Object.fromEntries(Object.entries(servers(path.join(copilot, "mcp.json"))).map(([name, entry]) => [name, entry.url])));
if (shipped !== wanted) {
  problems.push(`plugins/koalafix-copilot/mcp.json names ${shipped}; it must name exactly the koalafix plugin's server, ${wanted}`);
}

// The Copilot adapter's tests (no network: their scripts are fakes).
try {
  execFileSync(process.execPath, ["--test", path.join(root, "tests", "copilot.test.mjs")], { cwd: root, stdio: "pipe" });
} catch (error) {
  problems.push(`tests/copilot.test.mjs failed:\n${String(error.stdout ?? "").split("\n").filter((line) => /^not ok|^# fail|✖/.test(line.trim())).join("\n")}`);
}

// Claude Code keeps one of two plugin servers at the same URL, so koalafix-auto's copy (the one whose helper sends the
// hooks' sign-in) must point exactly where the koalafix plugin's does, or both would connect and every tool show
// twice. Its helper must be a copied script run with --user, and the listed plugin must run none.
const listedServer = JSON.parse(read(path.join(listed, ".mcp.json"))).mcpServers?.koalafix;
const autoManifest = path.join(root, "plugins", "koalafix-auto", ".claude-plugin", "plugin.json");
const autoServer = JSON.parse(read(autoManifest)).mcpServers?.koalafix;
if (autoServer === undefined || autoServer.url !== listedServer?.url) {
  problems.push(`${rel(autoManifest)} must declare the koalafix server at the koalafix plugin's URL (${listedServer?.url})`);
} else {
  // Through run.sh, so a Node a desktop app's short PATH misses on macOS is still found (scripts/hook-configs.mjs).
  if (autoServer.headersHelper !== HEADERS_HELPER || !fs.existsSync(path.join(scripts, "headers.mjs")) || !fs.existsSync(path.join(scripts, "run.sh"))) {
    problems.push(`${rel(autoManifest)}: the koalafix server's headersHelper must be exactly ${JSON.stringify(HEADERS_HELPER)}, with headers.mjs and run.sh copied`);
  }
}
if (files.some((file) => rel(file).startsWith("plugins/koalafix/") && /\.json$/.test(file) && read(file).includes("headersHelper"))) {
  problems.push("plugins/koalafix names a headersHelper: the listed plugin must run nothing on the machine");
}
for (const [name, entry] of Object.entries(servers(path.join(listed, ".mcp.json")))) {
  const extra = Object.keys(entry).filter((key) => key !== "type" && key !== "url");
  if (extra.length > 0) {
    problems.push(`plugins/koalafix/.mcp.json server ${name} has ${extra.join(", ")}: the listed plugin names its server by type and url only (no headers, nothing run)`);
  }
}
// The directory flagged an unrecognised field and a field from another tool's manifest (displayName), and refuses
// anything run on the machine: the Claude manifest carries exactly these keys; the server comes from .mcp.json and the
// skill from skills/, both found by their default paths.
const LISTED_CLAUDE_KEYS = ["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"];
const listedClaude = JSON.parse(read(path.join(listed, ".claude-plugin", "plugin.json")));
for (const key of Object.keys(listedClaude).filter((key) => !LISTED_CLAUDE_KEYS.includes(key))) {
  problems.push(`plugins/koalafix/.claude-plugin/plugin.json has ${key}: the listed plugin's Claude manifest carries only ${LISTED_CLAUDE_KEYS.join(", ")}`);
}
if (listedClaude.name !== "koalafix" || !/^\d+\.\d+\.\d+$/.test(String(listedClaude.version))) {
  problems.push("plugins/koalafix/.claude-plugin/plugin.json must be named koalafix with a semver version");
}
for (const other of [".codex-plugin", ".cursor-plugin"].map((dir) => path.join(listed, dir, "plugin.json"))) {
  if (JSON.parse(read(other)).version !== listedClaude.version) {
    problems.push(`${rel(other)} is not at ${listedClaude.version}, the version in the Claude manifest: the koalafix plugin has one version`);
  }
}

// From an organisation that is not Verified, the Claude directory takes only Markdown, text, JSON, YAML and PNG, JPEG,
// GIF, WebP or ICO images, judged by name and content: no file starting with #!, no package manager config, text
// UTF-8 with no NUL byte. It refused koalafix 0.2.0 for an SVG logo and 0.2.1 for a clean UTF-8 Cursor rule named
// .mdc, so Markdown here means .md only. Images are checked by their magic bytes.
const TEXT_TYPE = /\.(md|txt|json|ya?ml)$|\/(LICENSE|README)$/;
const IMAGE_MAGIC = { png: "89504e47", jpg: "ffd8ff", jpeg: "ffd8ff", gif: "47494638", webp: "52494646", ico: "00000100" };
const PACKAGE_CONFIG = /\/(package(-lock)?\.json|pnpm-(workspace|lock)\.yaml|yarn\.lock|\.npmrc|\.yarnrc(\.yml)?|bun\.lockb?)$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
for (const full of files.filter((file) => rel(file).startsWith("plugins/koalafix/"))) {
  const name = rel(full);
  const bytes = fs.readFileSync(full);
  const ext = name.split(".").pop().toLowerCase();
  if (PACKAGE_CONFIG.test(name)) {
    problems.push(`${name} is package manager config, which the Claude directory refuses from an unverified organisation`);
  } else if (ext in IMAGE_MAGIC) {
    if (!bytes.toString("hex").startsWith(IMAGE_MAGIC[ext])) {
      problems.push(`${name} is not the ${ext.toUpperCase()} image its name says, which the Claude directory refuses`);
    }
  } else if (!TEXT_TYPE.test(name)) {
    problems.push(`${name} is not Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image: the Claude directory refuses it from an unverified organisation (keep sources such as SVGs outside plugins/koalafix)`);
  } else {
    let text = null;
    try {
      text = utf8.decode(bytes);
    } catch {
      // not UTF-8: reported below
    }
    if (text === null || text.includes("\0") || text.startsWith("#!")) {
      problems.push(`${name} must be UTF-8 text with no NUL byte that does not start with #!`);
    }
  }
}

const claudeMarket = JSON.parse(read(path.join(root, ".claude-plugin", "marketplace.json")));
const claudeListed = (claudeMarket.plugins ?? []).map((entry) => `${entry.name} ${entry.source}`);
if (claudeListed.join("|") !== "koalafix ./plugins/koalafix|koalafix-auto ./plugins/koalafix-auto") {
  problems.push(`.claude-plugin/marketplace.json must list koalafix (./plugins/koalafix, the directory plugin) then koalafix-auto (./plugins/koalafix-auto), nothing else; it lists: ${claudeListed.join(", ") || "nothing"}`);
}
const autoClaude = JSON.parse(read(autoManifest));
if (autoClaude.dependencies !== undefined) {
  problems.push(`${rel(autoManifest)} names dependencies: claude.ai skips them, so koalafix-auto must carry everything itself`);
}
if (autoClaude.skills !== "./claude-skills/" || !fs.existsSync(path.join(root, "plugins", "koalafix-auto", "claude-skills", "koalafix", "SKILL.md"))) {
  problems.push(`${rel(autoManifest)} must name skills "./claude-skills/", which holds the copy of the koalafix skill (run: node scripts/copies.mjs)`);
}
const CLAUDE_DESCRIPTION_MAX = 500;
const claudeDescriptions = [
  ...(claudeMarket.plugins ?? []).map((entry) => [`.claude-plugin/marketplace.json (${entry.name})`, entry.description]),
  ...["koalafix", "koalafix-auto"].map((name) => path.join(root, "plugins", name, ".claude-plugin", "plugin.json")).filter((file) => fs.existsSync(file)).map((file) => [rel(file), JSON.parse(read(file)).description]),
];
for (const [where, description] of claudeDescriptions) {
  if (String(description ?? "").length > CLAUDE_DESCRIPTION_MAX) {
    problems.push(`${where}: the description is ${String(description).length} characters; claude.ai refuses a plugin whose description passes ${CLAUDE_DESCRIPTION_MAX}`);
  }
}
// On claude.ai there are no hooks: the skill loads only when its description matches what the person typed, so the
// description is the trigger. Claude skills cap it at 1,024 characters; one line, so a plain YAML value with no
// ": " (which would end the value) and no em dash.
const SKILL_DESCRIPTION_MAX = 1024;
const skillDescription = /^---\n(?:.*\n)*?description: (.*)\n(?:.*\n)*?---\n/.exec(read(path.join(listed, "skills", "koalafix", "SKILL.md")).replaceAll("\r\n", "\n"))?.[1];
if (skillDescription === undefined) {
  problems.push("plugins/koalafix/skills/koalafix/SKILL.md has no one-line description in its frontmatter");
} else if (skillDescription.length > SKILL_DESCRIPTION_MAX || skillDescription.includes(": ") || skillDescription.includes("—")) {
  problems.push(`plugins/koalafix/skills/koalafix/SKILL.md: the description must be at most ${SKILL_DESCRIPTION_MAX} characters with no ": " and no em dash (it is ${skillDescription.length} characters)`);
}
for (const other of [".codex-plugin", ".cursor-plugin"].map((dir) => path.join(root, "plugins", "koalafix-auto", dir, "plugin.json"))) {
  if (fs.existsSync(other) && read(other).includes("claude-skills")) {
    problems.push(`${rel(other)} names claude-skills: Codex and Cursor list koalafix beside koalafix-auto and would load the skill twice`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${files.length} files, ${copies.length} hook scripts from ${head.split(" ")[1].slice(0, 7)}, ${Object.keys(HOOK_FILES).length} hook files`);
