---
name: koalafix
description: The KoalaFix team memory routine. Use at the start of every task in a session where the koalafix MCP server is connected, whenever you learn a durable fact or confirm one still holds, and when a task is finished. Covers recall before acting, work start and done, open items, remember and verify, and when share and settle need the user's yes.
---

## KoalaFix (team memory)
This project uses KoalaFix, the team's shared memory, through the `koalafix` MCP server.
- On your first KoalaFix call in a chat or session, and whenever the user asks to set up: call `open` first.
  When it returns `setup` with `answer: "yes"`, or for a member's own line, run that mission now: read
  KoalaFix's own check-ins and team facts first, map every person already in the space (never wait for anyone
  to connect), show one review with one short question list, and apply it in one `remember({ setup })` with
  the user's yes word for word in `user_words`. On that yes, invites at member or new rank and member rank
  changes apply straight away, each with a 7-day undo; a lead rank waits for that person's own yes. When it
  returns `setup` with no answer yet, ask the user once whether to set it up now and store the answer at once
  with `remember({ setup: { answer: "yes" } })` or `remember({ setup: { answer: "no" } })`, and never ask
  again. With no `setup`, follow `onboarding.next` when there is one.
- Before you act, and before you answer a question about how this team works, call `recall` with what you are
  about to do or answer, and read the verdict first. Then, at the start of a task, call
  `work` with action `start` naming the task, with its branch, PR or issue as `ref` (or the `paths` you will change) so overlapping work shows up.
- Verdict clear: go. stale: check the source, then `verify`. conflict: stop and show the user both claims.
  unknown: ask the user.
- Learned something durable, or the user decided something (a choice, a rule, a name): `remember` it. A decision
  about the team's shared work (code, conventions, process, ownership, handoffs) goes to lane `team` with kind
  `decision`, in your own words: never quote the user (no `user_words`; set-up's one apply is the exception), and leave out
  anything personal or secret.
  Confirmed a fact still holds: `verify`.
- When the task is finished: call `work` with action `done`.
- `share` and `settle` only with the user's yes, and leave open items you were not asked about alone: most close by themselves.

When KoalaFix hooks are installed, a block marked "added by a hook" already holds a recall (and, when the hooks started one, a work
lease) for this task: use it instead of calling `recall` and `work` again. Without hooks, follow every step yourself.

## Notes
- Every fact comes with a sticker: who checked it, and when. Trust the verdict over your own guess.
- On a conflict, never pick a side yourself. Show both claims and let the user decide; pass their words to `settle`.
- Notes are private by default; a team decision (above) goes to the team lane. `share` makes any other note
  visible to the team, so ask first.
- If a `koalafix` tool returns an authorization error, ask the user to sign in to KoalaFix in their client and try again.
