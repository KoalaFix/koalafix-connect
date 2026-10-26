# KoalaFix automatic memory

This plugin makes KoalaFix team memory automatic in Claude Code, Cowork, Codex and Cursor. With only the `koalafix`
plugin, the agent recalls and records work when it decides to. With this one, hooks do it on every session:

- **Session start:** the team's brief (facts and open items) goes in front of the session.
- **Each prompt:** one recall about what you asked, inside 1.5 seconds, with the verdict in front of the prompt. On
  the first real prompt the hook also starts a work-in-progress lease, so a teammate on overlapping work shows up.
  Later prompts add only what the session has not been shown.
- **Stop and session end:** what is open for you (a line in the client's hook log), and the lease closed when the
  session ends.
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
  like a token or key taken out, marked so the server keeps no log of it), and the lease: its start, its end and
  its description, which comes from the project ("working in <repo> on <branch>" or the folder name), never from
  your prompt, and **which your teammates see**. They write this session's state and a retry queue under `~/.kalibrate/`.
- They contain no token. The only address in them is the hosted server, where the first browser sign-in goes. They
  never print a token.
- Every hook gives up silently on any problem (no Node, no credential, a server down or slow), and in a project with
  its own `koalafix init` install they do nothing, so nothing runs twice.

## Privacy, terms and support

Privacy policy: https://koalafix.com/privacy. Terms: https://koalafix.com/terms. Support: https://koalafix.com/support.
These files are proprietary to KoalaFix PTY LTD (the hook scripts are Apache-2.0, as marked in each file) and may be
used only to install and connect to the KoalaFix service. See LICENSE.
