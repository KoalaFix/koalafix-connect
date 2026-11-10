// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// The person's own KoalaFix credential, kept once per user instead of once per project, so a plugin or extension
// install needs no `koalafix init` in each project. `koalafix login` writes it to
// <KALIBRATE_HOME or ~/.kalibrate>/credentials.json:
//   { "version": 1, "default": "https://mcp.koalafix.com", "servers": { "https://mcp.koalafix.com": { "token": "…" } } }
// A token is bound to the server it was issued for: it is only ever sent to that exact origin. A cloned repository
// chooses its own `serverUrl`, so a project pointing somewhere else never gets the person's token.
//
// The koalafix-auto plugin also declares the credential as its own plugin option, marked sensitive (`koalafix_token`,
// which Claude Code keeps in its own secure store and hands each hook as CLAUDE_PLUGIN_OPTION_KOALAFIX_TOKEN). When
// that option is set it wins, for the server the browser sign-in uses only (`signInServer`); option-copy.mjs moves an
// existing stored sign-in into it once. Release two (koalafix-auto 0.6.0) stops reading credentials.json in the plugin.
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

/** The hosted server: where the browser sign-in goes, and the only server the plugin option's token is for. */
export const DEFAULT_SERVER_URL = "https://mcp.koalafix.com";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The server a first sign-in goes to: the hosted server, or KALIBRATE_SERVER_URL when it names this machine (a local
 * test server). Any other override is ignored: a project can set environment variables for its sessions, and the
 * sign-in saves its server as the person's default, so a planted URL would get every later prompt. Another server
 * signs in with `koalafix login`, where the person types it.
 */
export function signInServer(env = process.env) {
  const given = env.KALIBRATE_SERVER_URL;
  if (typeof given !== "string" || originOf(given) === null) {
    return DEFAULT_SERVER_URL;
  }
  return LOOPBACK.has(new URL(given).hostname) || originOf(given) === originOf(DEFAULT_SERVER_URL) ? given : DEFAULT_SERVER_URL;
}

/** The environment variable Claude Code sets for the koalafix-auto plugin's sensitive `koalafix_token` option. */
export const OPTION_ENV = "CLAUDE_PLUGIN_OPTION_KOALAFIX_TOKEN";

/** The plugin option's token, or "" when it is unset, empty or not one word. */
export function optionToken(env = process.env) {
  const value = typeof env[OPTION_ENV] === "string" ? env[OPTION_ENV].trim() : "";
  return value !== "" && !/\s/.test(value) ? value : "";
}

/** The origin the plugin option's token is for: the sign-in server's. */
export function optionOrigin(env = process.env) {
  return originOf(signInServer(env));
}

/** The token saved in credentials.json for exactly this server's origin, or "" when there is none. */
export function storedToken(serverUrl, env = process.env) {
  const origin = originOf(serverUrl);
  const credentials = readCredentials(env);
  return origin === null || credentials === null ? "" : (credentials.servers[origin] ?? "");
}

/**
 * The person's token for exactly this server's origin, or "" when they have none for it: the plugin option when it
 * is set and this is its server, else the one saved in credentials.json.
 */
export function userToken(serverUrl, env = process.env) {
  const origin = originOf(serverUrl);
  const option = optionToken(env);
  if (origin !== null && option !== "" && origin === optionOrigin(env)) {
    return option;
  }
  return storedToken(serverUrl, env);
}

/**
 * The person's server and its token, for a plugin install with no project config, or null. `from` says where the
 * token came from: "option" (the plugin option, for the sign-in server) or "stored" (credentials.json's default).
 */
export function userServer(env = process.env) {
  const option = optionToken(env);
  if (option !== "") {
    return { serverUrl: optionOrigin(env), token: option, from: "option" };
  }
  const credentials = readCredentials(env);
  if (credentials === null || credentials.default === null) {
    return null;
  }
  return { serverUrl: credentials.default, token: credentials.servers[credentials.default], from: "stored" };
}
