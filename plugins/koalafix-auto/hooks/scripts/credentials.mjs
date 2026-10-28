// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The person's own KoalaFix credential, kept once per user instead of once per project, so a plugin or extension
// install needs no `koalafix init` in each project. `koalafix login` writes it to
// <KALIBRATE_HOME or ~/.kalibrate>/credentials.json:
//   { "version": 1, "default": "https://mcp.koalafix.com", "servers": { "https://mcp.koalafix.com": { "token": "…" } } }
// A token is bound to the server it was issued for: it is only ever sent to that exact origin. A cloned repository
// chooses its own `serverUrl`, so a project pointing somewhere else never gets the person's token.
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { kalibrateHome } from "./spool.mjs";

/**
 * No credential for the server a hook would call: no `.kalibrate/token` and no `koalafix login` token for it. A hook
 * then does nothing at all, at once: nothing printed, no sign-in, no network (client.mjs `locateHook` answers null).
 * Cloud Cowork runs plugin hooks in a container with no sign-in file and no browser, where anything else would wait
 * or nag on every session.
 */
export class NoCredentialError extends Error {
  /** @param {string} [message] */
  constructor(message = "no KoalaFix credential on this machine; run koalafix login") {
    super(message);
    this.name = "NoCredentialError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function credentialsPath(env = process.env) {
  return path.join(kalibrateHome(env), "credentials.json");
}

/** The origin of an http(s) URL (`https://host[:port]`), or null for anything else. */
export function originOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The credentials file as `{ default, servers }`, or null when there is none or it is unreadable. */
export function readCredentials(env = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsPath(env), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.servers)) {
    return null;
  }
  const servers = {};
  for (const [origin, entry] of Object.entries(parsed.servers)) {
    const token = isRecord(entry) && typeof entry.token === "string" ? entry.token.trim() : "";
    if (originOf(origin) === origin && token !== "" && !/\s/.test(token)) {
      servers[origin] = token;
    }
  }
  const fallback = Object.keys(servers).length === 1 ? Object.keys(servers)[0] : null;
  const named = typeof parsed.default === "string" ? originOf(parsed.default) : null;
  return { default: named !== null && named in servers ? named : fallback, servers };
}

/** The person's token for exactly this server's origin, or "" when they have none for it. */
export function userToken(serverUrl, env = process.env) {
  const origin = originOf(serverUrl);
  const credentials = readCredentials(env);
  return origin === null || credentials === null ? "" : (credentials.servers[origin] ?? "");
}

/** The person's default server and its token, for a plugin install with no project config, or null. */
export function userServer(env = process.env) {
  const credentials = readCredentials(env);
  if (credentials === null || credentials.default === null) {
    return null;
  }
  return { serverUrl: credentials.default, token: credentials.servers[credentials.default] };
}
