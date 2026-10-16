import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContentPage } from "@/components/zvena/ContentPage";
import { config } from "@/lib/config";
import { Email } from "@/components/zvena/Email";

const title = "Source code";
const description = "zvena is open source: the app under the GNU AGPL 3.0, zvena Design (based on Penpot) under the MPL 2.0. Get the source of this server.";

export const metadata: Metadata = pageMetadata({ title: "Source code of zvena", description, path: "/source", previewTitle: `zvena ${title}` });
export const dynamic = "force-dynamic";

interface Manifest {
  version: string;
  upstream: { name: string; version: string; url: string; license: string };
  modified: string[];
  deleted: string[];
  files: Record<string, { size: number; sha256: string }>;
}

function manifest(): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "public/source/manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

// The MPL 2.0 source offer of Design (bin/publish-source.sh fills public/source/).
export default async function SourcePage() {
  const m = manifest();
  const support = config.company.email;
  const repo = config.sourceUrl;
  return (
    <ContentPage
      eyebrow="Open source"
      title="Source code"
      lead="zvena is free and open-source software. This page offers the source code of the version this server runs."
      cta={false}
    >
      <h2>What is open</h2>
      <ul>
        <li>
          <b>zvena</b> &mdash; Docs, Projects, Calendar, Mail, Teams, the Jev integration and the desktop, mobile and browser apps &mdash; under the{" "}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License 3.0</a>. Repository: <a href={repo}>{repo}</a>. If this server
          runs a modified version, its operator must offer that version&apos;s source here as well.
        </li>
        <li>
          <b>zvena Design.</b> The base: <a href="https://github.com/penpot/penpot/tree/2.18.3">Penpot 2.18.3</a> (© Kaleidos INC and contributors, licensed under the{" "}
          <a href="https://www.mozilla.org/MPL/2.0/">MPL 2.0</a>). All our changes to Penpot files, and the new files we added inside it, are distributed under the same
          MPL 2.0 terms. The archives below hold the whole modified source tree except Penpot&apos;s documentation images, which we did not change.
        </li>
        <li>
          <b>Open-source libraries we ship unmodified</b>, under their own licenses &mdash; for example the Docs editor{" "}
          <a href="https://github.com/TypeCellOS/BlockNote/tree/v0.55.0">BlockNote 0.55.0</a> (MPL 2.0; its source is at that link), Tiptap and ProseMirror (MIT).
        </li>
      </ul>
      {m ? (
        <>
          <h2>Download (version {m.version})</h2>
          <ul>
            {Object.entries(m.files).map(([name, f]) => (
              <li key={name}>
                <a href={`/source/${name}`} download>
                  {name}
                </a>{" "}
                <span className="zv-muted zv-small">
                  ({mb(f.size)}, SHA-256 {f.sha256.slice(0, 16)}…)
                </span>
              </li>
            ))}
          </ul>
          <h2>Modified and added files ({m.modified.length})</h2>
          <details>
            <summary>Show the list</summary>
            <ul className="zv-small" style={{ columns: 1 }}>
              {m.modified.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </details>
          {m.deleted.length > 0 && (
            <>
              <h2>Deleted files ({m.deleted.length})</h2>
              <details>
                <summary>Show the list</summary>
                <ul className="zv-small">
                  {m.deleted.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </>
      ) : (
        <p className="zv-banner zv-banner-warn">
          The source archives are prepared with each release and will appear here. You can also request them at <Email address={support} />.
        </p>
      )}
      <h2>Trademarks</h2>
      <p>
        &ldquo;Penpot&rdquo; is a trademark of its owners. zvena is not affiliated with or endorsed by Kaleidos; the Penpot name is used only to state where the code comes
        from.
      </p>
    </ContentPage>
  );
}
