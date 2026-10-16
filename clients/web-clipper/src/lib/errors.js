// What went wrong, in the person's words: an HTTP answer of the server (or
// a failure before one) → a message name in _locales.

/** `status` 0 = no answer (offline, DNS, blocked). */
export function errorKey(status, body) {
  const code = body && typeof body.error === "string" ? body.error : "";
  switch (status) {
    case 0:
      return "errNetwork";
    case 400:
      return "errBadRequest";
    case 401:
      return "errUnauthorized";
    case 403:
      return "errForbidden";
    case 404:
      return "errNotFound";
    case 413:
      return "errTooLarge";
    case 429:
      return "errRateLimited";
    case 507:
      return code === "storage full" ? "errServer" : "errQuota";
    default:
      return status >= 500 ? "errServer" : "errBadRequest";
  }
}

/** Seconds to wait from a Retry-After header (seconds or a date), at least 1. */
export function retryAfterSeconds(header, now = Date.now()) {
  const v = String(header ?? "").trim();
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Math.max(1, Number(v));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - now) / 1000)) : 0;
}
