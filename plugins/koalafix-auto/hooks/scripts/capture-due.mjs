// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors
// The decision capture, delivered to the model only. Claude Code shows a Stop hook's held turn to the person as a
// "Stop hook error" block carrying the whole reason, about 30 lines every few turns (rev 25 walk, 16 Nov 2026). So in
// Claude Code the Stop hook no longer holds the turn for a capture: it leaves the capture due in the session's state,
// and the next prompt hook puts it in front of that prompt as context the person never sees. A session that ends with
// a capture still due gets it from the session-end pass (capture-end.mjs), as an uncovered turn would.
// Plain ESM, Node 22 APIs only, no dependencies.

import { MAX_LISTED_SPACES, RULES, WHAT } from "./capture.mjs";
import { readState, writeState } from "./wip.mjs";

/** The clients whose Stop hook leaves the capture to the next prompt instead of holding the turn. */
export const DUE_CLIENTS = new Set(["claude-code"]);

const HEAD = "KoalaFix (a hook; the person does not see this note):";

/** The capture for the next prompt, for a `pickSpace` answer (capture.mjs). */
export function dueReason(choice) {
  if ("space" in choice) {
    return [
      `${HEAD} before you answer this prompt, ${WHAT}, from the turns before it.`,
      `For each one call the koalafix remember tool with kind "decision", lane "team", space "${choice.space}". ${RULES}`,
      "Then answer the prompt. If you saved any, add one short line saying what you saved to the team; if not, say nothing about this note.",
    ].join(" ");
  }
  const more = choice.ask.length - MAX_LISTED_SPACES;
  const listed = `${choice.ask.slice(0, MAX_LISTED_SPACES).map((slug) => `"${slug}"`).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return [
    `${HEAD} ${WHAT}, from the turns before this prompt. The person is in several KoalaFix spaces (${listed}) and none is named for this project, so do not save yet:`,
    "answer the prompt, then list each decision in one short line and ask the person which space it belongs in (this folder's decisions go there from now on, so they are asked once);",
    `once they answer, call the koalafix remember tool with kind "decision", lane "team" and that space. ${RULES} If nothing team-relevant was decided, or it is already saved, ask nothing.`,
  ].join(" ");
}

/** Takes the capture the Stop hook left due for this session: its text, cleared from the state, or null. */
export function takeDue(key, env = process.env) {
  const state = readState(key, env);
  if (state === null || state.captureDue === null) {
    return null;
  }
  writeState(key, { ...state, captureDue: null }, env);
  return state.captureDue;
}
