---
name: koalafix
description: The KoalaFix team memory routine. Use at the start of every task in a session where the koalafix MCP server is connected, whenever you learn a durable fact or confirm one still holds, and when a task is finished. Covers recall before acting, work start and done, open items, remember and verify, and when share and settle need the user's yes.
---

## KoalaFix (team memory)
This project uses KoalaFix, the team's shared memory, through the `koalafix` MCP server.
- New to KoalaFix here (no team facts yet, or the user asks to set it up): call `open` first and follow
  `onboarding.next`.
- Before you act, and before you answer a question about how this team works, call `recall` with what you are
  about to do or answer, and read the verdict first. Then, at the start of a task, call
  `work` with action `start` naming the task, with its branch, PR or issue as `ref` (or the `paths` you will change) so overlapping work shows up.
- Verdict clear: go. stale: check the source, then `verify`. conflict: stop and show the user both claims.
  unknown: ask the user.
- Learned something durable, or the user decided something (a choice, a rule, a name): `remember` it. A decision
  about the team's shared work (code, conventions, process, ownership, handoffs) goes to lane `team` with kind
  `decision`, in your own words: never quote the user, and leave out anything personal or secret.
  Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`. Call `open` to see what is still open for you.
- `share` and `settle` only with the user's yes.

When KoalaFix hooks are installed, a block marked "added by a hook" already holds a recall (and, in a project set
up with `koalafix init`, a work lease) for this task: use it instead of calling `recall` and `work` again. Without hooks, follow every step yourself.

## Notes
- Every fact comes with a sticker: who checked it, and when. Trust the verdict over your own guess.
- On a conflict, never pick a side yourself. Show both claims and let the user decide; pass their words to `settle`.
- Notes are private by default; a team decision (above) goes to the team lane. `share` makes any other note
  visible to the team, so ask first.
- If a `koalafix` tool returns an authorization error, ask the user to sign in to KoalaFix in their client and try again.
