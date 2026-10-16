// Calls to the zvena server with the clipper token. Never with cookies
// (credentials: "omit"): the token is the only authority the extension has.

import { retryAfterSeconds } from "./errors.js";

/** → { ok, status, body, retryAfter }; status 0 when there was no answer. */
export async function call(server, token, path, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${server}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: ctl.signal,
    });
    let json = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { ok: r.ok, status: r.status, body: json, retryAfter: retryAfterSeconds(r.headers.get("retry-after")) };
  } catch {
    return { ok: false, status: 0, body: null, retryAfter: 0 };
  } finally {
    clearTimeout(timer);
  }
}
