import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import Link from "next/link";
import { LegalPage } from "@/components/zvena/LegalPage";
import { config } from "@/lib/config";
import "../legal.css";
import { Email } from "@/components/zvena/Email";

export const metadata: Metadata = pageMetadata({ title: "Cookie Policy", description: "The few strictly necessary cookies and browser storage zvena uses. No analytics, no advertising, no tracking.", path: "/legal/cookies" });

// What zvena keeps in the browser. Keep this list in step with the code:
// lib/auth.ts (session), lib/storage.ts (guest), lib/i18n.ts (language),
// lib/session.ts (workspace), lib/enterprise/sso.ts (single sign-on), and the
// localStorage / IndexedDB keys of the components.
export default async function CookiesPage() {
  const co = config.company;
  return (
    <LegalPage title="Cookie Policy" updated={config.legalUpdated}>
      <div className="zv-legal-summary">
        <p>
          zvena uses only cookies and browser storage that are <b>strictly necessary</b> to sign you in, keep your settings and make the editor work. There are no
          analytics, advertising or tracking cookies, so there is nothing to opt in or out of, and no consent banner beyond a short notice. An embed someone adds
          to a page (such as a video or a map), or a picture linked from another site, loads from that site, which may set its own cookies under its own policy.
        </p>
      </div>

      <h2 id="cookies">1. Cookies set by zvena</h2>
      <div className="zv-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Purpose</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>__Host-zv_s</code>
              </td>
              <td>Keeps you signed in. Not readable by page scripts (HttpOnly) and sent only over HTTPS.</td>
              <td>30 days, renewed while you use zvena; removed when you sign out</td>
            </tr>
            <tr>
              <td>
                <code>auth-token</code> (Design)
              </td>
              <td>Keeps you signed in to Design, on its own subdomain. HttpOnly.</td>
              <td>7 days, renewed while you use Design; removed when you sign out</td>
            </tr>
            <tr>
              <td>
                <code>zv-share-&hellip;</code> (Design)
              </td>
              <td>Remembers that you entered the password of a password-protected design link. HttpOnly.</td>
              <td>7 days</td>
            </tr>
            <tr>
              <td>
                <code>zv_g</code>
              </td>
              <td>A random guest id, so files you upload without an account stay yours and move into your account when you sign in</td>
              <td>Up to 400 days, renewed when you visit; removed when you sign in. Guest files are deleted {config.guestFileTtlDays} days after upload</td>
            </tr>
            <tr>
              <td>
                <code>zv_lang</code>
              </td>
              <td>Your interface language (also read by Design on zvena&rsquo;s own subdomain)</td>
              <td>400 days</td>
            </tr>
            <tr>
              <td>
                <code>zv_ws</code>
              </td>
              <td>The workspace you had open last</td>
              <td>400 days</td>
            </tr>
            <tr>
              <td>
                <code>zv_sso</code>
              </td>
              <td>
                Set only while you sign in with your organization&rsquo;s single sign-on: ties the answer of the identity provider to the browser that started the sign-in
                (HttpOnly)
              </td>
              <td>10 minutes, removed when the sign-in finishes</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="storage">2. Browser storage</h2>
      <ul>
        <li>
          <b>localStorage</b> <code>zvena-settings</code> &mdash; theme and editor settings; <code>nt-*</code> &mdash; Docs panel layout, views and editor preferences;{" "}
          <code>pj:*</code> &mdash; Projects view preferences; <code>zvena-search-recent</code> &mdash; your recent searches; <code>zvena-desktop-links</code> &mdash;
          whether links open in the zvena desktop app, if you use it; <code>zv-cookie-ok</code> &mdash; that you have seen the cookie notice; <code>zv.rail.folds</code> &mdash; which sidebar sections you folded.
        </li>
        <li>
          <b>sessionStorage</b> <code>zv-tz</code> &mdash; that your time zone was sent to our server (used for dates and reminders); <code>zvena-stay-in-browser</code> &mdash; that you chose to stay in the browser
          instead of opening the app; <code>zv-lang-shared</code> &mdash; that your language choice was passed on to Design. They go when you close the tab.
        </li>
        <li>
          <b>IndexedDB</b> <code>zvena-docs</code> &mdash; a local copy of the open workspace&rsquo;s documents, so they open instantly and keep working offline. If you use
          Docs without an account, this is the only copy of your documents.
        </li>
        <li>
          <b>Offline cache</b> (Cache Storage) &mdash; zvena&rsquo;s own program files, and the app pages and pictures you opened, kept per account so they open without a
          connection. Pages are never shown to another account, and signing out deletes them.
        </li>
      </ul>

      <h2 id="control">3. Your choices</h2>
      <p>
        You can delete cookies and site data in your browser settings at any time. If you delete the session cookie you will need to sign in again; if you delete
        guest data, documents you created without an account are lost. Because we only use strictly necessary cookies, blocking them may stop zvena from working.
      </p>
      <p>
        More about how we handle personal data is in our <Link href="/legal/privacy">Privacy Policy</Link>. Questions: <Email address={co.privacyEmail} />.
      </p>
    </LegalPage>
  );
}
