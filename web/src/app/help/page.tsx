import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import Link from "next/link";
import { ContentPage } from "@/components/zvena/ContentPage";
import { config } from "@/lib/config";
import { formatBytes } from "@/lib/i18n";
import "../content.css";
import { Email } from "@/components/zvena/Email";

const title = "Help center";
const description = "How to use zvena: workspaces and roles, Docs, Design, Projects, Mail, Calendar, single sign-on, import and export, and your data.";

export const metadata: Metadata = pageMetadata({ title: "Help center: guides and answers", description, path: "/help", previewTitle: `zvena ${title}` });

const SECTIONS = [
  ["start", "Getting started"],
  ["roles", "Workspaces and roles"],
  ["docs", "Docs"],
  ["design", "Design"],
  ["projects", "Projects"],
  ["automations", "Goals and automations"],
  ["mail", "Mail"],
  ["calendar", "Calendar and booking"],
  ["clip", "Saving web pages"],
  ["admin", "Single sign-on and admin"],
  ["link", "Designs inside docs"],
  ["import", "Import and export"],
  ["data", "Your data and account"],
  ["report", "Reporting content"],
  ["contact", "Contact us"],
] as const;

export default async function HelpPage() {
  const quota = formatBytes(config.storageQuota, "en");
  const support = config.company.supportEmail;
  return (
    <ContentPage eyebrow="Help" title="zvena Help Center" lead="The essentials in one place. Can't find an answer? Write to us and a person will reply." cta={false}>
      <nav className="zc-toc" aria-label="Contents">
        <p className="zc-toc-title">Contents</p>
        <ol>
          {SECTIONS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ol>
      </nav>

      <h2 id="start">Getting started</h2>
      <ol className="zc-steps">
        <li>
          <b>Sign in without a password.</b> Enter your email and you&apos;ll get a one-time sign-in link, or use your organization&apos;s single sign-on. The same email address
          always leads to the same account.
        </li>
        <li>
          <b>Start in your personal workspace.</b> Every account comes with a private workspace that only you can see.
        </li>
        <li>
          <b>Bring your team.</b> On the <Link href="/team">Team</Link> page, create a shared workspace and send teammates an invite link.
        </li>
      </ol>
      <p>
        Just looking around? <Link href="/docs">Try Docs without an account</Link>. Your pages stay in this browser, and they move into your personal workspace when you
        sign in. Without an account you can upload pictures only, and they are deleted {config.guestFileTtlDays} days after upload unless you sign in; Design, Projects,
        Calendar, Mail, sharing and publishing need an account.
      </p>

      <h2 id="roles">Workspaces and roles</h2>
      <p>A workspace holds docs and designs. Each member has one role, and it applies to both Docs and Design:</p>
      <ul>
        <li>
          <b>Owner</b> — everything, including members, invite links and deleting the workspace.
        </li>
        <li>
          <b>Editor</b> — creates and edits docs and designs.
        </li>
        <li>
          <b>Commenter</b> — reads and comments.
        </li>
        <li>
          <b>Viewer</b> — reads only.
        </li>
      </ul>
      <p>
        Invite links are valid for {config.inviteDays} days by default and can be revoked any time on the Team page. Owners can change roles, remove members and transfer
        ownership. Switch between workspaces from the menu at the top of the sidebar.
      </p>

      <h2 id="docs">Docs</h2>
      <ul>
        <li>
          Type <kbd>/</kbd> on an empty line to insert any block: headings, lists, to-dos, toggles, callouts, tables, databases, code, math and design frames.
        </li>
        <li>Databases can be shown as a table, board, list, gallery, calendar, timeline, chart, form, map, feed or dashboard — with filters, sorts and grouping.</li>
        <li>
          Publish a page to the web from <i>Share → Publish</i>. Anyone with the link can read the page and its sub-pages; nobody can edit them. Search engines skip it unless you allow indexing.
        </li>
        <li>
          Need input from people outside your team? Turn a database view into a form and share its link. Responses arrive as new rows.
        </li>
        <li>
          Several people can edit a page at the same time: you see each other&apos;s cursors and names as you type. <i>Page history</i> in the ⋯ menu shows earlier
          versions and who made them, and restores any of them.
        </li>
        <li>Pages open from your browser&apos;s cache, so they load instantly and keep working on a shaky connection.</li>
      </ul>

      <h2 id="design">Design</h2>
      <ul>
        <li>
          Open <b>Design</b> from the sidebar. You&apos;re signed in automatically with your zvena account, and you see the designs of the workspace you&apos;re in.
        </li>
        <li>Boards, components, auto layout, prototypes and inspect mode work the way you know from other interface design tools.</li>
        <li>
          zvena Design is based on Penpot, so the <a href="https://help.penpot.app/">Penpot user guide</a> explains every tool in depth.
        </li>
        <li>
          Start from a template — a landing page, a mobile app or a UI kit — on the <Link href="/templates">Templates</Link> page.
        </li>
      </ul>

      <h2 id="projects">Projects</h2>
      <ul>
        <li>
          Open <b>Projects</b> from the sidebar. Your workspace gets a team with a few example issues to try things on. Press <b>C</b> anywhere in Projects for a new
          issue, and <b>?</b> for every keyboard shortcut.
        </li>
        <li>
          Each issue has an ID like ABC-12, a status from its team&apos;s workflow, a priority, assignee, labels, project, cycle, due date and estimate &mdash; plus
          sub-issues, relations (blocks, related, duplicate), comments and attachments.
        </li>
        <li>
          Switch between list, board and calendar, group, sort and filter, and save the result as a view for yourself or the whole workspace. Click an issue to open it on
          the side. Most changes can be undone with Ctrl/Cmd+Z.
        </li>
        <li>
          <b>Projects</b> have a lead, dates, milestones and status updates, and the <b>Roadmap</b> shows them on a timeline you can drag. <b>Cycles</b> are a
          team&apos;s sprints, with a burn-up chart; unfinished issues move on when a cycle ends.
        </li>
        <li>
          <b>Smart suggestions</b> propose a new issue&apos;s priority, label, project and assignee and flag likely duplicates. When the answer is confident, empty
          fields are filled in automatically &mdash; marked in the issue&apos;s history and undoable. The workspace owner can turn this off in Projects &rarr; Settings
          &rarr; Smart suggestions. What is sent and to whom is in the <Link href="/legal/privacy#suggestions">Privacy Policy</Link>.
        </li>
      </ul>

      <h2 id="automations">Goals and automations</h2>
      <ul>
        <li>
          A <b>goal</b> is an issue that closes by itself when a number reaches its target. Open an issue and choose <b>Close automatically when…</b>, or choose{" "}
          <b>Set a goal</b> under a chart in Docs. The number can be typed in, sent from your analytics or a script (Home &rarr; Automations &rarr; <b>What runs by
          itself</b> &rarr; <b>Numbers from your tools</b> makes a key), or counted by zvena: rows of a database or chart, a project&apos;s progress, meetings in a
          calendar. When it gets there, the issue closes and, if <b>Also mark linked documents done</b> is on, the Docs rows linked to it are marked done.
        </li>
        <li>
          <b>Exact rules</b> run the moment their condition becomes true, the same way every time, decided by the rule itself rather than a model: a goal&apos;s number reaching its target, a parent
          issue closing when all its sub-issues are done (and reopening with one), an issue closing when its Design comment is resolved, an issue&apos;s due date
          following its meeting. The workspace owner can switch the automatic ones off under <b>What runs by itself</b>.
        </li>
        <li>
          <b>Smart suggestions</b> are proposals a person confirms: fields of a new issue, likely duplicates, a goal for an issue whose title names a target, and a
          Docs automation&apos;s <b>Run only if…</b> condition when the answer is not clear. They wait under <b>Waiting for you</b> on Home and on the issue, with
          Accept or dismiss. They need smart suggestions to be on in the workspace (the owner decides), and each workspace has an hourly and a daily limit; past it, the
          model is not asked until the limit resets &mdash; exact rules keep running, and some suggestions fall back to simple rules.
        </li>
        <li>
          <b>Automatic actions</b> are applied at once and listed under <b>Done automatically</b> on Home: a rule&apos;s result, a Docs automation&apos;s run, and
          suggestions the model is sure of (they fill only empty fields). <b>Undo</b> there puts back an automatic step &mdash; a parent issue it closed, a value an
          automation set, a field it filled &mdash; unless someone has changed it since. A goal closed by its rule is reopened like any issue; messages and webhooks
          an automation sent cannot be taken back.
        </li>
      </ul>

      <h2 id="mail">Mail</h2>
      <ul>
        <li>
          Open <b>Mail</b> from the sidebar and choose <i>Connect a mailbox</i>. Pick Gmail, Outlook, iCloud, Yahoo or Fastmail, or <i>Other (IMAP / SMTP)</i> for any
          other server. You can connect up to 10 mailboxes.
        </li>
        <li>
          Most services need an <b>app password</b> rather than your normal one: turn on 2-step verification with your provider, then make an app password (the
          connect form links to the right page). Some Microsoft accounts allow only Microsoft&apos;s own sign-in for mail apps; those can&apos;t be connected with a
          password yet.
        </li>
        <li>
          zvena syncs the last 90 days of mail and keeps it in step with your server both ways: what you read, move or delete here changes there too. Messages you send
          go out through your own mail server, so they look exactly as if you sent them from your usual app.
        </li>
        <li>
          Your mail is visible only to you. You can save a conversation to a page or turn it into a Projects issue; only what you copy that way is shared with your
          workspace. Disconnecting a mailbox removes its copy and password from zvena and changes nothing on your server. Details are in the{" "}
          <Link href="/legal/privacy#mail">Privacy Policy</Link>.
        </li>
      </ul>

      <h2 id="calendar">Calendar and booking</h2>
      <ul>
        <li>
          Open <b>Calendar</b> from the sidebar. Events can repeat, have guests, reminders and a video-call link; guests outside zvena get an email invitation they can
          answer. Docs databases and Projects with dates can be shown as layers.
        </li>
        <li>
          <b>Other calendars:</b> <i>Subscribe by URL</i> adds a read-only calendar by its iCal address (Google, Outlook, Apple, holidays). <i>Connect a CalDAV
          account</i> syncs both ways with iCloud, Fastmail, Nextcloud and other CalDAV servers &mdash; use an app-specific password. Google and Microsoft calendar
          sign-in isn&apos;t available yet.
        </li>
        <li>
          <b>See zvena in another app:</b> a calendar&apos;s <i>Secret address in iCal format</i> lets other calendar apps show it. Anyone with that address sees every
          event, so keep it private, and use <i>Reset address</i> if it leaks.
        </li>
        <li>
          <b>Booking pages:</b> create a <i>New scheduling link</i>, set your weekly hours, meeting length, buffers and notice, and share the link. People pick a free
          time without an account; the meeting lands in your calendar, both of you get an email with the details, and your guest gets a link to reschedule or cancel. Visitors only
          ever see free times, never what you are busy with.
        </li>
      </ul>

      <h2 id="clip">Saving web pages</h2>
      <ul>
        <li>
          On Android, install zvena from Chrome (<i>Add to Home screen</i> or <i>Install app</i>), then use the <b>Share</b> menu of any app &rarr; zvena. Pick a page, a database or your
          Private section and press Save; the article&apos;s text and pictures are copied into a new page.
        </li>
        <li>
          The Web Clipper browser extension and other apps you connect are listed in <Link href="/settings">Settings</Link> &rarr; <i>Connected apps</i>, where you can
          disconnect each one.
        </li>
      </ul>

      <h2 id="admin">Single sign-on and admin</h2>
      <p>For owners of team workspaces. These are free, like everything else.</p>
      <ul>
        <li>
          <b>Verified domains</b> (Settings &rarr; Identity): add your company&apos;s domain and put the TXT record zvena shows you in its DNS. You can then let people with a
          verified address at that domain join from the sign-in page.
        </li>
        <li>
          <b>Single sign-on (SSO)</b>: connect your identity provider with SAML 2.0 or OpenID Connect (Okta, Microsoft Entra ID, Google Workspace and others). You can
          let new people join on first sign-in, and require SSO for your domain; owners always keep another way in.
        </li>
        <li>
          <b>SCIM provisioning</b>: create a token and give your directory the SCIM base URL, so people are added to and removed from the workspace and its groups
          automatically.
        </li>
        <li>
          <b>Security</b> and <b>Audit log</b>: decide whether the workspace may publish to the web, share with guests, export and move pages out, and see sign-ins, member changes, sharing and settings changes.
        </li>
      </ul>

      <h2 id="link">Designs inside docs</h2>
      <ol>
        <li>
          In a page, type <kbd>/design</kbd> and pick a file and a board.
        </li>
        <li>The preview updates on its own when the design changes. Click it to open the design.</li>
        <li>
          In Design, the main menu&apos;s <i>Documents with this design</i> shows every page where the design is used.
        </li>
      </ol>
      <p className="zv-muted">On published pages the frame shows a caption instead of the preview, so your designs are never exposed through a public link.</p>

      <h2 id="import">Import and export</h2>
      <ul>
        <li>
          <b>Into Docs:</b> click <i>Import</i> on the Docs home page or in a page&apos;s ⋯ menu. Supported: Notion (Markdown &amp; CSV export), HTML, Markdown, CSV and Evernote
          (.enex). From Notion, choose Settings → Export → Markdown &amp; CSV and import the archive.
        </li>
        <li>
          <b>Into Design:</b> import .penpot files and SVG, or bring a Figma file over by its link: File → Import from Figma, then paste the link and a Figma personal
          access token (used once, never stored). Instances arrive as plain layers.
        </li>
        <li>
          <b>Out of Docs:</b> export any page to Markdown, HTML, PDF or CSV from its ⋯ menu.
        </li>
        <li>
          <b>Out of Design:</b> export boards and layers to PNG, JPG, SVG or PDF, or download the whole file as .penpot.
        </li>
      </ul>

      <h2 id="data">Your data and account</h2>
      <ul>
        <li>
          <b>Download everything:</b> <Link href="/settings">Settings</Link> → <i>Download all my data</i> gives you a ZIP with the docs (JSON and Markdown) of workspaces
          you own or edit, your issues (JSON and CSV), uploaded files, designs as .penpot files, your security log and account data. Calendars download as .ics files.
        </li>
        <li>
          <b>Delete your account:</b> Settings → <i>Delete account</i>. It removes your account, personal workspace, docs, files and designs. Shared workspaces pass to the
          next member, or are deleted if nobody else is in them.
        </li>
        <li>
          <b>Storage:</b> each account has {quota} for docs, files and designs together, and what members add to a shared workspace counts toward its owner&apos;s storage. Settings shows how much you use.
        </li>
        <li>
          <b>Photos:</b> large images are scaled down to {config.imageMaxSide}px on the long side when uploaded, and their metadata — including location — is removed.
        </li>
        <li>
          <b>Security:</b> Settings → <i>Sign out on all devices</i> ends every session at once.
        </li>
      </ul>
      <p>
        How we handle your information is described in the <Link href="/legal/privacy">Privacy Policy</Link>.
      </p>

      <h2 id="report">Reporting content</h2>
      <p>
        See something illegal or abusive on a published page, form or design? Use the <i>Report</i> button on that page or fill in the <Link href="/report">report form</Link>.
        A moderator reviews every report and takes content down when it breaks our <Link href="/legal/terms">Terms</Link>.
      </p>

      <h2 id="contact">Contact us</h2>
      <p>
        Questions, bugs or ideas: <Email address={support} />. Check the <Link href="/status">status page</Link> if something seems down.
      </p>
    </ContentPage>
  );
}
