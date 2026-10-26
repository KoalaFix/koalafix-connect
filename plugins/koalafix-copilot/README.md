# KoalaFix for GitHub Copilot

KoalaFix team memory in GitHub Copilot: Copilot CLI, the GitHub Copilot app and VS Code's Copilot agent. One plugin
brings three things:

- **The KoalaFix MCP server**, `https://mcp.koalafix.com/mcp`, with its seven tools.
- **The session routine** as a skill: recall before you act, start and finish work, remember what the team decides.
- **Hooks that make it automatic:**
  - **Session start:** the team's brief (facts, open items) goes in front of the session.
  - **Each prompt:** one recall about what you asked, added after your prompt where the model reads it. Later
    prompts add only what this session has not been shown. "ok" or "continue" asks the server nothing.
  - **Stop and session end:** the same stop and session-end scripts as `koalafix-auto`. Today they tidy the
    session's state and add nothing to the chat. When those scripts hold a turn (for example, to ask the agent to save
    a decision), Copilot honours it.
  - **First use:** with no KoalaFix credential on the machine, the agent shows you a sign-in link and a code. Approve
    it once in the browser and the hooks turn on by themselves.

## Install

### Copilot CLI

```
copilot plugin marketplace add KoalaFix/koalafix-connect
copilot plugin install koalafix-copilot@koalafix-connect
```

Inside a session the same works as `/plugin marketplace add KoalaFix/koalafix-connect`, then
`/plugin install koalafix-copilot@koalafix-connect`. Start a new session afterwards.

### VS Code

In a Copilot chat session, type:

```
/plugin marketplace add KoalaFix/koalafix-connect
/plugin install koalafix-copilot@koalafix-connect
```

VS Code asks you to trust the marketplace the first time. A plugin you installed with Copilot CLI shows up in VS Code
by itself. VS Code's hooks are a preview feature.

### GitHub Copilot app

Open **Customize**, then **Plugins**, add the marketplace `KoalaFix/koalafix-connect` with the icon next to the
marketplace list, and install `koalafix-copilot`.

## Sign in

The MCP server signs you in with OAuth. In Copilot CLI, run `/mcp auth koalafix` in a session if the browser does
not open by itself. A session started with `copilot -p` cannot sign in, so it skips KoalaFix's tools until you have
signed in once in a normal session. The hooks use their own sign-in: the link and code the agent shows you on first
use. Both sign-ins use the same KoalaFix account.

**When the browser sign-in cannot run** (a server with no browser, or a company policy that blocks it), use a token:

1. Make a personal token on the dashboard's Account page: https://mcp.koalafix.com, then Account, then Personal
   tokens.
2. Turn off the plugin's server and add one that sends the token. The plugin's `koalafix` entry would win over one
   of the same name, so the token server gets its own name:

   ```
   copilot mcp disable koalafix
   copilot mcp add --transport http --header "Authorization: Bearer <your token>" koalafix-token https://mcp.koalafix.com/mcp
   ```

   This writes the token into `~/.copilot/mcp-config.json`, never into a project.

## What the hooks run and send

- One Node.js script (Node 22 or later), `hooks/copilot.mjs`, for each Copilot event. It runs the same scripts as
  the `koalafix-auto` plugin for Claude Code, Codex and Cursor (`hooks/scripts/`, an exact copy) and only changes
  the shape of what they print into the field Copilot reads. Without Node the hooks do nothing and Copilot logs one
  hook error.
- They read your own KoalaFix credential from `~/.kalibrate/credentials.json` and send it only to the exact server it
  was issued for. They send that server your prompt's text for the recall (up to 2,000 characters, anything shaped
  like a token or key taken out, marked so the server keeps no log of it). They never send the rest of what Copilot
  gives the model (files, the date, attachments).
- The recall goes after your prompt in the content the model receives, so the model reads it as part of your
  message, and Copilot keeps it in the session history. The block says it was added by a hook. The prompt you see in
  the timeline is unchanged. When Copilot sends several queued messages at once, each gets its own recall.
- They contain no token. Every hook gives up silently on any problem (no Node, no credential, a server down or slow),
  and a prompt waits under two seconds for the recall even when the server is down (about 0.4 seconds when it is up,
  measured on Windows).

## Limits

- Tested on Copilot CLI. VS Code and the GitHub Copilot app run the same Copilot hook runtime, according to GitHub's
  and VS Code's docs. VS Code's hooks are a preview feature.
- **Session sandbox:** with Copilot CLI's session sandbox on, a plugin hook can read only its own folder, so it cannot
  read `~/.kalibrate/credentials.json` or write its state there, so the hooks give up quietly and the automatic memory
  stays off for that session (the MCP tools still work). To allow it, add your `~/.kalibrate` folder to
  `sandbox.userPolicy` in `~/.copilot/settings.json`. This was read in GitHub's docs, not tested.
- Copilot drops the output of a `userPromptSubmitted` command hook, so the per-prompt recall uses
  `userPromptTransformed`. If another plugin also rewrites the prompt there, Copilot keeps only the last rewrite.
- **Copilot cloud agent:** it runs hooks only from files committed to the repository, and its sandbox has no KoalaFix
  credential, so these hooks do nothing there. Connect the cloud agent to KoalaFix with a token: the dashboard's
  Integrations page has the repository MCP configuration.
- **JetBrains and Visual Studio:** Copilot there runs no hooks. Add the MCP server from the dashboard's Integrations
  page.

## Privacy, terms and support

Privacy policy: https://koalafix.com/privacy. Terms: https://koalafix.com/terms. Support: https://koalafix.com/support.
These files are proprietary to KoalaFix PTY LTD (the hook scripts in `hooks/scripts/` are Apache-2.0, as marked in
each file) and may be used only to install and connect to the KoalaFix service. See LICENSE.
