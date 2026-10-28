// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The one-time notice a person sees the first time KoalaFix's hooks run on their machine (KOA2-381). The plugin's
// README and manifests say the same before install; this says it in the session, before the first prompt is sent,
// with how to turn the hooks off in that client. Shown once per machine: a marker in the KoalaFix home records it, and
// only the session that creates the marker shows it, so two sessions starting together never both do.
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { kalibrateHome } from "./spool.mjs";

/** The marker's name in the KoalaFix home. */
export const NOTICE_MARKER = "hooks-notice.json";

/** How each client that shows a hook's `systemMessage` turns the hooks off. Cursor shows none, so it gets none. */
const TURN_OFF = {
  "claude-code": "Turn them off in /plugin (koalafix-auto).",
  codex: "Turn them off in /hooks.",
  "gemini-cli": "Turn them off with: gemini extensions disable koalafix.",
};

/** What the hooks do and send, in the words the README uses. */
export function noticeText(client) {
  const off = TURN_OFF[client];
  if (off === undefined) {
    return null;
  }
  return [
    "KoalaFix hooks are on (shown once).",
    "At session start they load your team's brief.",
    "On each prompt they send the prompt (keys and tokens taken out, never logged) and the paths of files it names or this session edits to your KoalaFix server,",
    "and teammates see this project's name, branch and those paths while you work.",
    "Some turns end with the agent saving the session's decisions to the team.",
    off,
  ].join(" ");
}

/**
 * The notice to show at this session start, or null: when the client shows none, when it was shown before on this
 * machine, or when the marker cannot be written (a notice that could not be recorded would show at every start).
 */
export function installNotice(client, env = process.env, now = new Date()) {
  const text = noticeText(client);
  if (text === null) {
    return null;
  }
  const file = path.join(kalibrateHome(env), NOTICE_MARKER);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ shown: now.toISOString(), client })}\n`, { mode: 0o600, flag: "wx" });
    return text;
  } catch {
    return null;
  }
}
