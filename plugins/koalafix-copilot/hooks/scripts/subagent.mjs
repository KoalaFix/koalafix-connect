// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// What the SubagentStart hook (subagent-start.mjs) tells a subagent, and which subagents it tells. None of the other
// hooks fire inside a subagent, and the server's instructions reach one only after it has loaded a koalafix tool, so
// without this a subagent never learns that team memory is there. Two lines, no brief: recall with its own task,
// read the verdict, and leave every write to the session that started it.
// Only a subagent that can call recall is told: Claude Code's general-purpose, Explore, Plan and claude agents, and a
// custom agent whose definition gives it the koalafix tools (no `tools` line, which inherits every tool, or a `tools`
// entry naming the server or its recall tool, and no `disallowedTools` entry taking them away). A fixed-tool agent
// (a reviewer with Read, Grep and Bash) is told nothing: the lines would be noise to it. So is an agent whose
// definition cannot be found (a fork, or one an SDK run passed in code).
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./connect.mjs";

/** Claude Code's own agent types that see every MCP tool, the koalafix ones deferred behind ToolSearch. */
export const RECALL_AGENTS = ["general-purpose", "Explore", "Plan", "claude"];

/** The recall tool's name in a koalafix-auto install. */
export const PLUGIN_RECALL_TOOL = "mcp__plugin_koalafix-auto_koalafix__recall";

/**
 * What the subagent is told. The ToolSearch query finds the recall tool under whichever name this install gives it:
 * Claude Code drops a plugin's server when a claude.ai connector or the person's own config has one at the same URL,
 * and the tool is then `mcp__claude_ai_koalafix__recall` or `mcp__koalafix__recall`.
 */
export const SUBAGENT_CONTEXT = [
  `KoalaFix team memory is connected. Before you act on this team's code, services or decisions, load its recall tool with ToolSearch (query "+koalafix recall"; in this plugin it is ${PLUGIN_RECALL_TOOL}), call recall with your own task in a few words as \`about\`, and read its verdict first.`,
  "You are a subagent: never call remember, verify, share, settle or work. The session that started you owns every write to team memory.",
].join("\n");

/**
 * Whether one entry of an agent's `tools` or `disallowedTools` names the koalafix recall tool: `*`, the server
 * (`mcp__<server>`, `mcp__<server>__*`) or the tool itself, for any server whose name holds "koalafix".
 * @param {string} entry
 */
export function namesRecall(entry) {
  if (entry === "*") {
    return true;
  }
  const match = /^mcp__(.+?)(?:__(.+))?$/.exec(entry);
  return match !== null && /koalafix/i.test(match[1]) && (match[2] === undefined || match[2] === "*" || match[2] === "recall");
}

/** A frontmatter list: `a, b` on one line, or `- a` lines under the key. Null when the key is absent. */
function listOf(lines, key) {
  const at = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (at === -1) {
    return null;
  }
  const inline = lines[at].slice(lines[at].indexOf(":") + 1).trim().replace(/^\[|\]$/g, "");
  const items = inline === "" ? [] : inline.split(",");
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item === null) {
      break;
    }
    items.push(item[1]);
  }
  return items.map((item) => item.trim().replace(/^["']|["']$/g, "")).filter((item) => item !== "");
}

/**
 * An agent file's frontmatter: its `name`, `tools` and `disallowedTools` (null when a list is absent), or null when
 * the file has no frontmatter.
 * @param {string} text
 */
export function parseAgent(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) {
    return null;
  }
  const lines = match[1].split(/\r?\n/);
  const nameLine = lines.find((line) => /^name\s*:/.test(line));
  const name = nameLine === undefined ? null : nameLine.slice(nameLine.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
  return { name, tools: listOf(lines, "tools"), disallowed: listOf(lines, "disallowedTools") };
}

/** Whether an agent with this frontmatter can call recall. */
export function grantsRecall(agent) {
  const allowed = agent.tools === null || agent.tools.some(namesRecall);
  return allowed && !(agent.disallowed ?? []).some((entry) => entry !== "*" && namesRecall(entry));
}

/** The definition named `name` among the `.md` files in `dir`, or null. A file that cannot be read is skipped. */
function findIn(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((file) => file.endsWith(".md")).toSorted();
  } catch {
    return null;
  }
  for (const file of entries) {
    try {
      const agent = parseAgent(fs.readFileSync(path.join(dir, file), "utf8"));
      if (agent !== null && (agent.name ?? file.slice(0, -3)) === name) {
        return agent;
      }
    } catch {
      // unreadable: not this one
    }
  }
  return null;
}

/** The folder Claude Code keeps the person's settings in: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env = process.env) {
  const moved = env.CLAUDE_CONFIG_DIR;
  return typeof moved === "string" && moved !== "" ? moved : path.join(os.homedir(), ".claude");
}

/** The agents folders of the installed plugin `plugin` (installed_plugins.json, every install of it). */
function pluginAgentDirs(configDir, plugin) {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(configDir, "plugins", "installed_plugins.json"), "utf8"));
    const plugins = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {};
    return Object.entries(plugins)
      .filter(([id]) => id.split("@")[0] === plugin)
      .flatMap(([, installs]) => (Array.isArray(installs) ? installs : []))
      .map((install) => (isRecord(install) && typeof install.installPath === "string" ? path.join(install.installPath, "agents") : null))
      .filter((dir) => dir !== null);
  } catch {
    return [];
  }
}

/**
 * The definition of the custom agent `agentType`, in Claude Code's order: the project's `.claude/agents`, the
 * person's, then for `plugin:name` that plugin's `agents` folder. Null when none is found.
 * @param {string} agentType
 * @param {string | null} projectDir
 */
export function findAgent(agentType, projectDir, env = process.env) {
  const configDir = claudeConfigDir(env);
  const colon = agentType.indexOf(":");
  if (colon !== -1) {
    const name = agentType.slice(colon + 1);
    for (const dir of pluginAgentDirs(configDir, agentType.slice(0, colon))) {
      const found = findIn(dir, name);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  const dirs = [projectDir === null ? null : path.join(projectDir, ".claude", "agents"), path.join(configDir, "agents")];
  for (const dir of dirs.filter((candidate) => candidate !== null)) {
    const found = findIn(dir, agentType);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * Whether the subagent `agentType` gets the lines: one of Claude Code's own agents that sees every tool, or a custom
 * agent whose definition gives it recall.
 * @param {unknown} agentType the hook input's `agent_type`
 * @param {string | null} projectDir
 */
export function agentGetsRecall(agentType, projectDir, env = process.env) {
  if (typeof agentType !== "string" || agentType === "") {
    return false;
  }
  if (RECALL_AGENTS.includes(agentType)) {
    return true;
  }
  const agent = findAgent(agentType, projectDir, env);
  return agent !== null && grantsRecall(agent);
}

/** What the hook prints for Claude Code: the lines as the subagent's context, or nothing. */
export function subagentOutput(context) {
  return context === null ? "" : `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } })}\n`;
}
