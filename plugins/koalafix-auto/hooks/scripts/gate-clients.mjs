// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The first-edit gate in every client (ADR-0042, KOA2-559): what each client's pre-tool hook sends, read as the edit's
// files or the shell command it runs, and what each one must print to deny the call or put a note in front of it.
// pre-tool.mjs asks the same `GET /api/v1/gate` route with the same session cache for all of them; only the shapes in
// and out differ. Each client's shape is the one its hooks reference documents, checked by a real run where one could
// be made (the PR for KOA2-559 says which).
// - Claude Code `PreToolUse`: Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell (gate.mjs, shell-writes.mjs).
// - Codex `PreToolUse`: `apply_patch` (the patch in `tool_input.command`, its headers naming the files) and `Bash`, its
//   shell tool, which runs PowerShell on Windows.
// - Gemini CLI `BeforeTool`: write_file, replace and edit by `file_path`, run_shell_command by `command`.
// - Copilot CLI `preToolUse` (through copilot.mjs): edit, create and write by `path`, apply_patch by its patch, bash
//   and powershell by `command`; `toolArgs` may arrive as a JSON string.
// - Cursor `preToolUse` (tool types Write, Delete, Shell) and `beforeShellExecution` (the command at the top level).
// Each reader takes exactly the tools its client's matcher (the adapter's hooks file) sends, so the two stay in step.
// Plain ESM, Node 22 APIs only, no dependencies.

import path from "node:path";
import { folderPath } from "./client.mjs";
import { MAX_PATHS, MAX_PATH_CHARS, WARN_MODE_NOTE, gateOutput, realPath, relativeTo } from "./gate.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields a client's edit tools name their file by, in the order they are tried. */
const FILE_FIELDS = ["file_path", "path", "absolute_path", "target_file", "notebook_path", "filePath"];

/** A file header in an apply_patch patch: the files it adds, updates, deletes or moves to (paths.mjs reads the same). */
const PATCH_HEADER = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+?)\s*$/gm;

/** The files an apply_patch patch changes, in order, each once. */
export function patchFiles(patch) {
  if (typeof patch !== "string") {
    return [];
  }
  return [...new Set([...patch.matchAll(PATCH_HEADER)].map((match) => match[1]))];
}

/** The shell a client's shell tool runs where nothing says: PowerShell on Windows, Bash elsewhere. */
function platformShell(platform) {
  return platform === "win32" ? "powershell" : "bash";
}

/**
 * A command as one string: a string as it is, or an argv such as `["bash", "-lc", "..."]` as the script it runs (the
 * last argument after `-c`, `-lc` or `-Command`), else its words joined. Null for anything else.
 */
export function commandText(command) {
  if (typeof command === "string") {
    return command.trim() === "" ? null : command;
  }
  if (!Array.isArray(command) || command.length === 0 || !command.every((word) => typeof word === "string")) {
    return null;
  }
  const flag = command.findIndex((word, index) => index > 0 && /^-(?:l?c|Command)$/i.test(word));
  if (flag !== -1 && flag === command.length - 2) {
    return command[flag + 1];
  }
  // Words with spaces or quotes are quoted, so `["touch", "my file.txt"]` names one file, not two.
  return command.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(" ");
}

/** The shell an argv names first (`bash`, `pwsh`, `powershell.exe`), or null when it names none. */
function argvShell(command) {
  if (!Array.isArray(command) || typeof command[0] !== "string") {
    return null;
  }
  const name = command[0].replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") {
    return "powershell";
  }
  return ["bash", "sh", "zsh", "dash"].includes(name) ? "bash" : null;
}

/** The first file field of a tool's input that holds a non-empty string. */
function fileOf(toolInput) {
  if (!isRecord(toolInput)) {
    return null;
  }
  for (const name of FILE_FIELDS) {
    if (typeof toolInput[name] === "string" && toolInput[name].trim() !== "") {
      return toolInput[name];
    }
  }
  return null;
}

/** A tool input that may arrive as a JSON string (Copilot's `toolArgs`, Cursor's MCP input) as an object, or null. */
function objectOf(value) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const edit = (tool, files) => (files.length === 0 ? null : { tool, files, shell: null, command: null });
const shell = (tool, kind, command) => (command === null ? null : { tool, files: [], shell: kind, command });

