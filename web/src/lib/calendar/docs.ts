// Server-only: Documents pages of an event — meeting notes made from it,
// and pages attached to it (Notion Calendar's "Notion docs" on an event).
// Pages are written through Documents' own push with the person's access;
// an attached page must be one they can read, and attaching changes the
// event, so it takes edit rights on its calendar. The links show both ways
// (the event in the page's Related, the page on the event).

import { canRead } from "../notes/access";
import { blankNote, noteSlug, sanitizeNote, shortId } from "../notes/model";
import { pushNotes } from "../notes/server-store";
import { addLink } from "../eco/links";
import { payerOf, quotaLeft } from "../storage";
import { sql } from "../store";
import { CalAccess, calRow, canSeeEvent } from "./access";
import { attendeesOf, CalError, eventRow, parseJson, putRow, type EvRow } from "./events";
import { afterWrite, whenLine } from "./effects";
import { calText } from "./strings";
import { prefsOf } from "./calendars";

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const text = (t: string) => ({ type: "text", text: t, styles: {} });
const block = (type: string, content: unknown[] = [], props: Record<string, unknown> = {}) => ({ id: shortId(), type, props, content, children: [] });

function setDocs(acc: CalAccess, r: EvRow, docs: string[], now: number): void {
  putRow({ ...r, docs: JSON.stringify(docs.slice(0, 20)), updated_at: now, updated_by: acc.userId });
  afterWrite({ ws: acc.ws, by: acc.userId, seriesIds: [r.parent_id ?? r.id], calIds: [r.cal_id], notifyGuests: false });
}

/** A Documents page of meeting notes for an event (in the person's Private pages), linked to it. */
export async function createMeetingNotes(acc: CalAccess, user: { id: string; name: string }, eventId: string, occ: unknown, locale: string, now = Date.now()): Promise<{ noteId: string; url: string; attached: boolean }> {
  const r = eventRow(eventId);
  if (!r || !canSeeEvent(acc, r)) throw new CalError(404, "event not found");
  const tz = prefsOf(acc.userId).tz;
  let at: Pick<EvRow, "all_day" | "start_at" | "end_at" | "start_day" | "end_day"> = r;
  if (typeof occ === "string" && /^\d{8}T\d{6}Z$/.test(occ) && r.all_day !== 1) {
    const ms = Date.UTC(Number(occ.slice(0, 4)), Number(occ.slice(4, 6)) - 1, Number(occ.slice(6, 8)), Number(occ.slice(9, 11)), Number(occ.slice(11, 13)));
    at = { ...r, start_at: ms, end_at: ms + (r.end_at - r.start_at) };
  }
  const when = whenLine(at, locale, tz);
  const title = `${r.title || calText(locale, "ev.untitled")} — ${when}`.slice(0, 300);
  const people: unknown[] = [];
  for (const a of attendeesOf(r.parent_id ?? r.id)) {
    if (people.length) people.push(text(", "));
    people.push(a.user_id ? { type: "mention", props: { noteId: "", date: "", remind: "", userId: a.user_id, name: a.name } } : text(a.name || a.email));
  }
  const content = [
    block("paragraph", [text(`🗓️ ${when}`)]),
    ...(people.length ? [block("paragraph", [text(`${calText(locale, "notes.attendees")}: `), ...people])] : []),
    block("heading", [text(calText(locale, "notes.agenda"))], { level: 2 }),
    block("bulletListItem"),
    block("heading", [text(calText(locale, "notes.notes"))], { level: 2 }),
    block("paragraph"),
    block("heading", [text(calText(locale, "notes.actions"))], { level: 2 }),
    block("checkListItem", [], { checked: false }),
  ];
  const note = sanitizeNote(blankNote({ kind: "page", parentId: null, title, icon: "🗓️", content, space: `private:${user.id}`, createdAt: now, updatedAt: now, order: now }));
  if (!note) throw new CalError(500, "not created");
  const payer = payerOf(acc.ws);
  const left = payer ? await quotaLeft(payer) : 0;
  const res = pushNotes(acc.ws, [{ id: note.id, note }], { by: user.id, quotaLeft: left, author: user.name, access: { userId: user.id } });
  if (!res.saved.includes(note.id)) throw new CalError(403, res.rejected[0]?.reason ?? "not saved");
  addLink(acc.ws, `event:${r.parent_id ?? r.id}`, `note:${note.id}`, "converted", user.id);
  const attached = acc.canWrite(calRow(r.cal_id));
  if (attached) setDocs(acc, r, [...new Set([...parseJson<string[]>(r.docs, []), note.id])], now);
  return { noteId: note.id, url: `/docs?ws=${encodeURIComponent(acc.ws)}#${noteSlug(note)}`, attached };
}

/** Attaches a page the person can read to an event they may change. */
export function attachDoc(acc: CalAccess, eventId: string, noteId: unknown, now = Date.now()): void {
  const r = eventRow(eventId);
  if (!r || !canSeeEvent(acc, r)) throw new CalError(404, "event not found");
  if (!acc.canWrite(calRow(r.cal_id))) throw new CalError(403, "read only");
  if (typeof noteId !== "string" || !ID_RE.test(noteId) || !canRead(acc.ws, acc.userId, noteId)) throw new CalError(404, "page not found");
  if (!sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(acc.ws, noteId)) throw new CalError(404, "page not found");
  const docs = parseJson<string[]>(r.docs, []);
  if (docs.length >= 20) throw new CalError(429, "too many pages");
  if (!docs.includes(noteId)) setDocs(acc, r, [...docs, noteId], now);
}

export function detachDoc(acc: CalAccess, eventId: string, noteId: string, now = Date.now()): void {
  const r = eventRow(eventId);
  if (!r || !canSeeEvent(acc, r)) throw new CalError(404, "event not found");
  if (!acc.canWrite(calRow(r.cal_id))) throw new CalError(403, "read only");
  const docs = parseJson<string[]>(r.docs, []);
  if (docs.includes(noteId)) setDocs(acc, r, docs.filter((d) => d !== noteId), now);
}
