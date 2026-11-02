// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Which files a shell command writes, for the first-edit gate (ADR-0042, KOA2-390): an agent can change a file through
// Claude Code's `Bash` or `PowerShell` tool as easily as through Edit, so pre-tool.mjs asks the gate about those paths
// too. It knows the common ways to write: redirections, tee, sed -i and perl -i, cp, mv, rm, touch, mkdir, dd, git
// commit, rm, mv and restore, adding or removing a package, and PowerShell's content and item cmdlets and
// [IO.File] calls. A command it cannot read for certain (a variable, a substitution, a glob, a script run by an
// interpreter) gives no path, so the gate lets it through: like the rest of the gate it fails open, and it never stops
// a read such as `ls`, `cat` or `git status`. Plain ESM, Node 22 APIs only.

import os from "node:os";
import path from "node:path";
import { MAX_PATHS, MAX_PATH_CHARS, realPath, relativeTo, repoRoot } from "./gate.mjs";
import { changedPaths, pathList, runGit } from "./git-check.mjs";
import { bashCommands, powershellCommands } from "./shell-words.mjs";

/** The Claude Code tools that run a shell, and the shell each one runs. */
const SHELLS = { Bash: "bash", PowerShell: "powershell" };

/** The shell a Claude Code tool runs, or null for any other tool. */
export function shellOf(toolName) {
  return typeof toolName === "string" && Object.hasOwn(SHELLS, toolName) ? SHELLS[toolName] : null;
}

/** The most named files shellPaths looks at on disk, whatever the command lists. */
const MAX_LOOKED = 200;

/** Redirections that write a file. `>&` with a file target is Bash's old spelling of `&>`. */
const WRITE_OPS = new Set([">", ">>", "&>", "&>>", "<>", ">&", ">>&"]);

/** Files a write to which changes nothing in a repository. */
const NOWHERE = /^(\/dev\/\w+|nul|\$null)$/i;

/** Words that may start a Bash command before the program: keywords, and wrappers that run the rest. */
const PREFIXES = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "time", "command", "builtin", "exec", "nohup", "nice"]);

/** sudo's and env's options that take the next word as their value (`sudo -u root rm x`). */
const WRAPPER_VALUES = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-S", "--user", "--group", "--chdir"]);

/** Options that take the next word as their value, per program, so the value is not read as a file. */
const VALUE_OPTIONS = {
  sed: ["-e", "-f", "-l", "--expression", "--file", "--line-length"],
  perl: ["-e", "-E", "-I", "-M", "-m"],
  cp: ["-t", "-S", "--target-directory", "--suffix"],
  install: ["-t", "-S", "-m", "-o", "-g", "--target-directory", "--suffix", "--mode", "--owner", "--group"],
  ln: ["-t", "-S", "--target-directory", "--suffix"],
  mv: ["-t", "-S", "--target-directory", "--suffix"],
  mkdir: ["-m", "--mode"],
  touch: ["-d", "-t", "-r", "--date", "--reference"],
  truncate: ["-s", "-r", "--size", "--reference"],
  tee: [],
  rm: [],
  rmdir: [],
  unlink: [],
  shred: ["-n", "-s", "--iterations", "--size"],
};

/** Package managers, the subcommands that change the manifest, and the manifest each one writes. */
const MANIFESTS = {
  npm: { file: "package.json", add: ["install", "i", "add", "uninstall", "un", "remove", "rm", "r"] },
  pnpm: { file: "package.json", add: ["add", "install", "i", "remove", "rm", "uninstall", "un"] },
  yarn: { file: "package.json", add: ["add", "remove"] },
  bun: { file: "package.json", add: ["add", "a", "install", "i", "remove", "rm"] },
  cargo: { file: "Cargo.toml", add: ["add", "remove", "rm"] },
  uv: { file: "pyproject.toml", add: ["add", "remove"] },
  poetry: { file: "pyproject.toml", add: ["add", "remove"] },
  go: { file: "go.mod", add: ["get"] },
};

