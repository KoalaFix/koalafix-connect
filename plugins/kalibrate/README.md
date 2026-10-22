# Kalibrate

Kalibrate is shared team memory and work items for software teams that build with AI agents. Before an agent
acts it recalls what the team already knows, with who checked each fact and when, and it marks work as started
and done so the next session and the rest of the team can pick up where it left off.

## Install

Claude Code 2.1.275 or later, in one step:

```
/plugin install kalibrate --marketplace KoalaFix/kalibrate-connect
```

Or add the marketplace first, then install:

```
/plugin marketplace add KoalaFix/kalibrate-connect
/plugin install kalibrate@kalibrate-connect
```

Codex: `codex plugin marketplace add KoalaFix/kalibrate-connect`, then `codex plugin add kalibrate@kalibrate-connect`.

## What this plugin adds

- One remote MCP server, `kalibrate`, at `https://HOST/mcp` (streamable HTTP). It gives the agent seven tools:
  `recall`, `open` and `verify` to read and confirm, and `remember`, `work`, `share` and `settle` to write.
- The Kalibrate session routine, as a skill (Claude Code and Codex) and as an always-applied rule (Cursor).

## What it runs and sends

- It runs nothing on your machine: no scripts, no hooks, no background process.
- It talks to one address, the Kalibrate server above, and only after you sign in. What the agent sends is
  what it passes to the Kalibrate tools: the task it is about to do, notes it saves, and work items it opens
  and closes.
- It reads no credential from your environment and stores no token in any file. Your client keeps the sign-in
  token itself.

## Sign in

The first time the agent uses a Kalibrate tool, your client opens the Kalibrate sign-in page (OAuth). Sign in
with your Kalibrate account and approve access. In Claude Code you can also run `/mcp`, pick `kalibrate` and
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
They are available through the setup on the Connect page at https://HOST.

## Links

- Website and Connect page: https://HOST
- Documentation: https://HOST/docs
- Privacy policy: https://HOST/privacy
- Terms of service: https://HOST/terms
- Support: https://HOST/support

These files are proprietary to KoalaFix PTY LTD and may be used only to install and connect to the Kalibrate
service. See LICENSE.