/** Codex: apply_patch by its patch text, its shell tool by its command (a string or an argv). */
function codexCall(name, toolInput, platform) {
  if (name === "apply_patch") {
    const patch = typeof toolInput?.input === "string" ? toolInput.input : typeof toolInput?.patch === "string" ? toolInput.patch : null;
    const fromCommand = Array.isArray(toolInput?.command) && toolInput.command[0] === "apply_patch" ? toolInput.command[1] : toolInput?.command;
    return edit(name, patchFiles(patch ?? fromCommand));
  }
  if (name === "Bash") {
    const command = toolInput?.command ?? toolInput?.cmd;
    // An apply_patch a model runs as a shell command is an edit, as Codex itself treats it.
    if (Array.isArray(command) && command[0] === "apply_patch") {
      return edit("apply_patch", patchFiles(command[1]));
    }
    const text = commandText(command);
    if (text !== null && /^\s*apply_patch\b/.test(text)) {
      return edit("apply_patch", patchFiles(text));
    }
    // Codex names its shell tool `Bash` everywhere, but runs it through PowerShell on Windows (seen on 0.164).
    return shell(name, argvShell(command) ?? platformShell(platform), text);
  }
  return null;
}

/** Gemini CLI: its file tools by `file_path`, its shell tool by `command` (PowerShell on Windows). */
function geminiCall(name, toolInput, platform) {
  if (["write_file", "replace", "edit"].includes(name)) {
    const file = fileOf(toolInput);
    return edit(name, file === null ? [] : [file]);
  }
  if (name === "run_shell_command") {
    return shell(name, platformShell(platform), commandText(toolInput?.command));
  }
  return null;
}

/** Copilot CLI: edit, create and write by `path`, apply_patch by its patch; bash and powershell by `command`. */
function copilotCall(name, toolInput) {
  if (name === "apply_patch") {
    return edit(name, patchFiles(typeof toolInput?.input === "string" ? toolInput.input : toolInput?.patch));
  }
  if (["edit", "create", "write", "str_replace_editor"].includes(name)) {
    const file = fileOf(toolInput);
    return edit(name, file === null ? [] : [file]);
  }
  if (name === "bash" || name === "powershell") {
    return shell(name, name, commandText(toolInput?.command));
  }
  return null;
}

/** Cursor: `preToolUse` on Write, Edit and Delete by path, Shell by command; `beforeShellExecution` by its `command`. */
function cursorCall(input, platform) {
  if (input.hook_event_name === "beforeShellExecution" || (input.tool_name === undefined && typeof input.command === "string")) {
    return shell("Shell", platformShell(platform), commandText(input.command));
  }
  const name = input.tool_name;
  const toolInput = objectOf(input.tool_input);
  if (["Write", "Edit", "Delete"].includes(name)) {
    const file = fileOf(toolInput);
    return edit(name, file === null ? [] : [file]);
  }
  if (name === "Shell") {
    return shell(name, platformShell(platform), commandText(toolInput?.command));
  }
  return null;
}

/** Claude Code's own tools, as gate.mjs and shell-writes.mjs read them. */
const CLAUDE_FILES = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const CLAUDE_SHELLS = { Bash: "bash", PowerShell: "powershell" };

function claudeCall(name, toolInput) {
  if (Object.hasOwn(CLAUDE_FILES, name)) {
    const file = isRecord(toolInput) ? toolInput[CLAUDE_FILES[name]] : undefined;
    return edit(name, typeof file === "string" && file.trim() !== "" ? [file] : []);
  }
  if (Object.hasOwn(CLAUDE_SHELLS, name)) {
    return shell(name, CLAUDE_SHELLS[name], commandText(toolInput?.command));
  }
  return null;
}

/**
 * The call a client's pre-tool hook is about: `{ tool, files, shell, command }` with the files an edit names (as the
 * client gave them, relative or absolute) or the shell (`bash` or `powershell`) and command it runs, or null when the
 * gate does not apply (a read, a search, an MCP call, a tool it does not know). `tool` is the client's tool name, sent
 * to the server for its log line.
 * @param {string} client a client.mjs CLIENTS id
 * @param {Record<string, unknown>} input the hook's stdin
 */