/** Subcommands that `install` only when they name packages (`npm install` alone writes no manifest). */
const NEEDS_NAMES = new Set(["install", "i", "get"]);

/** PowerShell aliases for the cmdlets this reads (the Bash tool's `rm`, `cp` and so on stay Bash's). */
const PS_ALIASES = {
  // No `sc`: PowerShell 7 dropped that alias, and `sc` there (and `sc.exe` anywhere) is the service control program.
  ac: "add-content",
  clc: "clear-content",
  ni: "new-item",
  md: "mkdir",
  rm: "remove-item",
  del: "remove-item",
  erase: "remove-item",
  rd: "remove-item",
  rmdir: "remove-item",
  ri: "remove-item",
  cp: "copy-item",
  copy: "copy-item",
  cpi: "copy-item",
  mv: "move-item",
  move: "move-item",
  mi: "move-item",
  ren: "rename-item",
  rni: "rename-item",
  tee: "tee-object",
  cd: "set-location",
  sl: "set-location",
  chdir: "set-location",
  pushd: "set-location",
  "push-location": "set-location",
};

/** PowerShell cmdlets that write the files their path parameter names. */
const PS_WRITERS = new Set(["set-content", "add-content", "clear-content", "out-file", "new-item", "mkdir", "remove-item", "rename-item", "tee-object", "copy-item", "move-item"]);

/** PowerShell parameters that take a value, so the value is not read as a positional argument. */
const PS_VALUES = new Set(["path", "literalpath", "filepath", "destination", "value", "encoding", "itemtype", "type", "name", "newname", "filter", "include", "exclude", "stream", "width", "inputobject", "delimiter", "credential", "erroraction", "warningaction", "informationaction", "outvariable", "errorvariable", "pipelinevariable", "outbuffer", "variable", "ea", "wa", "ia", "ev", "ov", "ob", "pv", "iv", "infa", "target", "tosession", "fromsession"]);

/**
 * `[IO.File]::WriteAllText('a', ...)` and its kin, matched at the start of a word: .NET calls that write the file their
 * first argument names, or for Copy, Move and Replace their second.
 */
