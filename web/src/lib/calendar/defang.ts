// Server-only: what a letter to someone outside zvena may carry of what a
// person typed (an event's title, place, a host's name). Mail apps turn URLs
// and bare domains into links, so a letter from zvena's own sender must not
// relay someone's text as a working link (phishing).

/** Text with its links made inert: no URL, and no bare domain a mail app would turn into one. */
export function defang(s: string): string {
  return s
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "")
    .replace(/\b(www\.)/gi, "www․")
    .replace(/([\p{L}\p{N}-])\.(?=[\p{L}]{2,}\b)/gu, "$1․")
    .replace(/\s+/g, " ")
    .trim();
}

/** Video-call hosts whose links a letter may carry (anything else stays in the .ics only). */
const MEETING_HOSTS = /^(?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|whereby\.com|meet\.jit\.si|webex\.com|gotomeeting\.com|around\.co)$/i;

export function knownMeetingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && MEETING_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}
