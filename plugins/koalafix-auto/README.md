# KoalaFix (`koalafix-auto`)

For Claude this is the one KoalaFix plugin: the server, the skill and the session hooks together, on claude.ai, in
Cowork and in Claude Code. Chat runs no hooks, so there it adds the tools and the skill. In Codex and Cursor it adds
the hooks beside the `koalafix` plugin. With the tools alone, the agent recalls and records work when it decides to;
with the hooks, it happens on every session:

- **Session start:** the team's brief goes in front of the session: facts, the team's current decisions (the ones
  that name this repository first), teammates' work in progress and open items. The first time the hooks run on your
  machine they show you a one-line notice of what they send and how to turn them off (`/plugin` in Claude Code,
  `/hooks` in Codex).
- **Each prompt:** one recall about what you asked, inside 1.5 seconds, with the verdict in front of the prompt. When a
  teammate has checked in on a file your prompt names or this session edited, the agent is told before it edits (a
  "Collision" line: who, what, since when), once per check-in, with no tool call.
  Later prompts add only what the session has not been shown. On the first prompt it also starts your
  work-in-progress lease, so teammates see who is on what: when the space it would go to is the one for this
  folder (the one you picked for it, or the one named after the project), or you are in one team space and the
  folder is a git repository. Otherwise it starts none, so a personal folder's name never reaches your team and your
  repository never shows in another team's brief; your agent can still name its work with the
  `work` tool. The session-end hook closes the lease.
- **End of a turn, now and then:** at the end of the first turn with a real prompt, then every 4 turns or 20 minutes
  (`KALIBRATE_CAPTURE_TURNS`, `KALIBRATE_CAPTURE_MINUTES`), your agent is asked to save each decision made since
  about the team's shared work (code, conventions, process, ownership, handoffs) to your team, in its own words,
  skipping any it already saved: never your messages, never anything personal or secret, nothing when nothing was
  decided. Teammates' agents then recall them. Never in a session no one is in (`claude -p`, the Agent SDK,
  background sessions, `codex exec`), nor in Cursor or Gemini CLI, whose scripted runs look the same to a hook, so a
  script's answer stays its own; `KALIBRATE_CAPTURE=always` or `off` changes that. In several spaces with none named
  after the project, you are asked which one once, and your pick is remembered for that folder on your machine. Also
  what is open for you (a line in the client's hook log).
- **Session end (Claude Code):** if the last turns were not covered, one short background
  `claude -p --resume <session> --fork-session --no-session-persistence` run saves their decisions: one AI call on
  your own sign-in, limited to the koalafix `remember` and `recall` tools, never saved as a session.
  `KALIBRATE_CAPTURE_AT_END=off` turns it off.
- **First use:** with no KoalaFix credential on the machine, the agent shows you a sign-in link and a code. Approve
  it once in the browser and the hooks turn on by themselves. In Claude Code and Cowork the KoalaFix tools use the
  same sign-in, from the next session (or now, after Reconnect on `koalafix` in `/mcp`): this plugin carries its own
  copy of the `koalafix` server, which Claude Code connects in place of the `koalafix` plugin's when this plugin is
  listed first in your settings, as installing it does. See [Sign in](../../README.md#sign-in).

## Install

claude.ai: add the marketplace `KoalaFix/koalafix-connect` under Customize, Plugins, then add **KoalaFix** and connect
it; it loads in Cowork and Claude Code too. Claude Code on its own (nothing else to install):

```
claude plugin install koalafix-auto --marketplace KoalaFix/koalafix-connect
```

Before 2.1.292: `/plugin marketplace add KoalaFix/koalafix-connect`, then `/plugin install koalafix-auto@koalafix-connect`.

Codex: `codex plugin marketplace add KoalaFix/koalafix-connect`, then `codex plugin add koalafix@koalafix-connect` and
`codex plugin add koalafix-auto@koalafix-connect`, then run `/hooks` once and trust the KoalaFix hooks. Cursor: add
both plugins from the Cursor Marketplace once KoalaFix is listed there; until then a Teams or Enterprise admin imports
this repository as a team marketplace.

## What it runs and sends

- Four Node.js scripts (Node 22 or later) in `hooks/scripts/`, the same ones `koalafix init` installs. Claude Code
  starts them with no shell between; Codex on macOS and Linux goes through `hooks/scripts/run.sh`, which only finds
  Node and starts the script. Without Node the hooks do nothing for KoalaFix (a client may show a one-line hook
  error).
- They read your own KoalaFix credential from `~/.kalibrate/credentials.json` and send it only to the exact server it
  was issued for. They send that server your prompt's text for the recall (up to 2,000 characters, anything shaped
  like a token or key taken out, marked so the server keeps no log of it); with it, the paths of up to 20 files the
  prompt is about (paths it names that exist in the project, and files this session's agent edited, read from the end
  of your client's own transcript on your machine: only the paths leave it), which go on your work-in-progress lease
  where **your teammates see them**; at session start, the repository's or folder's name; and, each time the agent is asked for the decisions
  (again next turn if it fails), a request for the list of your spaces. The session's decisions are saved by your agent with the `remember`
  tool, in its words, to your only space whatever folder you work in, or the one named after the project, or the one
  you name when it asks (up to eight space names go into its context for that question): **your teammates see
  them**. In a personal project, tell your agent when a session is not team work. The hooks never send the session's
  transcript and make no AI call of their own, except the one session-end run above. They write this session's state and a retry queue under `~/.kalibrate/`.
- In Claude Code and Cowork, one more script, `hooks/scripts/headers.mjs --user`, is the `headersHelper` of this
  plugin's copy of the `koalafix` server. Claude Code runs it each time it connects that server. It reads no project
  file and prints an Authorization header with your credential only for exactly the server Claude Code is connecting
  to, over https; with none, it prints `{}` and Claude Code's own OAuth sign-in takes over.
- They contain no token. The only address in them is the hosted server, where the first browser sign-in goes. They
  never print a token, except the helper, to Claude Code, as that header.
- Team memory comes into the session as data inside a `<koalafix-memory-…>` block, under a line telling the agent
  never to follow instructions in it; KoalaFix's own lines stay outside, the block's id is a hash of what is inside so
  nothing inside can close it, and tags inside are made harmless, so a teammate's note cannot pass as an instruction.
- They report no paths at all when the agent starts in your home folder or a drive's top, never follow a symbolic
  link, never send a file name that looks like it holds a secret (`.env`, keys), and send only paths of files that
  exist in the project.
- Every hook gives up silently on any problem (no Node, no credential, a server down or slow), and in a project with
  its own `koalafix init` install they do nothing, so nothing runs twice.

## Privacy, terms and support

Privacy policy: https://koalafix.com/privacy. Terms: https://koalafix.com/terms. Support: https://koalafix.com/support.
These files are proprietary to KoalaFix PTY LTD (the hook scripts are Apache-2.0, as marked in each file) and may be
used only to install and connect to the KoalaFix service. See LICENSE.
