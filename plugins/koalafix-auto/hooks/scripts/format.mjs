// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// What the hooks print, kept apart from the scripts so it can be tested without running a hook. The inputs are the
// real server's shapes: the session brief is plain text (Part A 4.6), and `open` answers `structuredContent`
// `{ items: OpenItemLine[] }` (packages/core/src/contract/tools-io.ts).

/** Claude Code caps a hook's context at 10,000 characters; the hook stays under it. */
export const MAX_CONTEXT_CHARS = 9500;

const CUT_NOTE = "\n[KoalaFix: the brief was cut to fit the hook limit. recall() and open() return the rest.]";

/** How many open items the Stop line names before it says how many more there are. */
export const SHOWN_ITEMS = 3;

/**
 * The SessionStart context: the server's brief as it is (byte-stable, so the client's prompt cache holds), cut to
 * at most 9,500 characters only if a server sends more than its own 2,000-token cap.
 */
export function buildContext(brief) {
  if (brief.length <= MAX_CONTEXT_CHARS) {
    return brief;
  }
  let cut = brief.slice(0, MAX_CONTEXT_CHARS - CUT_NOTE.length);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1); // do not end on half of a surrogate pair
  }
  return `${cut}${CUT_NOTE}`;
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

/**
 * The Stop hook's one stderr line from an `open` result: how many items are open for the person, and the first
 * few as `<id> <kind>: <what>`. `limit` is what the hook asked for; a full page means there may be more.
 */
export function summarizeOpen(result, limit) {
  const items = isRecord(result.structured) && Array.isArray(result.structured.items) ? result.structured.items : null;
  if (items === null) {
    return "koalafix: open answered without an item list";
  }
  if (items.length === 0) {
    return "koalafix: nothing open for you";
  }
  const count = items.length >= limit ? `${items.length} or more items` : `${items.length} item${items.length === 1 ? "" : "s"}`;
  const named = items.slice(0, SHOWN_ITEMS).map(itemLabel).join("; ");
  const rest = items.length > SHOWN_ITEMS ? `; ${items.length - SHOWN_ITEMS} more in open(for: "me")` : "";
  return `koalafix: ${count} open for you: ${named}${rest}`;
}
