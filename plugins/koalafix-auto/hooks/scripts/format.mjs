// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// What the hooks print, kept apart from the scripts so it can be tested without running a hook. The inputs are the
// real server's shapes: the session brief is plain text (Part A 4.6), and `open` answers `structuredContent`
// `{ items: OpenItemLine[] }` (packages/core/src/contract/tools-io.ts).

import { defuse, framed, framedRules } from "./memory-frame.mjs";

/** Claude Code caps a hook's context at 10,000 characters; the hook stays under it. */
export const MAX_CONTEXT_CHARS = 9500;

const CUT_LINE = "[KoalaFix: the brief was cut to fit the hook limit. recall() and open() return the rest.]";

/** How many open items the Stop line names before it says how many more there are. */
export const SHOWN_ITEMS = 3;

/**
 * The brief's lines that are KoalaFix's own words, not team memory, word for word as the server writes them
 * (mcp-server brief.ts): they stay outside the frame (KOA2-381). Exact lines only, so a teammate's text that merely
 * starts like one stays inside; a server that rewords one just has it framed, which is the safe way to be wrong.
 */
const OWN_LINES = new Set([
  "KoalaFix session brief",
  'Going deeper: recall(about: "...") for a topic, recall(id: "...") for one record in full, open(for: "team") for everything open.',
  'How KoalaFix itself works (ranks, rules, plans, refusals): docs_search(query: "..."), then cite the page.',
]);

/**
 * The set-up line, for a space slug as the server makes them, or the server's own fallback name: run the mission (an
 * admin's yes, or a member's own line), or ask the admin once (KOA2-544, KOA2-545). Both wordings of the ask are
 * taken, so a hook still knows the line from a server on either release.
 */
const SETUP_LINE =
  /^Set-up is not finished for (?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?|your space): (?:call open\(\) and (?:run its setup mission now, without waiting to be asked|ask the person once whether to set it up now, as its setup mission says)|ask the person once whether to set it up now; open\(\) says how to keep the answer)\.$/;

function ownLine(line) {
  return OWN_LINES.has(line) || SETUP_LINE.test(line);
}

/** The brief's heading for the team's confirmed rules, word for word as the server writes it (mcp-server brief-rules.ts). */
export const RULES_HEADING = "Standing rules (confirmed by the team; follow them):";

/**
 * The confirmed rules out of the memory lines: the lines under RULES_HEADING up to the next blank line (ADR-0064). Only
 * the server writes that exact line: a teammate's text in a brief always starts "- ", so it cannot fake the heading.
 */
function takeRules(memory) {
  const at = memory.indexOf(RULES_HEADING);
  if (at === -1) {
    return { rules: [], rest: memory };
  }
  let end = at + 1;
  while (end < memory.length && memory[end] !== "") {
    end++;
  }
  return { rules: memory.slice(at + 1, end), rest: [...memory.slice(0, at), ...memory.slice(end + 1)] };
}

/** The brief as KoalaFix's lines at its head (title, set-up line), the team memory, and KoalaFix's lines at its foot. */
function splitBrief(brief) {
  const lines = brief.split(/\r?\n/);
  let head = 0;
  while (head < lines.length && (lines[head] === "" || ownLine(lines[head]))) {
    head++;
  }
  let foot = lines.length;
  while (foot > head && (lines[foot - 1] === "" || ownLine(lines[foot - 1]))) {
    foot--;
  }
  return { before: lines.slice(0, head), memory: lines.slice(head, foot), after: lines.slice(foot) };
}

/**
 * The SessionStart context: the server's brief with its team memory (facts, decisions, disputes, teammates' work, open
 * items) inside the data frame and KoalaFix's own lines outside it (memory-frame.mjs, KOA2-381). The same brief gives
 * the same bytes, so the client's prompt cache holds. Cut to at most 9,500 characters only if a server sends more
 * than its own 2,000-token cap, inside the frame, which still closes. The standing rules the team confirmed go first,
 * in their own frame (ADR-0064), and are never cut.
 */
export function buildContext(brief) {
  const { before: head, memory: all, after } = splitBrief(brief);
  const { rules, rest: memory } = takeRules(all);
  const before = [...head, ...framedRules(rules)];
  const whole = framed(before, memory, after);
  if (whole.length <= MAX_CONTEXT_CHARS) {
    return whole;
  }
  const tail = [...after, CUT_LINE];
  const room = MAX_CONTEXT_CHARS - framed(before, [""], tail).length;
  let cut = memory.map(defuse).join("\n").slice(0, Math.max(0, room));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1); // do not end on half of a surrogate pair
  }
  return framed(before, [cut], tail);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One field of an item as plain one-line text, at most `max` characters. */
function field(item, name, max) {
  const value = item[name];
  if (typeof value !== "string") {
    return "";
  }
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function itemLabel(item) {
  if (!isRecord(item)) {
    return "?";
  }
  const what = field(item, "what", 80);
  return `${field(item, "id", 40)} ${field(item, "kind", 20)}${what === "" ? "" : `: ${what}`}`;
}

/** Where the rest of the Stop line's items are, with the hook's own filter (stop.mjs OPEN_ARGS). */
const MORE = 'open(for: "me", kind: ["dispute", "rule_review", "handoff"])';

/**
 * The Stop hook's one stderr line from an `open` result (KOA2-545): the items that need the person (the hook asks for
 * disputes, rule reviews and handoffs only) and that this session has not named yet, the first few as
 * `<id> <kind>: <what>`. `told` is what earlier turns named, or null when the session has no key. An empty line when
 * nothing new needs them, so a session hears about each item once, not after every turn. `limit` is what the hook asked
 * for; a full page means there may be more. `named` is every id the line counts, for the next turn's `told`.
 *
 * @param {readonly string[] | null} [told]
 */
export function needsYouLine(result, limit, told = null) {
  const items = isRecord(result.structured) && Array.isArray(result.structured.items) ? result.structured.items : null;
  if (items === null) {
    return { line: "koalafix: open answered without an item list", named: [] };
  }
  const known = new Set(told ?? []);
  const fresh = items.filter((item) => !(isRecord(item) && typeof item.id === "string" && known.has(item.id)));
  if (fresh.length === 0) {
    return { line: "", named: [] };
  }
  const count = items.length >= limit ? `${fresh.length} or more items need` : `${fresh.length} item${fresh.length === 1 ? " needs" : "s need"}`;
  const shown = fresh.slice(0, SHOWN_ITEMS).map(itemLabel).join("; ");
  const rest = fresh.length > SHOWN_ITEMS ? `; ${fresh.length - SHOWN_ITEMS} more in ${MORE}` : "";
  const named = fresh.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []));
  return { line: `koalafix: ${count} you: ${shown}${rest}`, named };
}
