#!/bin/sh
# SPDX-License-Identifier: LicenseRef-KoalaFix-Proprietary
# Copyright 2026 KoalaFix PTY LTD

# Starts one KoalaFix hook script with Node, for a client that runs hooks through sh (Codex on macOS and Linux).
#   sh run.sh <session-start|prompt|stop|session-end> [the script's flags]
# A desktop app started from the Dock or Finder hands its hooks a short PATH (/usr/bin:/bin:/usr/sbin:/sbin) that
# misses a Node from Homebrew, nvm, Volta, fnm, asdf or mise, so this also looks in those places. With no Node at
# all it prints what the client needs to read "no change" and exits 0: a hook never blocks or breaks a session.
# It reads nothing and sends nothing itself; stdin passes straight to the script.

hook=$1
shift 2>/dev/null
case $hook in
  session-start | prompt | stop | session-end) ;;
  *)
    echo "koalafix: run.sh was given no known hook" >&2
    exit 0
    ;;
esac
here=$(cd -- "$(dirname -- "$0")" && pwd) || exit 0

quiet() {
  # Codex, Cursor and Gemini CLI read stdout as JSON, so "nothing to add" is {} for them.
  for arg in "$@"; do
    case $arg in codex | cursor | gemini-cli) printf '{}\n' && return ;; esac
  done
}

node=$(command -v node 2>/dev/null)
if [ -z "$node" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      node=$candidate
    fi
  done
fi
if [ -z "$node" ]; then
  echo "koalafix: $hook hook skipped: no Node.js found (KoalaFix hooks need Node 22 or later)" >&2
  quiet "$@"
  exit 0
fi
exec "$node" "$here/$hook.mjs" "$@"
