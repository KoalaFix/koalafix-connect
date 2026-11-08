# KoalaFix

KoalaFix is shared team memory and work items for software teams that build with AI agents. Before an agent
acts it recalls what the team already knows, with who checked each fact and when, and it marks work as started
and done so the next session and the rest of the team can pick up where it left off.

## Install

This plugin is the one the Claude directory lists. It carries the KoalaFix server and the skill and runs nothing on
your machine. Claude Code, from a shell:

```
claude plugin marketplace add KoalaFix/koalafix-connect
claude plugin install koalafix@koalafix-connect
```

Or inside a session:

```
/plugin install koalafix --marketplace KoalaFix/koalafix-connect
```

On claude.ai, add the marketplace `KoalaFix/koalafix-connect` under Customize, Plugins, then add `koalafix`.

Want team memory to happen on its own in Claude Code (the team brief at session start, a recall on every prompt, a
note before editing a file a teammate is on)? Install `koalafix-auto` from the same marketplace instead. It carries
this plugin's server and skill plus the Claude Code hooks and a headers helper, which run Node.js scripts on your
machine. Install one or the other, not both.

Codex: `codex plugin marketplace add KoalaFix/koalafix-connect`, then `codex plugin add koalafix@koalafix-connect`.

## What this plugin adds

- One remote MCP server, `koalafix`, at `https://mcp.koalafix.com/mcp` (streamable HTTP). It gives the agent seven tools:
  `recall` and `open` to read, and `remember`, `verify`, `work`, `share` and `settle` to write.
- The KoalaFix session routine, as a skill (Claude Code and Codex) and as an always-applied rule (Cursor).

## What it runs and sends

- It runs nothing on your machine: no scripts, no hooks, no background process.
- It talks to one address, the KoalaFix server above, and only after you sign in. What the agent sends is
  what it passes to the KoalaFix tools: the task it is about to do, notes it saves, and work items it opens
  and closes.
- It reads no credential from your environment and stores no token in any file. Your client keeps the sign-in
  token itself.

## Sign in

The first time the agent uses a KoalaFix tool, your client opens the KoalaFix sign-in page (OAuth). Sign in
with your KoalaFix account and approve access. In Claude Code you can also run `/mcp`, pick `koalafix` and
choose to authenticate.

## The routine

- At the start of a task: call `recall` with what you are about to do, read the verdict first, then call
  `work` with action `start` naming the task, with its branch, PR or issue as `ref` (or the `paths` you will change) so overlapping work shows up.
- Verdict clear: go. stale: check the source, then `verify`. conflict: stop and show the user both claims.
  unknown: ask the user.
- Learned something durable: `remember`. A decision about the team's shared work (code, conventions, process,
  ownership, handoffs): `remember` it with kind `decision` and lane `team`, in your own words, never quoting the user (no `user_words`).
  Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`.
- `share` and `settle` only with the user's yes, and leave open items you were not asked about alone: most close by themselves.
- A link between two notes that is wrong (recall lists it under `related`): with the user's yes, drop it with `settle` on one note, `to` the other, action `dismiss`. There is no undo, and the pair is never linked again.

Session hooks (the brief at session start, a recall on every prompt, the session's decisions saved to the team) are not part
of this plugin. In Claude Code, install `koalafix-auto` from the same marketplace instead (it carries this plugin's
server and skill); in Codex and Cursor, install it beside this one.

## Links

- Website: https://koalafix.com
- Dashboard (connect your assistants on its Integrations page): https://mcp.koalafix.com
- Documentation: https://koalafix.com/docs
- Privacy policy: https://koalafix.com/privacy
- Terms of service: https://koalafix.com/terms
- Support: https://koalafix.com/support

These files are proprietary to KoalaFix PTY LTD and may be used only to install and connect to the KoalaFix
service. See LICENSE.
