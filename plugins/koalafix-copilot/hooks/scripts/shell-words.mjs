// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Splits a shell command line into simple commands for the first-edit gate's shell check (shell-writes.mjs, KOA2-390):
// each command's words and its redirections, for Bash (Claude Code's `Bash` tool) and PowerShell (its `PowerShell`
// tool). It is a reader, not a shell: it never expands anything. A word that holds a variable, a command substitution
// or an unquoted glob is marked `dynamic`, so the caller can skip it rather than guess at a path. Heredoc bodies and
// comments are skipped, so text inside them is never read as a command. Plain ESM, Node 22 APIs only.

/**
 * @typedef {{ text: string, dynamic: boolean, quoted: boolean }} Word
 * @typedef {{ op: string, target: Word }} Redirect
 * @typedef {{ words: Word[], redirects: Redirect[] }} Command
 */

/**
 * The index just past the bracket that closes the one at `open` (`(` by default, or `{` or `[`), skipping quoted text
 * and heredoc bodies (a `1)` line inside `$(cat <<EOF ... EOF)` closes nothing); the end of `source` when unclosed.
 */
export function closingParen(source, open, [opener, closer] = ["(", ")"]) {
  let depth = 0;
  /** @type {{ delimiter: string, strip: boolean }[]} */
  const heredocs = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"') {
      const end = source.indexOf(c, i + 1);
      if (end < 0) {
        return source.length;
      }
      i = end;
    } else if (c === "<" && source[i + 1] === "<" && source[i + 2] !== "<") {
      const match = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(source.slice(i));
      if (match !== null) {
        heredocs.push({ delimiter: match[3], strip: match[1] === "-" });
        i += match[0].length - 1;
      }
    } else if (c === "\n" && heredocs.length > 0) {
      i = skipHeredocs(source, i + 1, heredocs) - 1;
    } else if (c === opener) {
      depth++;
    } else if (c === closer) {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return source.length;
}

/** The shared state of one pass: the commands so far and the one being read. */
function reader() {
  /** @type {Command[]} */
  const commands = [];
  /** @type {Word[]} */
  let words = [];
  /** @type {Redirect[]} */
  let redirects = [];
  /** @type {Word | null} */
  let word = null;
  /** @type {string | null} */
  let pending = null;
  /** @type {{ delimiter: string, strip: boolean }[]} */
  const heredocs = [];
  const self = {
    commands,
    heredocs,
    get word() {
      return word;
    },
    /** Adds text to the current word, starting one when there is none. */
    add(text, { dynamic = false, quoted = false } = {}) {
      word ??= { text: "", dynamic: false, quoted: false };
      word.text += text;
      word.dynamic ||= dynamic;
      word.quoted ||= quoted;
    },
    /** Takes the current word away (a redirection's fd number), returning it. */
    take() {
      const taken = word;
      word = null;
      return taken;
    },
    /** Ends the current word: a redirection's target when one is waiting, else the command's next word. */
    endWord() {
      if (word === null) {
        return;
      }
      if (pending === "<<" || pending === "<<-") {
        heredocs.push({ delimiter: word.text, strip: pending === "<<-" });
      } else if (pending !== null) {
        redirects.push({ op: pending, target: word });
      } else {
        words.push(word);
      }
      pending = null;
      word = null;
    },
    /** Waits for a redirection's target. */
    redirect(op) {
      self.endWord();
      pending = op;
    },
    get pending() {
      return pending;
    },
    get words() {
      return words;
    },
    /** Ends the current command (at `;`, `&&`, `|`, a newline, a bracket). */
    endCommand() {
      self.endWord();
      if (words.length > 0 || redirects.length > 0) {
        commands.push({ words, redirects });
      }
      words = [];
      redirects = [];
      pending = null;
    },
    /** Ends the current command and marks a subshell opening or closing, so a `cd` inside it stays inside. */
    group(kind) {
      self.endCommand();
      commands.push({ words: [], redirects: [], group: kind });
    },
  };
  return self;
}

