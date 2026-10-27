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
- Learned something durable: `remember`. A decision about the team's shared work (code, conventions, process,
  ownership, handoffs): `remember` it with kind `decision` and lane `team`, in your own words, never quoting the user (no `user_words`).
  Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`. Call `open` to see what is still open for you.
- `share` and `settle` only with the user's yes.

## Session hooks

With only the `koalafix` plugin, the agent uses team memory when it decides to. The hooks make it automatic:

- **Session start:** the team's brief (facts, open items) goes in front of the session.
- **Each prompt:** one recall about what you asked, in under 1.5 seconds, with the verdict in front of the prompt.
  Later prompts add only what this session has not been shown. "ok" or "continue" asks the server nothing. The
  first prompt also starts your work-in-progress lease, so teammates see who is on what, when the space the server
  files it in is this folder's space: the space you picked for the folder or the one named after the project is your
  home space, or you are in one space and the folder is a git repository. Otherwise it starts none, so a personal
  folder's name never reaches your team and a repository never shows in another team's brief; your agent can still name its work with the `work` tool.
- **End of a turn, now and then:** at the end of the first turn that had a real prompt, then whenever 4 more turns
  or 20 minutes have passed since the last time (`KALIBRATE_CAPTURE_TURNS`, `KALIBRATE_CAPTURE_MINUTES`), the hook
  asks your agent to save each decision made since about the team's shared work (code, conventions, process,
  ownership, handoffs) to your team with `remember`, in the agent's own words, skipping any it already saved. Never
  your messages, never anything personal or secret, and nothing at all when nothing was decided. Your teammates'
  agents then recall those decisions. Only in a session you are in: a `claude -p` run, an Agent SDK program, a
  background session, `codex exec` (Codex is held only in its terminal app, IDE extension and desktop app) and every
  Cursor and Gemini CLI session (their scripted runs look the same to a hook) are never held, so a script gets its own
  answer (`KALIBRATE_CAPTURE=always` turns it on there, `off` turns it off everywhere). In several spaces with none
  named after the project, your agent asks you which one once, and the hook remembers your pick for that folder on
  your machine. The hook also writes what is open for you to the client's hook log (not the chat).
- **Session end:** in Claude Code, when the session ends with turns that were not covered yet, the hook starts one
  short background run, `claude -p --resume <session> --fork-session --no-session-persistence`, that can only call
  the koalafix `remember` and `recall` tools, so the decisions of the last turns are saved too. It is one AI call on
  your own Claude Code sign-in, nothing of it is saved as a session, and your session's own history is left as it
  was; `KALIBRATE_CAPTURE_AT_END=off` turns it off. The lease the hooks started is closed.
- **First use:** with no KoalaFix credential on the machine, the session-start hook starts a browser sign-in and
  the agent shows you a link and a code. Approve it once; the hooks turn on by themselves.

| Client | Where the hooks come from | Events |
|---|---|---|
| Claude Code, Cowork | `koalafix-auto` plugin | SessionStart, UserPromptSubmit, Stop, SessionEnd |
| Codex (CLI and desktop) | `koalafix-auto` plugin, after you trust it in `/hooks` | SessionStart, UserPromptSubmit, Stop, SessionEnd |
| Cursor | `koalafix-auto` plugin (its hooks run from `${CURSOR_PLUGIN_ROOT}`) | sessionStart, beforeSubmitPrompt, stop, sessionEnd |
| Gemini CLI | this extension | SessionStart, BeforeAgent, AfterAgent, SessionEnd |
| claude.ai, Claude desktop and mobile chat, ChatGPT | none: these apps run no hooks | the server's instructions and the skill carry the routine |
| OpenCode | none from here: `koalafix init` writes its compaction plugin and an AGENTS.md block | |

**What they run and send.** The hooks are Node.js scripts (Node 22 or later) in
`plugins/koalafix-auto/hooks/scripts/`, the same scripts `koalafix init` installs, copied from KoalaFix's source by
`scripts/sync-hooks.mjs`. They read your own KoalaFix credential from `~/.kalibrate/credentials.json` (written by the
browser sign-in or `koalafix login`) and send it only to the exact server it was issued for. They send that server:
- your prompt's text for the recall (up to 2,000 characters, with anything shaped like a token or key taken out),
  marked so the server keeps no log of it;
- each time it asks for the decisions, a request for the list of your spaces, to pick where they go (if the
  request fails, it is tried again at the end of the next turn);
- on the first prompt, a request for the list of your spaces, to tell whether your lease would go to this folder's
  space;
- when it starts a lease, the lease's description, built from the project, never from your prompt:
  "working in <repo> on <branch>", or the folder name, with credential shapes taken out. **Your teammates see it** as
  your work in progress; and the lease's start and end.

The decisions themselves are written by your agent with the `remember` tool, in its words, to your team's space:
**your teammates see them**. They go to your only space, whatever folder you work in; if you have several, to the
one named after the project (its repository or folder name); otherwise your agent asks you which space before it
saves anything, and the names of up to eight of your spaces go into its context for that question. What counts as a
team decision is your agent's judgement, so in a personal project, tell it when a session is not team work. The hooks
never send the session's transcript, and make no AI call of their own except Claude Code's one background run at
session end, described above, which runs on your machine with your own sign-in.

They keep this session's state and a retry queue in `~/.kalibrate/`. No file in this repository holds a token. The
only address in them is the hosted server, `https://mcp.koalafix.com`, where the first browser sign-in goes.

**They never get in your way.** Every hook gives up silently on any problem: no Node, no credential, a server that is
down or slow. A prompt waits at most the hook's 1.5 second budget, and no hook blocks a prompt or a tool call. The
exceptions are small: now and then the stop hook asks the agent to save the session's team decisions (one more
step for the agent, which saves nothing when nothing was decided; in Gemini CLI the agent also gives its last answer
again, since Gemini CLI replaces an answer a hook holds), and when the server refuses the work lease the hooks
started, it asks the agent once to start it. In a project that has its own `koalafix init` install, the plugin's hooks do nothing, so nothing runs
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
