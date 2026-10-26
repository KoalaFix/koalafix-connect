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
- The `koalafix` plugin contains no scripts, no hooks, no tokens and no telemetry, and runs nothing on your machine.
- The optional `koalafix-auto` plugin (Claude Code, Cowork, Codex, Cursor) and the Gemini CLI extension add session
  hooks that make team memory automatic. They run Node.js scripts on your machine; see [Session hooks](#session-hooks).

## Install

### Claude Code

```
/plugin marketplace add KoalaFix/koalafix-connect
/plugin install koalafix-auto@koalafix-connect
```

`koalafix-auto` brings the `koalafix` plugin with it. For the tools without hooks, install `koalafix@koalafix-connect`
instead.

On Claude Code 2.1.275 or later, one step also works:
`/plugin install koalafix --marketplace KoalaFix/koalafix-connect`.

From a shell: `claude plugin marketplace add KoalaFix/koalafix-connect`, then
`claude plugin install koalafix-auto@koalafix-connect`.

### Codex

```
codex plugin marketplace add KoalaFix/koalafix-connect
codex plugin add koalafix@koalafix-connect
codex plugin add koalafix-auto@koalafix-connect
```

Then run `/hooks` in Codex once and trust the four KoalaFix hooks: Codex runs a plugin's hooks only after you
review them, and again after an update changes them.

### Cursor

When KoalaFix is listed in the Cursor Marketplace, choose Add to Cursor on its page. Until then, use the
Add to Cursor button on the dashboard's Integrations page at https://mcp.koalafix.com. A Teams or Enterprise admin can also import this
repository as a team marketplace under Dashboard, Plugins & MCPs. Add `koalafix-auto` from the same marketplace for
the session hooks.

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

## Session hooks

With only the `koalafix` plugin, the agent uses team memory when it decides to. The hooks make it automatic:

- **Session start:** the team's brief (facts, open items) goes in front of the session.
- **Each prompt:** one recall about what you asked, in under 1.5 seconds, with the verdict in front of the prompt. On
  the first real prompt the hook also starts a work-in-progress lease, so teammates see overlapping work. Later
  prompts add only what this session has not been shown. "ok" or "continue" asks the server nothing.
- **Stop and session end:** what is open for you (a line in the client's hook log, not in the chat), and the lease
  closed when the session ends.
- **First use:** with no KoalaFix credential on the machine, the session-start hook starts a browser sign-in and
  the agent shows you a link and a code. Approve it once; the hooks turn on by themselves.

| Client | Where the hooks come from | Events |
|---|---|---|
| Claude Code, Cowork | `koalafix-auto` plugin | SessionStart, UserPromptSubmit, Stop, SessionEnd |
| Codex (CLI and desktop) | `koalafix-auto` plugin, after you trust it in `/hooks` | SessionStart, UserPromptSubmit, Stop, SessionEnd |
| Cursor | `koalafix-auto` plugin (its hooks run from `${CURSOR_PLUGIN_ROOT}`) | sessionStart, beforeSubmitPrompt, stop, sessionEnd |
| Gemini CLI | this extension | SessionStart, BeforeAgent, SessionEnd |
| claude.ai, Claude desktop and mobile chat, ChatGPT | none: these apps run no hooks | the server's instructions and the skill carry the routine |
| OpenCode | none from here: `koalafix init` writes its compaction plugin and an AGENTS.md block | |

**What they run and send.** The hooks are Node.js scripts (Node 22 or later) in
`plugins/koalafix-auto/hooks/scripts/`, the same scripts `koalafix init` installs, copied from KoalaFix's source by
`scripts/sync-hooks.mjs`. They read your own KoalaFix credential from `~/.kalibrate/credentials.json` (written by the
browser sign-in or `koalafix login`) and send it only to the exact server it was issued for. They send that server:
- your prompt's text for the recall (up to 2,000 characters, with anything shaped like a token or key taken out),
  marked so the server keeps no log of it;
- the lease's description: the first line of the session's first prompt, at most 80 characters, credentials taken
  out. **Your teammates see it** as your work in progress;
- the lease's start and end.

They keep this session's state and a retry queue in `~/.kalibrate/`. No file in this repository holds a token. The
only address in them is the hosted server, `https://mcp.koalafix.com`, where the first browser sign-in goes.

**They never get in your way.** Every hook gives up silently on any problem: no Node, no credential, a server that is
down or slow. A prompt waits at most the hook's 1.5 second budget, and no hook blocks a prompt or a tool call. The
one exception is small: when the server refuses the work lease, the stop hook asks the agent once per session to
start it, then never again. In a project that has its own `koalafix init` install, the plugin's hooks do nothing, so nothing runs
twice.

**Node.js.** Claude Code's native installer, the Codex binary and Cursor do not bring Node with them. Without Node the
hooks do nothing for KoalaFix (a client may show a one-line hook error) and the skill, rule or context file still tells the agent the routine. On macOS and Linux, Codex
starts the hooks through `run.sh`, which also finds a Node from Homebrew, nvm, Volta, fnm, asdf or mise that a
desktop app's short PATH misses.

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
| `plugins/koalafix/` | The plugin: Claude, Codex and Cursor manifests, `.mcp.json`, skill, Cursor rule, icons. No hooks, so directories that refuse hooks can list it |
| `plugins/koalafix-auto/` | The session hooks for Claude Code, Codex and Cursor: one hook file per client and the shared scripts |
| `hooks/hooks.json` | The Gemini CLI extension's session hooks (they run the scripts in `plugins/koalafix-auto/`) |
| `scripts/sync-hooks.mjs`, `scripts/hook-configs.mjs` | Copy the hook scripts from KoalaFix's source and write the four hook files from one table |
| `scripts/check.mjs` | The checks before a change ships: hook files in step, scripts unchanged since copied, no secrets, listed plugin hook-free |
| `gemini-extension.json`, `GEMINI.md` | Gemini CLI extension. Both must stay at the repository root: the Gemini CLI extensions gallery only indexes a root `gemini-extension.json` (plus the GitHub topic `gemini-cli-extension`). |
| `server.json` | Official MCP Registry entry |
| `ICONS.md` | Every icon the listings need |
