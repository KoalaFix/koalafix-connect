# KoalaFix

KoalaFix is shared team memory and work items for software teams that build with AI agents. Before an agent
acts it recalls what the team already knows, with who checked each fact and when, and it marks work as started
and done so the next session and the rest of the team can pick up where it left off.

## Install

Claude Code 2.1.275 or later, in one step:

```
/plugin install koalafix --marketplace KoalaFix/koalafix-connect
```

Or add the marketplace first, then install:

```
/plugin marketplace add KoalaFix/koalafix-connect
/plugin install koalafix@koalafix-connect
```

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
- Learned something durable: `remember`. Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`. Call `open` to see what is still open for you.
- `share` and `settle` only with the user's yes.

Session hooks (a recall brief when a session starts, open items when it stops) are not part of this plugin.
They are available through the connect command on the Integrations page of the KoalaFix dashboard at https://mcp.koalafix.com.

## Links

- Website: https://koalafix.com
- Dashboard (connect your assistants on its Integrations page): https://mcp.koalafix.com
- Documentation: https://koalafix.com/docs
- Privacy policy: https://koalafix.com/privacy
- Terms of service: https://koalafix.com/terms
- Support: https://koalafix.com/support

These files are proprietary to KoalaFix PTY LTD and may be used only to install and connect to the KoalaFix
service. See LICENSE.
