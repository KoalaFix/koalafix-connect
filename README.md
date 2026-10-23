# KoalaFix Connect

KoalaFix is shared team memory and work items for software teams that build with AI agents, hosted by
KoalaFix as an MCP server. Before an agent acts it recalls what the team already knows, with who checked each
fact and when, and it marks work as started and done so every session and every teammate can pick up where the
last one left off.

This repository holds the files that connect your AI client to KoalaFix: plugin and extension manifests, the
MCP server address and the agent instructions. The KoalaFix service itself is not in this repository.

## What these files do

- Point your client at one remote MCP server, `https://mcp.koalafix.com/mcp` (streamable HTTP). That is the only network
  destination.
- Give the agent the KoalaFix session routine: a skill in Claude Code and Codex, an always-applied rule in
  Cursor, and a context file in Gemini CLI.
- They contain no scripts, no hooks, no tokens and no telemetry, and they run nothing on your machine.

## Install

### Claude Code

```
/plugin marketplace add KoalaFix/koalafix-connect
/plugin install koalafix@koalafix-connect
```

On Claude Code 2.1.275 or later, one step also works:
`/plugin install koalafix --marketplace KoalaFix/koalafix-connect`.

From a shell: `claude plugin marketplace add KoalaFix/koalafix-connect`, then
`claude plugin install koalafix@koalafix-connect`.

### Codex

```
codex plugin marketplace add KoalaFix/koalafix-connect
codex plugin add koalafix@koalafix-connect
```

### Cursor

When KoalaFix is listed in the Cursor Marketplace, choose Add to Cursor on its page. Until then, use the
one-click Cursor button on the Connect page at https://mcp.koalafix.com. A Teams or Enterprise admin can also import this
repository as a team marketplace under Dashboard, Plugins & MCPs.

### Gemini CLI

```
gemini extensions install https://github.com/KoalaFix/koalafix-connect
```

### Other clients

ChatGPT, Claude on the web, desktop and mobile, VS Code, Windsurf, Zed, JetBrains, OpenCode and any other MCP
client: open the Connect page at https://mcp.koalafix.com for a one-click link or a configuration snippet for your client.

## Sign in

KoalaFix uses OAuth on first use. The first time the agent calls a KoalaFix tool, your client opens the
KoalaFix sign-in page in your browser; sign in with your KoalaFix account and approve access. Your client
keeps the token; no file here holds one. To sign in ahead of time:

- Claude Code: run `/mcp`, pick `koalafix`, choose to authenticate.
- Codex: run `codex mcp login koalafix`.
- Gemini CLI: run `/mcp auth koalafix`.

## The routine your agent follows

- At the start of a task: call `recall` with what you are about to do, read the verdict first, then call
  `work` with action `start` naming the task, with its branch, PR or issue as `ref` (or the `paths` you will change) so overlapping work shows up.
- Verdict clear: go. stale: check the source, then `verify`. conflict: stop and show the user both claims.
  unknown: ask the user.
- Learned something durable: `remember`. Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`. Call `open` to see what is still open for you.
- `share` and `settle` only with the user's yes.

Session hooks (a recall brief when a session starts, open items when it stops) are not in this repository.
They are available through the setup on the Connect page at https://mcp.koalafix.com.

## Privacy, terms and support

- Privacy policy: https://koalafix.com/privacy
- Terms of service: https://koalafix.com/terms
- Documentation: https://koalafix.com/docs
- Support: for help with KoalaFix, go to https://koalafix.com/support.

## Licence

These files are proprietary to KoalaFix PTY LTD. You may use them only to install and connect to the
KoalaFix service. See [LICENSE](LICENSE).

## Repository layout

| Path | For |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code marketplace |
| `.agents/plugins/marketplace.json` | Codex marketplace |
| `.cursor-plugin/marketplace.json` | Cursor marketplace |
| `plugins/koalafix/` | The plugin: Claude, Codex and Cursor manifests, `.mcp.json`, skill, Cursor rule, icons |
| `gemini-extension.json`, `GEMINI.md` | Gemini CLI extension. Both must stay at the repository root: the Gemini CLI extensions gallery only indexes a root `gemini-extension.json` (plus the GitHub topic `gemini-cli-extension`). |
| `server.json` | Official MCP Registry entry |
| `ICONS.md` | Every icon the listings need |
