# Kalibrate Connect

Kalibrate is shared team memory and work items for software teams that build with AI agents, hosted by
KoalaFix as an MCP server. Before an agent acts it recalls what the team already knows, with who checked each
fact and when, and it marks work as started and done so every session and every teammate can pick up where the
last one left off.

This repository holds the files that connect your AI client to Kalibrate: plugin and extension manifests, the
MCP server address and the agent instructions. The Kalibrate service itself is not in this repository.

## What these files do

- Point your client at one remote MCP server, `https://HOST/mcp` (streamable HTTP). That is the only network
  destination.
- Give the agent the Kalibrate session routine: a skill in Claude Code and Codex, an always-applied rule in
  Cursor, and a context file in Gemini CLI.
- They contain no scripts, no hooks, no tokens and no telemetry, and they run nothing on your machine.

## Install

### Claude Code

```
/plugin marketplace add KoalaFix/kalibrate-connect
/plugin install kalibrate@kalibrate-connect
```

On Claude Code 2.1.275 or later, one step also works:
`/plugin install kalibrate --marketplace KoalaFix/kalibrate-connect`.

From a shell: `claude plugin marketplace add KoalaFix/kalibrate-connect`, then
`claude plugin install kalibrate@kalibrate-connect`.

### Codex

```
codex plugin marketplace add KoalaFix/kalibrate-connect
codex plugin add kalibrate@kalibrate-connect
```

### Cursor

When Kalibrate is listed in the Cursor Marketplace, choose Add to Cursor on its page. Until then, use the
one-click Cursor button on the Connect page at https://HOST. A Teams or Enterprise admin can also import this
repository as a team marketplace under Dashboard, Plugins & MCPs.

### Gemini CLI

```
gemini extensions install https://github.com/KoalaFix/kalibrate-connect
```

### Other clients

ChatGPT, Claude on the web, desktop and mobile, VS Code, Windsurf, Zed, JetBrains, OpenCode and any other MCP
client: open the Connect page at https://HOST for a one-click link or a configuration snippet for your client.

## Sign in

Kalibrate uses OAuth on first use. The first time the agent calls a Kalibrate tool, your client opens the
Kalibrate sign-in page in your browser; sign in with your Kalibrate account and approve access. Your client
keeps the token; no file here holds one. To sign in ahead of time:

- Claude Code: run `/mcp`, pick `kalibrate`, choose to authenticate.
- Codex: run `codex mcp login kalibrate`.
- Gemini CLI: run `/mcp auth kalibrate`.

## The routine your agent follows

- At the start of a task: call `recall` with what you are about to do, read the verdict first, then call
  `work` with action `start` naming the task, with its branch, PR or issue as `ref` (or the `paths` you will change) so overlapping work shows up.
- Verdict clear: go. stale: check the source, then `verify`. conflict: stop and show the user both claims.
  unknown: ask the user.
- Learned something durable: `remember`. Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`. Call `open` to see what is still open for you.
- `share` and `settle` only with the user's yes.

Session hooks (a recall brief when a session starts, open items when it stops) are not in this repository.
They are available through the setup on the Connect page at https://HOST.

## Privacy, terms and support

- Privacy policy: https://HOST/privacy
- Terms of service: https://HOST/terms
- Documentation: https://HOST/docs
- Support: for help with Kalibrate, go to https://HOST/support.

## Licence

These files are proprietary to KoalaFix PTY LTD. You may use them only to install and connect to the
Kalibrate service. See [LICENSE](LICENSE).

## Repository layout

| Path | For |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code marketplace |
| `.agents/plugins/marketplace.json` | Codex marketplace |
| `.cursor-plugin/marketplace.json` | Cursor marketplace |
| `plugins/kalibrate/` | The plugin: Claude, Codex and Cursor manifests, `.mcp.json`, skill, Cursor rule, icons |
| `gemini-extension.json`, `GEMINI.md` | Gemini CLI extension. Both must stay at the repository root: the Gemini CLI extensions gallery only indexes a root `gemini-extension.json` (plus the GitHub topic `gemini-cli-extension`). |
| `server.json` | Official MCP Registry entry |
| `ICONS.md` | Every icon the listings need |

## Before publishing

Replace `HOST` with the public domain in these 9 files: `README.md`, `server.json`, `gemini-extension.json`,
`.claude-plugin/marketplace.json`, `plugins/kalibrate/README.md`, `plugins/kalibrate/.mcp.json`,
`plugins/kalibrate/.claude-plugin/plugin.json`, `plugins/kalibrate/.codex-plugin/plugin.json`,
`plugins/kalibrate/.cursor-plugin/plugin.json`. Then delete this section.