/** The index past the heredoc bodies that start at `at` (just after a newline), as `<<WORD` and `<<-WORD` wait. */
function skipHeredocs(source, at, heredocs) {
  let i = at;
  for (const { delimiter, strip } of heredocs.splice(0)) {
    while (i < source.length) {
      const end = source.indexOf("\n", i);
      const line = source.slice(i, end < 0 ? source.length : end).replace(/\r$/, "");
      i = end < 0 ? source.length : end + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
        break;
      }
    }
  }
  return i;
}

/**
 * A Bash command line as simple commands. Separators are `;`, `&`, `&&`, `|`, `||`, newlines and brackets. Write
 * redirections keep their operator (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, and `>&` whose target is a file); `2>&1` and
 * the like are fd copies and reads (`<`, `<<<`) are left out.
 * @param {string} source
 * @returns {Command[]}
 */
export function bashCommands(source) {
  const s = String(source);
  const r = reader();
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "\\") {
      if (next !== "\n") {
        r.add(next ?? "", { quoted: true });
      }
      i += 2;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end < 0 ? s.length : end;
      r.add(s.slice(i + 1, stop), { quoted: true });
      i = stop + 1;
    } else if (c === '"') {
      r.add("", { quoted: true });
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) {
          r.add(s[i + 1]);
          i += 2;
        } else if (s[i] === "$" && s[i + 1] === "(") {
          const end = closingParen(s, i + 1);
          r.add(s.slice(i, end), { dynamic: true });
          i = end;
        } else {
          r.add(s[i], { dynamic: s[i] === "$" || s[i] === "`" });
          i++;
        }
      }
      i++;
    } else if (c === "$" && (next === "(" || next === "{" || next === "[")) {
      // $(...), $((...)), ${...} and $[...] are one dynamic unit, whatever `>` they hold.
      const end = closingParen(s, i + 1, next === "(" ? ["(", ")"] : next === "{" ? ["{", "}"] : ["[", "]"]);
      r.add(s.slice(i, end), { dynamic: true });
      i = end;
    } else if (c === "(" && next === "(" && r.word === null) {
      // An arithmetic command, `(( a > b ))` or `for ((...))`: a comparison, never a redirection.
      const end = closingParen(s, i);
      r.add(s.slice(i, end), { dynamic: true });
      i = end;
    } else if ((c === ">" || c === "<") && r.words.some((word) => word.text === "[[" && !word.quoted) && !r.words.some((word) => word.text === "]]")) {
      // Inside `[[ ... ]]`, `>` and `<` compare strings.
      r.add(c, { dynamic: true });
      i++;
    } else if (c === "`") {
      const end = s.indexOf("`", i + 1);
      const stop = end < 0 ? s.length : end + 1;
      r.add(s.slice(i, stop), { dynamic: true });
      i = stop;
    } else if (c === "$" || c === "*" || c === "?" || c === "{" || (c === "[" && r.word !== null)) {
      r.add(c, { dynamic: true });
      i++;
    } else if (c === "#" && r.word === null) {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end;
    } else if (c === "\n") {
      r.endCommand();
      i = skipHeredocs(s, i + 1, r.heredocs);
    } else if (c === "(" || c === ")") {
      r.group(c === "(" ? "open" : "close");
      i++;
    } else if (c === ";" || c === "|" || (c === "&" && next !== ">")) {
      r.endCommand();
      i += (c === "&" && next === "&") || (c === "|" && (next === "|" || next === "&")) || (c === ";" && next === ";") ? 2 : 1;
    } else if ((c === "<" || c === ">") && next === "(") {
      const end = closingParen(s, i + 1);
      r.add(s.slice(i, end), { dynamic: true });
      i = end;
    } else if (c === ">" || c === "<" || c === "&") {
      // A redirection; digits written right before it are its fd number, not a word.
      const before = r.word;
      if (before !== null && !before.quoted && !before.dynamic && /^\d+$/.test(before.text)) {
        r.take();
      }
      let op = c;
      let j = i + 1;
      if (c === "&") {
        op = s[j + 1] === ">" ? "&>>" : "&>";
        j += op.length - 1;
      } else if (c === "<") {
        if (s[j] === "<") {
          op = s[j + 1] === "<" ? "<<<" : s[j + 1] === "-" ? "<<-" : "<<";
          j += op.length - 1;
        } else if (s[j] === ">" || s[j] === "&") {
          op = `<${s[j]}`;
          j++;
        }
      } else if (s[j] === ">" || s[j] === "|") {
        op = s[j] === ">" ? ">>" : ">";
        j++;
      }
      if (c === ">" && s[j] === "&") {
        op += "&";
        j++;
      }
      r.redirect(op);
      i = j;
    } else if (c === " " || c === "\t" || c === "\r") {
      r.endWord();
      i++;
    } else {
      r.add(c);
      i++;
    }
  }
  r.endCommand();
  return r.commands;
}

