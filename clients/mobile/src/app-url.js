// The server a build opens. There is no built-in server: APP_URL is
// required when the native projects are prepared (scripts/prepare.cjs,
// capacitor.config.js, android/app/build.gradle), and its host goes into
// the iOS files that name it (universal links, app-bound domains).

"use strict";

const LOCAL = /^(localhost|127\.0\.0\.1|10\.0\.2\.2)$/;

const EXAMPLE = "APP_URL=https://zvena.example.com npm run sync";

/** APP_URL as a URL; throws a message that says what to set when it is missing or unusable. */
function buildAppUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`APP_URL is not set. It is the address of the zvena server this build opens, for example: ${EXAMPLE}`);
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`APP_URL is not a valid address (got ${raw}). For example: ${EXAMPLE}`);
  }
  if (u.username || u.password) throw new Error(`APP_URL must not contain a user name or password (got ${raw})`);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.test(u.hostname))) {
    throw new Error(`APP_URL must be https; plain http only for localhost, 127.0.0.1 or 10.0.2.2 (got ${raw})`);
  }
  return u;
}

function replaceOnce(text, re, value, what) {
  if (!re.test(text)) throw new Error(`${what} not found`);
  return text.replace(re, (_m, a, b) => `${a}${value}${b}`);
}

/** Info.plist with the host as its only WKAppBoundDomains entry. */
function withAppBoundDomain(plist, host) {
  return replaceOnce(plist, /(<key>WKAppBoundDomains<\/key>\s*<array>\s*<string>)[^<]*(<\/string>)/, host, "WKAppBoundDomains in Info.plist");
}

/** App.entitlements with the host as its associated domain (applinks:). */
function withAppLinks(entitlements, host) {
  return replaceOnce(entitlements, /(<string>applinks:)[^<]*(<\/string>)/, host, "applinks: in App.entitlements");
}

module.exports = { buildAppUrl, withAppBoundDomain, withAppLinks };