const DOTNET = /^\[(?:System\.)?IO\.File\]::(WriteAll\w*|AppendAll\w*|AppendText|Create\w*|Delete|Copy|Move|Replace|OpenWrite)\(\s*(['"])([^'"$]+)\2(?:\s*,\s*(['"])([^'"$]+)\4)?/i;

/** `-WhatIf`: PowerShell only says what it would do. */
const WHATIF = /^-whatif(:\$?true)?$/i;

/** Whether a program word names a file with an extension (`sc.exe`), so it is never a PowerShell alias. */
function hasExtension(word) {
  return /\.\w+$/.test(path.basename(word.text.replace(/\\/g, "/")));
}

/** A program's plain name: lower case, no folder, no `.exe` or `.cmd`. */
function programName(word) {
  return path.basename(word.text.replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** The arguments that are not options, with the values of `valueOptions` dropped. `--` ends the options. */
function operands(args, valueOptions = []) {
  const out = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const text = args[i].text;
    if (options && text === "--") {
      options = false;
    } else if (text === "" && !args[i].dynamic) {
      // macOS sed's `-i ''`: an empty suffix, never a file.
    } else if (options && text.startsWith("-") && text.length > 1) {
      if (valueOptions.includes(text)) {
        i++;
      }
    } else {
      out.push(args[i]);
    }
  }
  return out;
}

/** The value of `-t DIR` or `--target-directory=DIR`, the destination folder of cp, mv, ln and install. */
function targetDirectory(args) {
  for (let i = 0; i < args.length; i++) {
    const text = args[i].text;
    if (text === "-t" || text === "--target-directory") {
      return args[i + 1] ?? null;
    }
    if (text.startsWith("--target-directory=")) {
      return { ...args[i], text: text.slice("--target-directory=".length) };
    }
  }
  return null;
}

/** Option letters after which the rest of a cluster is their value (`perl -Mstrict`, `-Ilib`; `sed -es/i/x/`). */
const ATTACHED = { perl: "IMmeElCFdDx0", sed: "efl" };

/**
 * Whether a short option cluster (`-pi`, `-i.bak`, `-ni`) or `--in-place` asks sed or perl to edit in place. A letter
 * that takes a value ends the cluster, so the `i` in `perl -Mstrict` or `-Ilib` is a value, never in-place.
 */
function inPlace(name, args) {
  return args.some((word) => {
    if (word.text === "--in-place" || word.text.startsWith("--in-place=")) {
      return true;
    }
    if (!/^-[A-Za-z0-9]/.test(word.text)) {
      return false;
    }
    for (const letter of word.text.slice(1)) {
      if (letter === "i") {
        return true;
      }
      if (ATTACHED[name].includes(letter)) {
        return false;
      }
    }
    return false;
  });
}

/**
 * What one Bash (or PowerShell native) program writes: `{ files, commit, cd }`. `files` are words naming the files,
 * `commit` is `{ all }` for a `git commit` (`-a` also takes the changed tracked files), `cd` the folder a `cd` moves to,
 * `stage` is `{ untracked }` for a `git add -A`, `.` or `-u` (whose files a later commit in the line carries).
 * `native` limits it to programs PowerShell runs as programs too (git and the package managers).
 */
function programWrites(name, args, native) {
  const files = [];
  let commit = null;
  let cd;
  let gitCwd;
  let stage = null;
  if (!native && Object.hasOwn(VALUE_OPTIONS, name)) {
    const valueOptions = VALUE_OPTIONS[name];
    if (name === "sed" || name === "perl") {
      if (inPlace(name, args)) {
        const scripted = args.some((word) => valueOptions.includes(word.text) && word.text !== "-I" && word.text !== "-M" && word.text !== "-m");
        files.push(...operands(args, valueOptions).slice(scripted ? 0 : 1));
      }
    } else if (name === "cp" || name === "install" || name === "ln" || name === "mv") {
      const given = operands(args, valueOptions);
      const target = targetDirectory(args);
      files.push(...(target !== null ? [target] : given.slice(-1)));
      if (name === "mv") {
        files.push(...(target !== null ? given : given.slice(0, -1)));
      }
    } else {
      files.push(...operands(args, valueOptions));
    }
  } else if (!native && name === "dd") {
    files.push(...args.filter((word) => word.text.startsWith("of=")).map((word) => ({ ...word, text: word.text.slice(3) })));
  } else if (!native && (name === "cd" || name === "pushd")) {
    cd = args.length === 0 ? { text: "~", dynamic: false, quoted: false } : args[0].text === "-" ? null : args[0];
  } else if (!native && name === "popd") {
    // Back to a folder the reader did not keep: later relative paths are unknown.
    cd = null;
  } else if (name === "git") {
    let i = 0;
    while (i < args.length && args[i].text.startsWith("-")) {
      if (args[i].text === "-C") {
        gitCwd = args[i + 1] ?? null;
      }
      i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i].text) ? 2 : 1;
    }
    const sub = args[i]?.text;
    const rest = args.slice(i + 1);
    if (sub === "commit" && !rest.some((word) => ["--dry-run", "-h", "--help"].includes(word.text))) {
      commit = { all: rest.some((word) => word.text === "--all" || /^-[a-zA-Z]*a/.test(word.text)), untracked: false };
    } else if (sub === "add") {
      // Named files are written to the index; `git add -A`, `.` or `-u` stage what git lists, so a commit later in the
      // same command line (nothing staged yet when the hook runs) asks about the changed files instead.
      const named = operands(rest, ["--pathspec-from-file", "--chmod"]);
      const whole = rest.some((word) => ["-A", "--all", "-u", "--update"].includes(word.text)) || named.some((word) => word.text === "." || word.text === ":/");
      files.push(...named.filter((word) => word.text !== "." && word.text !== ":/"));
      if (whole) {
        stage = { untracked: !rest.some((word) => word.text === "-u" || word.text === "--update") };
      }
    } else if ((sub === "rm" && !rest.some((word) => word.text === "--cached")) || sub === "mv" || (sub === "restore" && (!rest.some((word) => word.text === "--staged" || word.text === "-S") || rest.some((word) => word.text === "--worktree" || word.text === "-W")))) {
      // `git rm --cached` and `git restore --staged` change only the index, never a file.
      files.push(...operands(rest, ["-s", "--source", "--pathspec-from-file"]));
    } else if (sub === "checkout" && rest.some((word) => word.text === "--")) {
      files.push(...rest.slice(rest.findIndex((word) => word.text === "--") + 1));
    }
  } else if (Object.hasOwn(MANIFESTS, name)) {
    const { file, add } = MANIFESTS[name];
    const given = operands(args);
    const sub = given[0]?.text;
    // A global install (`npm i -g pnpm`) or `--no-save` leaves the project's manifest alone.
    const elsewhere = args.some((word) => ["-g", "--global", "--location=global", "--no-save"].includes(word.text));
    if (sub !== undefined && !elsewhere && add.includes(sub) && (!NEEDS_NAMES.has(sub) || given.length > 1)) {
      files.push({ text: file, dynamic: false, quoted: false });
    }
  }
  return { files, commit, cd, gitCwd, stage };
}

/** The value words of a PowerShell cmdlet's parameters, by lower-case name, and its positional words. */
function psArguments(args) {
  /** @type {Record<string, import("./shell-words.mjs").Word[]>} */
  const named = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const text = args[i].text;
    const match = !args[i].quoted && /^-([A-Za-z]+)(?::(.*))?$/.exec(text);
    if (match) {
      const name = match[1].toLowerCase();
      if (match[2] !== undefined && match[2] !== "") {
        named[name] = [{ ...args[i], text: match[2] }];
      } else if (PS_VALUES.has(name) && i + 1 < args.length) {
        named[name] = [args[i + 1]];
        i++;
      }
    } else {
      positional.push(args[i]);
    }
  }
  /** Comma lists (`Remove-Item a,b`) are several paths; positions count the unsplit words (`Copy-Item a, b out`). */
  const split = (words) => words.flatMap((word) => word.text.split(",").filter((part) => part !== "").map((part) => ({ ...word, text: part })));
  // `Copy-Item a, b out`: a word ending in a comma continues the list in the next word.
  const joined = [];
  for (const word of positional) {
    const last = joined.at(-1);
    if (last !== undefined && (last.text.endsWith(",") || word.text.startsWith(","))) {
      joined[joined.length - 1] = { ...last, text: `${last.text}${word.text}`, dynamic: last.dynamic || word.dynamic };
    } else {
      joined.push(word);
    }
  }
  return { named, positional: joined, split };
}

/**
 * What one PowerShell cmdlet writes, as programWrites returns it; null when it is not a cmdlet this reads. Aliases
 * count only for a bare word (`del`, not `del.exe`).
 */
function cmdletWrites(name, args, bare) {
  const cmdlet = (bare ? PS_ALIASES[name] : undefined) ?? name;
  if (cmdlet === "popd" || cmdlet === "pop-location") {
    return { files: [], commit: null, cd: null };
  }
  if (cmdlet !== "set-location" && !PS_WRITERS.has(cmdlet)) {
    return null;
  }
  const { named, positional, split } = psArguments(args);
  if (args.some((word) => WHATIF.test(word.text))) {
    return { files: [], commit: null };
  }
  const paths = split(named.path ?? named.literalpath ?? named.filepath ?? []);
  const first = paths.length > 0 ? paths : split(positional.slice(0, 1));
  if (cmdlet === "set-location") {
    // `cd -` and `cd +` walk PowerShell's location history, which the reader does not keep.
    const to = first[0];
    return { files: [], commit: null, cd: to === undefined ? { text: "~", dynamic: false, quoted: false } : to.text === "-" || to.text === "+" ? null : to };
  }
  if (cmdlet === "copy-item" || cmdlet === "move-item") {
    const destination = named.destination ?? split(positional.slice(paths.length > 0 ? 0 : 1, paths.length > 0 ? 1 : 2));
    return { files: [...destination, ...(cmdlet === "move-item" ? first : [])], commit: null };
  }
  if ((cmdlet === "new-item" || cmdlet === "mkdir") && named.name !== undefined) {
    const folder = first[0] ?? { text: ".", dynamic: false, quoted: false };
    return { files: [{ ...named.name[0], text: `${folder.text}/${named.name[0].text}`, dynamic: folder.dynamic || named.name[0].dynamic }], commit: null };
  }
  return { files: first, commit: null };
}

/**
 * What a shell command writes: `{ files, commits }`, absolute paths in the order found, and one `{ cwd, all }` per
 * `git commit` (its paths come from git, which pre-tool.mjs asks). `cwd` is where the command starts; a `cd` inside it
 * moves later commands, and one the reader cannot follow makes later relative paths unknown, so they are skipped.
 * @param {string} command
 * @param {{ shell: "bash" | "powershell", cwd: string, home?: string, platform?: string }} options
 */
export function shellWrites(command, { shell, cwd, home = os.homedir(), platform = process.platform }) {
  const files = [];
  const commits = [];
  /** @type {string | null} */
  let at = cwd;
  /** @type {{ untracked: boolean } | null} a `git add -A`, `.` or `-u` seen so far in the line */
  let staging = null;
  /** An absolute path for a word, or null when it cannot be known. */
  const resolve = (word, from = at) => {
    if (word === null || word === undefined || word.dynamic || word.text === "" || NOWHERE.test(word.text)) {
      return null;
    }
    const given = word.text === "~" || word.text.startsWith("~/") || word.text.startsWith("~\\") ? path.join(home, word.text.slice(1)) : word.text;
    // Git Bash on Windows spells C:\x as /c/x.
    const text = platform === "win32" && shell === "bash" ? given.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:/") : given;
    if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
      return path.resolve(text);
    }
    return from === null ? null : path.resolve(from, text);
  };
  const commands = shell === "powershell" ? powershellCommands(command) : bashCommands(command);
  /** Where each open subshell started, so a `cd` inside `( ... )` ends with it. */
  const opened = [];
  for (const { words, redirects, group } of commands) {
    if (group === "open") {
      opened.push(at);
      continue;
    }
    if (group === "close") {
      at = opened.length > 0 ? opened.pop() : at;
      continue;
    }
    if (shell === "powershell") {
      for (const word of words) {
        const call = word.quoted ? null : DOTNET.exec(word.text);
        if (call !== null) {
          const second = /^(copy|move|replace)$/i.test(call[1]);
          files.push(resolve({ text: second ? (call[5] ?? "") : call[3], dynamic: false, quoted: true }));
        }
      }
    }
    for (const { op, target } of redirects) {
      if (WRITE_OPS.has(op) && !(op.endsWith("&") && /^(\d+|-)$/.test(target.text))) {
        files.push(resolve(target));
      }
    }
    let start = 0;
    while (start < words.length && shell === "bash" && (PREFIXES.has(words[start].text) || /^[A-Za-z_]\w*=/.test(words[start].text))) {
      start++;
    }
    if (shell === "bash" && (words[start]?.text === "sudo" || words[start]?.text === "env")) {
      start++;
      while (start < words.length && (words[start].text.startsWith("-") || /^[A-Za-z_]\w*=/.test(words[start].text))) {
        start += WRAPPER_VALUES.has(words[start].text) ? 2 : 1;
      }
    }
    const program = words[start];
    if (program === undefined || program.dynamic) {
      continue;
    }
    const name = programName(program);
    const args = words.slice(start + 1);
    const found = (shell === "powershell" ? cmdletWrites(name, args, !hasExtension(program)) : null) ?? programWrites(name, args, shell === "powershell");
    files.push(...found.files.map((word) => resolve(word)));
    if (found.stage !== null && found.stage !== undefined) {
      staging = { untracked: staging?.untracked === true || found.stage.untracked };
    }
    if (found.commit !== null) {
      const where = found.gitCwd === undefined ? at : resolve(found.gitCwd);
      if (where !== null) {
        // A `git add -A` earlier in the line stages files the hook cannot see staged yet: ask git for them as well.
        commits.push({ cwd: where, all: found.commit.all || staging !== null, untracked: staging?.untracked === true });
      }
    }
    if (found.cd !== undefined) {
      at = resolve(found.cd);
    }
  }
  return { files: [...new Set(files.filter((file) => file !== null))], commits };
}

