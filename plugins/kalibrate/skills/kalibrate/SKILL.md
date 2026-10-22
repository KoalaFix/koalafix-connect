---
name: kalibrate
description: The Kalibrate team memory routine. Use at the start of every task in a session where the kalibrate MCP server is connected, whenever you learn a durable fact or confirm one still holds, and when a task is finished. Covers recall before acting, work start and done, open items, remember and verify, and when share and settle need the user's yes.
---

## Kalibrate (team memory)
This project uses Kalibrate, the team's shared memory, through the `kalibrate` MCP server.
- At the start of a task: call `recall` with what you are about to do, read the verdict first, then call
  `work` with action `start` naming the task, with its branch, PR or issue as `ref` (or the `paths` you will change) so overlapping work shows up.
- Verdict clear: go. stale: check the source, then `verify`. conflict: stop and show the user both claims.
  unknown: ask the user.
- Learned something durable: `remember`. Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`. Call `open` to see what is still open for you.
- `share` and `settle` only with the user's yes.

## Notes
- Every fact comes with a sticker: who checked it, and when. Trust the verdict over your own guess.
- On a conflict, never pick a side yourself. Show both claims and let the user decide; pass their words to `settle`.
- Notes are private by default. `share` makes a note visible to the team, so ask first.
- If a `kalibrate` tool returns an authorization error, ask the user to sign in to Kalibrate in their client and try again.
