import type { Metadata } from "next";
import { translate } from "@/lib/i18n";
import { lettersLeave } from "@/lib/mail";
import { safeNext } from "@/lib/oauth";
import { pageLocale, requireUser } from "@/lib/page";
import { Welcome } from "./Welcome";
import "./welcome.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "welcome.title"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ next?: string }> };

// Setting zvena up, the way Linear does on the first sign-in: your name (zvena
// greets you by it, your team sees it), the language and the look, then the
// team — a shared workspace and the people you invite to it — and the two keys
// worth knowing. A new account lands here once (lib/signin.ts); anyone can come
// back from Settings. Someone arriving through an invite, or already in a
// team, skips the team steps: they are joining one.
export default async function WelcomePage({ searchParams }: Props) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const here = `/welcome${sp.next ? `?next=${encodeURIComponent(next)}` : ""}`;
  const { user } = await requireUser(here);
  const joining = next.startsWith("/join") || user.workspaces.some((w) => !w.personal);
  return (
    <main className="zw">
      <Welcome name={user.name} email={user.email ?? ""} next={next} team={!joining} mailOn={lettersLeave()} />
    </main>
  );
}
