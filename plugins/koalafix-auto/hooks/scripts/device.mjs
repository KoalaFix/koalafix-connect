// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KoalaFix PTY LTD and the Kalibrate contributors

// Sign-in from inside a plugin install, with no terminal: when a `--user` hook finds no credential, it starts the
// browser approval (ADR-0007 section 6, POST /api/v1/device/start), keeps the device code in
// <KALIBRATE_HOME or ~/.kalibrate>/device-pending.json (this user only) and tells the model to show the person the page
// and the code. Each later hook run polls once (POST /api/v1/device/token); once the person approves, it saves the
// token to credentials.json, exactly as `koalafix login` does, and the hook goes on as if signed in. A server without
// the route yet answers 404 or 501, and the hook then only says to run koalafix login. Never prints a token.
// Plain ESM, Node 22 APIs only, no dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpStatusError, messageOf } from "./connect.mjs";
import { credentialsPath, originOf } from "./credentials.mjs";
import { assertOnline, markOffline, markOnline, originKey } from "./offline.mjs";
import { apiBase } from "./project.mjs";
import { kalibrateHome } from "./spool.mjs";

/**
 * Thrown by `locateHook` for a plugin install with no credential where a browser can be shown: the hook may then sign
 * in (signInStep). Where none can (client.mjs `canShowBrowser`), `locateHook` answers null and the hook is silent.
 */
export { NoCredentialError } from "./credentials.mjs";

export const DEFAULT_SERVER_URL = "https://mcp.koalafix.com";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pendingPath(env) {
  return path.join(kalibrateHome(env), "device-pending.json");
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

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

/** Saves a token as `koalafix login` does: for its origin, as the default, keeping other servers' entries. */
export function saveCredential(serverUrl, token, label, env = process.env, now = new Date()) {
  const origin = originOf(serverUrl);
  const file = credentialsPath(env);
  const current = readJsonFile(file);
  const servers = isRecord(current?.servers) ? { ...current.servers } : {};
  servers[origin] = { token, savedAt: now.toISOString(), label };
  writePrivate(file, { version: 1, default: origin, servers });
}

/**
 * One sign-in request, under the circuit breaker (offline.mjs) like every other server call: it fails at once while
 * the server's cool-off runs, starts one when the server is down or answers 5xx, and clears it on any other answer.
 */
async function post(url, body, deadlineAt, fetchFn) {
  assertOnline(url);
  const origin = originKey(url);
  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(200, deadlineAt - Date.now())),
    });
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      markOffline(origin, messageOf(error));
    }
    throw error;
  }
  if (response.status >= 500 && response.status !== 501) {
    markOffline(origin, `HTTP ${response.status}`);
    await response.body?.cancel();
    throw new HttpStatusError(response.status, `${new URL(url).pathname} answered HTTP ${response.status}`);
  }
  markOnline(origin);
  let json = {};
  try {
    const parsed = await response.json();
    json = isRecord(parsed) ? parsed : {};
  } catch {
    // an empty or non-JSON body reads as {}
  }
  return { status: response.status, ok: response.ok, body: json };
}

function showText(pending) {
  return `KoalaFix team memory is installed but not signed in on this machine. Show the user this link and code, and ask them to approve it: ${pending.uri} (code ${pending.userCode}). Team memory turns on by itself once they approve; nothing else is needed.`;
}

/**
 * One step of the sign-in. Polls a pending code once; with none (or an ended one) and `start` set, starts a new one.
 * Returns { signedIn } when a token was saved, { text } for the model to show the person, or { text: null }.
 * @param {{ env?: Record<string, string | undefined>, client: string, deadlineAt: number, start: boolean, fetchFn?: typeof fetch }} options
 */
export async function signInStep({ env = process.env, client, deadlineAt, start, fetchFn = globalThis.fetch }) {
  const file = pendingPath(env);
  const pending = readJsonFile(file);
  const live = pending !== null && typeof pending.deviceCode === "string" && Date.parse(String(pending.expiresAt)) > Date.now();
  if (live) {
    const polled = await post(`${apiBase(pending.serverUrl)}/api/v1/device/token`, { device_code: pending.deviceCode }, deadlineAt, fetchFn);
    if (polled.ok && typeof polled.body.token === "string" && polled.body.token !== "") {
      saveCredential(pending.serverUrl, polled.body.token, pending.label, env);
      fs.rmSync(file, { force: true });
      return { signedIn: true, text: null };
    }
    if (polled.status === 428 || polled.body.error === "authorization_pending") {
      return { signedIn: false, text: start ? showText(pending) : null };
    }
    fs.rmSync(file, { force: true });
  }
  if (!start) {
    return { signedIn: false, text: null };
  }
  const serverUrl = signInServer(env);
  const label = `${client} on ${os.hostname()}`;
  const started = await post(`${apiBase(serverUrl)}/api/v1/device/start`, { client: label }, deadlineAt, fetchFn);
  if (started.status === 404 || started.status === 501) {
    return { signedIn: false, text: "KoalaFix team memory is installed but not signed in on this machine, and the server has no browser sign-in yet. Tell the user to run: koalafix login --token <a token from the KoalaFix dashboard>." };
  }
  const body = started.body;
  if (!started.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new Error(`the server could not start a sign-in (HTTP ${started.status})`);
  }
  const next = {
    serverUrl,
    label,
    deviceCode: body.device_code,
    userCode: body.user_code,
    uri: typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : String(body.verification_uri ?? serverUrl),
    expiresAt: new Date(Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 600) * 1000).toISOString(),
  };
  writePrivate(file, next);
  return { signedIn: false, text: showText(next) };
}
