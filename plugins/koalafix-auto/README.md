# KoalaFix automatic memory

This plugin makes KoalaFix team memory automatic in Claude Code, Cowork, Codex and Cursor. With only the `koalafix`
plugin, the agent recalls and records work when it decides to. With this one, hooks do it on every session:

- **Session start:** the team's brief (facts and open items) goes in front of the session.
- **Each prompt:** one recall about what you asked, inside 1.5 seconds, with the verdict in front of the prompt.
  Later prompts add only what the session has not been shown. On the first prompt it also starts your
  work-in-progress lease, so teammates see who is on what: when you are in one team space, or the space it would
  go to is the one for this folder (the one you picked for it, or the one named after the project). Otherwise it
  starts none, so your repository never shows in another team's brief; your agent can still name its work with the
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
  it once in the browser and the hooks turn on by themselves.

## Install

Claude Code (this also installs the `koalafix` plugin):

```
/plugin marketplace add KoalaFix/koalafix-connect
/plugin install koalafix-auto@koalafix-connect
```

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
  like a token or key taken out, marked so the server keeps no log of it), and, each time the agent is asked for the decisions
  (again next turn if it fails), a request for the list of your spaces. The session's decisions are saved by your agent with the `remember`
  tool, in its words, to your only space whatever folder you work in, or the one named after the project, or the one
  you name when it asks (up to eight space names go into its context for that question): **your teammates see
  them**. In a personal project, tell your agent when a session is not team work. The hooks never send the session's
  transcript and make no AI call of their own, except the one session-end run above. They write this session's state and a retry queue under `~/.kalibrate/`.
- They contain no token. The only address in them is the hosted server, where the first browser sign-in goes. They
  never print a token.
- Every hook gives up silently on any problem (no Node, no credential, a server down or slow), and in a project with
  its own `koalafix init` install they do nothing, so nothing runs twice.

## Privacy, terms and support

Privacy policy: https://koalafix.com/privacy. Terms: https://koalafix.com/terms. Support: https://koalafix.com/support.
These files are proprietary to KoalaFix PTY LTD (the hook scripts are Apache-2.0, as marked in each file) and may be
used only to install and connect to the KoalaFix service. See LICENSE.
