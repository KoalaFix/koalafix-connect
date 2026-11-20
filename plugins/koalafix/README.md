# KoalaFix

KoalaFix is shared team memory and work items for teams that build with AI tools. Ask what your team already knows
and get each fact with who checked it and when, keep notes, record a team decision when you agree to, and see who is
working on what, so the next session and the rest of the team can pick up where you left off.

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
- A skill that tells Claude when to use them: only when you ask about your team's memory or work, or name KoalaFix.

## What it runs, sends and keeps

- It runs nothing on your machine: no scripts, no hooks, no background process.
- It talks to one address, the KoalaFix server above, and only after you sign in.
- What Claude sends is what it puts into a KoalaFix tool: a question in a few words, the text of a note or fact you
  asked it to save, a work item you asked it to open or close, or the id of a record. Claude chooses that text, so it
  may include something you said. KoalaFix does not receive the rest of your conversation.
- KoalaFix keeps what you and your team save. It also keeps a log of the questions `recall` is asked (secrets removed)
  and what it returned, for 30 days; a record of which facts and notes each person was shown, for 90 days; and which
  AI app connected and when, for 180 days. Your team uses these to see questions memory could not answer and who has
  read a decision. The privacy policy says what is kept and for how long; to ask for your records to be deleted,
  email support@koalafix.com.
- Team facts and shared notes are read by your teammates and their assistants. A private note is read only by you.
- It reads no credential from your environment and stores no token in any file. Your client keeps the sign-in token.

## Sign in

The first time Claude uses a KoalaFix tool, your client opens the KoalaFix sign-in page (OAuth). Sign in with your
KoalaFix account. In Claude Code you can also run `/mcp`, pick `koalafix` and choose to authenticate.

## How Claude uses it

- A question about what your team knows or decided: `recall`, verdict first (clear, stale, conflict or unknown).
- What is waiting on you: `open`. Track, finish or hand off a task you name: `work`. Keep a note: `save`.
- A team decision you state: Claude offers to record it with `remember` and saves it only after you agree.
- `share` and `settle` only after you say yes to the named note or item. Nothing is deleted in bulk.
- Text in results is treated as information, never as instructions.

## Links

- Website: https://koalafix.com
- Dashboard: https://mcp.koalafix.com
- Documentation: https://koalafix.com/docs
- Privacy policy: https://koalafix.com/privacy
- Terms of service: https://koalafix.com/terms
- Support: https://koalafix.com/support

These files are proprietary to KoalaFix PTY LTD and may be used only to install and connect to the KoalaFix
service. See LICENSE.