export function gateCall(client, input, platform = process.platform) {
  if (!isRecord(input)) {
    return null;
  }
  if (client === "cursor") {
    return cursorCall(input, platform);
  }
  const name = typeof input.tool_name === "string" ? input.tool_name : typeof input.toolName === "string" ? input.toolName : null;
  if (name === null) {
    return null;
  }
  const toolInput = objectOf(input.tool_input ?? input.toolArgs);
  if (client === "codex") {
    return codexCall(name, toolInput, platform);
  }
  if (client === "gemini-cli") {
    return geminiCall(name, toolInput, platform);
  }
  if (client === "copilot") {
    return copilotCall(name, toolInput);
  }
  return claudeCall(name, toolInput);
}

/** The message an answer shows the agent: the server's, with the warn-mode note after a block that did not stop it. */
function shownMessage(answer, mode) {
  return answer.decision === "block" && mode !== "block" ? `${answer.message} ${WARN_MODE_NOTE}` : answer.message;
}

/**
 * What a client's pre-tool hook prints for a gate answer ("" for nothing; the caller prints the client's quiet output
 * then). A block in block mode denies the call with the server's message where the model reads it; a warn, or a block in
 * warn mode, is a note in front of the call where the client has one, and never an explicit allow, so the person's own
 * permission prompt still runs.
 * - Claude Code and Codex: `hookSpecificOutput` with `permissionDecision: "deny"`, or `additionalContext`.
 * - Gemini CLI: `decision: "deny"` with `reason`. BeforeTool has no note the model reads (its `hookSpecificOutput`
 *   only replaces the tool's arguments), so a warn prints nothing.
 * - Copilot CLI: `permissionDecision: "deny"` with `permissionDecisionReason`; no note either. Never `ask`: Copilot's
 *   autopilot reads it as a deny.
 * - Cursor: `permission: "deny"` with `agent_message` (the model's) and `user_message` (the person's); no note either.
 * Where a client has no note, a warn's teammates still reach the agent through the prompt hook's news and recall.
 */
export function gateOutputFor(client, answer, mode) {
  if (mode === "off" || !isRecord(answer) || typeof answer.message !== "string" || !["warn", "block"].includes(answer.decision)) {
    return "";
  }
  const deny = answer.decision === "block" && mode === "block";
  const message = shownMessage(answer, mode);
  if (client === "claude-code" || client === "codex") {
    return gateOutput(answer, mode);
  }
  if (client === "gemini-cli") {
    return deny ? `${JSON.stringify({ decision: "deny", reason: message })}\n` : "";
  }
  if (client === "copilot") {
    return deny ? `${JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: message })}\n` : "";
  }
  if (client === "cursor") {
    return deny ? `${JSON.stringify({ permission: "deny", user_message: "KoalaFix: check in before this edit.", agent_message: message })}\n` : "";
  }
  return "";
}

/**
 * The repository paths an edit's files are, relative to `root` (the git top level), through symlinks and junctions as
 * Claude Code's are. An editor's `/c:/...` form and a `file:` URI read as the path they name (client.mjs folderPath); a
 * relative file is read against the folder the client says the agent works in (`cwd`, when absolute), else `folder`,
 * the project. Files outside the repository, or longer than the wire allows, are left out; null when none is left.
 * @param {readonly string[]} files
 * @param {string} root
 * @param {string} folder
 * @param {unknown} [cwd]
 * @param {string} [platform]
 */
export function editFilePaths(files, root, folder, cwd = null, platform = process.platform) {
  const base = folderPath(cwd, platform) ?? folder;
  const paths = new Set();
  for (const file of files) {
    const relative = relativeTo(realPath(path.resolve(base, folderPath(file, platform) ?? file)), root);
    if (relative !== null && relative !== "" && relative.length <= MAX_PATH_CHARS) {
      paths.add(relative);
    }
    if (paths.size === MAX_PATHS) {
      break;
    }
  }
  return paths.size === 0 ? null : [...paths];
}

/** The shell command as the Claude Code tool input shell-writes.mjs reads, with the folder the client says it runs in. */
export function shellInput(call, input, platform = process.platform) {
  const cwd = isRecord(input) ? (folderPath(input.cwd, platform) ?? (typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined)) : undefined;
  return { ...(cwd === undefined ? {} : { cwd }), tool_name: call.shell === "powershell" ? "PowerShell" : "Bash", tool_input: { command: call.command } };
}