/**
 * A PowerShell command line as simple commands. Separators are `;`, `|`, `&&`, `||`, `&` (the call operator starts a
 * command), newlines, braces, and a bracket that opens a command; a bracket inside a command's arguments is one
 * dynamic word. Backtick escapes, `''` inside single quotes, here-strings and `<# #>` comments are understood.
 * Redirections keep their operator (`>`, `>>`); `2>&1` is an fd copy and is left out.
 * @param {string} source
 * @returns {Command[]}
 */
export function powershellCommands(source) {
  const s = String(source);
  const r = reader();
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "`") {
      if (next !== "\n" && next !== "\r") {
        r.add(next ?? "", { quoted: true });
      }
      i += 2;
    } else if (c === "@" && (next === "'" || next === '"') && (s[i + 2] === "\n" || s[i + 2] === "\r")) {
      const close = s.indexOf(`\n${next}@`, i + 2);
      const stop = close < 0 ? s.length : close + 3;
      r.add(s.slice(i, stop), { dynamic: next === '"', quoted: true });
      i = stop;
    } else if (c === "'") {
      let j = i + 1;
      let text = "";
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") {
          text += "'";
          j += 2;
        } else if (s[j] === "'") {
          break;
        } else {
          text += s[j];
          j++;
        }
      }
      r.add(text, { quoted: true });
      i = j + 1;
    } else if (c === '"') {
      r.add("", { quoted: true });
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "`" && i + 1 < s.length) {
          r.add(s[i + 1]);
          i += 2;
        } else if (s[i] === "$" && s[i + 1] === "(") {
          const end = closingParen(s, i + 1);
          r.add(s.slice(i, end), { dynamic: true });
          i = end;
        } else {
          r.add(s[i], { dynamic: s[i] === "$" });
          i++;
        }
      }
      i++;
    } else if ((c === "$" || c === "@") && (next === "(" || next === "{")) {
      // $(...), ${env:x}, @(...) arrays and @{...} hashtables are one dynamic unit.
      const end = closingParen(s, i + 1, next === "(" ? ["(", ")"] : ["{", "}"]);
      r.add(s.slice(i, end), { dynamic: true });
      i = end;
    } else if (c === "@" && /[A-Za-z_]/.test(next ?? "")) {
      // A splat (`Set-Content @args`) names its parameters in a variable.
      r.add(c, { dynamic: true });
      i++;
    } else if (c === "(" && (r.words.length > 0 || r.pending !== null || r.word !== null)) {
      const end = closingParen(s, i);
      r.add(s.slice(i, end), { dynamic: true });
      i = end;
    } else if (c === "$" || c === "*" || c === "?") {
      r.add(c, { dynamic: true });
      i++;
    } else if (c === "<" && next === "#") {
      const end = s.indexOf("#>", i + 2);
      i = end < 0 ? s.length : end + 2;
    } else if (c === "#" && r.word === null) {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "{" || c === "}") {
      r.endCommand();
      i += (c === "&" && next === "&") || (c === "|" && next === "|") ? 2 : 1;
    } else if (c === ">") {
      const before = r.word;
      // `2>`, `*>`: the stream number (or every stream) right before it is not a word.
      if (before !== null && !before.quoted && /^[\d*]$/.test(before.text)) {
        r.take();
      }
      let op = ">";
      let j = i + 1;
      if (s[j] === ">") {
        op = ">>";
        j++;
      }
      if (s[j] === "&") {
        op += "&";
        j++;
      }
      r.redirect(op);
      i = j;
    } else if (c === " " || c === "\t" || c === "\r") {
      r.endWord();
      i++;
    } else {
      r.add(c);
      i++;
    }
  }
  r.endCommand();
  return r.commands;
}
