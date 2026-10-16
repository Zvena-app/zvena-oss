import type { Metadata } from "next";
import { translate } from "@/lib/i18n";
import { pageLocale, requireUser } from "@/lib/page";
import { ClipForm } from "./ClipForm";
import "../clipper/clipper.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "clip.title"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ url?: string; title?: string; text?: string; ws?: string }> };

const first = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** A shared text often carries the link itself ("Title https://…"): the link goes to `url`, the rest stays text. */
function splitShared(url: string, text: string): { url: string; text: string } {
  if (url) return { url, text };
  const m = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!m) return { url: "", text };
  return { url: m[0].replace(/[).,;!?]+$/, ""), text: text.replace(m[0], "").trim() };
}

// "Save to zvena": where the installed app's share target and the phone
// apps' share sheets land (and anyone with a link to save). The page is
// only prefilled from the address; nothing is saved until the person picks
// a place and presses Save (POST /api/notes/clip with their session).
export default async function ClipPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  const { user, locale } = await requireUser(`/clip${q ? `?${q}` : ""}`, sp.ws);
  const shared = splitShared(first(sp.url, 2000).trim(), first(sp.text, 4000).trim());
  return (
    <main className="zv-center">
      <div className="zv-panel zv-clipper zv-clip">
        <span className="zv-clipper-logo" role="img" aria-label="zvena" />
        <ClipForm
          workspaces={user.workspaces.map((w) => ({ id: w.id, name: w.name, canCreate: w.role === "owner" || w.role === "editor" }))}
          ws={user.ws.id}
          initial={{ url: shared.url, title: first(sp.title, 300).trim(), text: shared.text }}
          untitled={translate(locale, "clip.untitled")}
        />
      </div>
    </main>
  );
}
