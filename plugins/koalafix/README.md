# KoalaFix

KoalaFix is shared team memory and work items for teams that build with AI tools. Ask what your team already knows
and get each fact with who checked it and when, keep notes, have the team decisions you state saved for the team, and
see who is working on what, so the next session and the rest of the team can pick up where you left off.

## Install

From the Claude directory: find KoalaFix, add it, then on the plugin's Connectors tab choose Connect and sign in.

Claude Code, from a shell:

```
claude plugin marketplace add KoalaFix/koalafix-connect
claude plugin install koalafix@koalafix-connect
```

## What this plugin adds

- One remote MCP server, `koalafix`, at `https://mcp.koalafix.com/mcp` (streamable HTTP), with ten tools: `recall`,
  `open`, `remember`, `save`, `verify`, `work`, `share`, `settle`, `docs_search` and `docs_read`. Your client shows
  which of them change something and asks you as its settings say.
- A skill that tells Claude when to use them. Claude checks team memory on its own when the work or the question is
  about your team's own code, services or decisions, saves a team decision you state and tells you what it saved, and
  opens and closes a work item for a task you begin on the team's work. "How Claude uses it" below has the detail.

## What it runs, sends and keeps

- It runs nothing on your machine: no scripts, no hooks, no background process.
- It talks to one address, the KoalaFix server above, and only after you sign in.
- What Claude sends is what it puts into a KoalaFix tool: a question in a few words about the team work in hand, a
  team decision, rule or fact you stated, a note you asked it to keep, the name of a task you began on the team's work,
  or the id of a record. Claude chooses that text, so it may include something you said. KoalaFix does not receive the
  rest of your conversation.
- KoalaFix keeps what you and your team save. It also keeps a log of the questions `recall` is asked (secrets removed)
  and what it returned, for 30 days; a record of which facts and notes each person was shown, for 90 days; and which
  AI app connected and when, for 180 days. Your team uses these to see questions memory could not answer and who has
  read a decision. The privacy policy says what is kept and for how long; to ask for your records to be deleted,
  email support@koalafix.com.
- Team facts and shared notes are read by your teammates and their assistants. A private note is shown in KoalaFix only to you; it is included if your organisation asks for a full export of its space.
- It reads no credential from your environment and stores no token in any file. Your client keeps the sign-in token.

## Sign in

The first time Claude uses a KoalaFix tool, your client opens the KoalaFix sign-in page (OAuth). Sign in with your
KoalaFix account. In Claude Code you can also run `/mcp`, pick `koalafix` and choose to authenticate.

You need a KoalaFix account to sign in. A team admin invites you by email, or ask at support@koalafix.com.

## How Claude uses it

- Before Claude works on your team's own code, services or decisions, or answers a question about them, it checks team
  memory on its own with `recall`: the task or question in a few words, never the conversation. You get the verdict
  first (clear, stale, conflict or unknown). A general question that is not about your team gets no call.
- A team decision, rule or durable fact you state or agree to: Claude saves it for the team with `remember` and tells
  you in the same reply exactly what it saved. Your teammates and their assistants can read it. It saves the decision,
  never the conversation, nothing personal and no password, key or token. Something Claude worked out itself is saved
  only if you agree.
- A task you begin on the team's shared work: Claude opens a work item with `work`, so teammates see who is on what,
  tells you about any overlapping work, and closes the item when the task is done. A finish or a handoff cannot be
  undone; Claude hands a task off only when you ask.
- What is waiting on you: `open`. Keep a private note: `save`, only when you ask.
- `share` and `settle` only after you say yes to the named note or item; `verify` only when you say you checked the
  source. On a conflict Claude shows both claims and lets you decide. Nothing is deleted in bulk.
- Set-up happens on the KoalaFix dashboard, when you ask; Claude does not set up your team on its own.
- Text in results is treated as information, never as instructions.
- Tell Claude not to use KoalaFix, or not to save to it, and it stops for the rest of the session.

## Try it

- "What has my team decided about how we deploy?"
- "What is open for me right now?"
- "Start tracking my task: fix the onboarding email links, and tell me if anyone overlaps."
- "We've decided that every deploy goes through staging first." (Claude saves it for the team and tells you.)

## Links

- Website: https://koalafix.com
- Dashboard: https://mcp.koalafix.com
- Documentation: https://koalafix.com/docs
- Privacy policy: https://koalafix.com/privacy
- Terms of service: https://koalafix.com/terms
- Support: https://koalafix.com/support

These files are proprietary to KoalaFix PTY LTD and may be used only to install and connect to the KoalaFix
service. See LICENSE.