/**
 * The paths a `git commit` about to run would carry: the staged ones, plus the changed tracked ones for `-a` (or after
 * a `git add -A` in the same line), plus the untracked ones `git add -A` or `git add .` would stage. [] for a merge
 * commit (git-check.mjs `changedPaths`) or when git fails or runs past `timeoutMs`, so the gate fails open.
 * @param {{ cwd: string, all: boolean, untracked?: boolean }} commit
 * @param {number} timeoutMs
 * @returns {Promise<string[]>}
 */
export async function commitPaths(commit, timeoutMs) {
  const git = (args) => runGit(args, { cwd: commit.cwd, timeoutMs });
  try {
    const [staged, changed, added] = await Promise.all([
      changedPaths("pre-commit", { git }),
      commit.all ? git(["diff", "--name-only", "--no-renames", "-z"]).then(pathList) : null,
      commit.untracked === true ? git(["ls-files", "--others", "--exclude-standard", "-z"]).then(pathList) : null,
    ]);
    return staged === null ? [] : [...new Set([...staged.paths, ...(changed?.paths ?? []), ...(added?.paths ?? [])])];
  } catch {
    return [];
  }
}

/**
 * The repository paths a shell tool's PreToolUse input writes, for the gate: `{ paths, commits }`, or null when the
 * gate does not apply (another tool, no command, or a command that writes nothing it can name inside `root`). Paths go
 * through symlinks and junctions as an Edit's do, and are at most MAX_PATHS.
 * @param {Record<string, unknown>} input
 * @param {string} root the repository's top level (gate.mjs repoRoot)
 * @param {string} folder the project folder, where the command runs when the input names no `cwd`
 */
export function shellPaths(input, root, folder) {
  const shell = shellOf(input?.tool_name);
  const command = input?.tool_input !== null && typeof input?.tool_input === "object" ? input.tool_input.command : undefined;
  if (shell === null || typeof command !== "string" || command.trim() === "") {
    return null;
  }
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : folder;
  const { files, commits } = shellWrites(command, { shell, cwd });
  // realPath touches the disk, so a command naming thousands of files stops at MAX_PATHS inside the repository, and
  // at MAX_LOOKED files in all, well inside the hook's budget.
  const paths = new Set();
  for (const file of files.slice(0, MAX_LOOKED)) {
    const relative = relativeTo(realPath(file), root);
    if (relative !== null && relative !== "" && relative.length <= MAX_PATH_CHARS) {
      paths.add(relative);
    }
    if (paths.size === MAX_PATHS) {
      break;
    }
  }
  const inRepo = commits.filter((commit) => repoRoot(commit.cwd) === root);
  return paths.size === 0 && inRepo.length === 0 ? null : { paths: [...paths], commits: inRepo };
}
