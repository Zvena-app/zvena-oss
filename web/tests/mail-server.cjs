// A local mailbox for Mail's tests: an IMAP server (hoodiecrow, in memory,
// with IDLE, UIDPLUS, MOVE, SPECIAL-USE, CONDSTORE…) and an SMTP server that
// files every message it gets into INBOX, so a test can send itself mail.
// Optionally laid out like Gmail (All Mail + labels, X-GM-EXT-1).
//
//   unit tests:   const { startMailServer } = require("<web>/tests/mail-server.cjs")
//   e2e / stand:  node tests/mail-server.cjs --imap 3963 --smtp 3964 --http 3965 [--gmail]
//                 POST http://127.0.0.1:3965/deliver {from, to, subject, text, html?, messageId?, inReplyTo?, references?}
//                 GET  http://127.0.0.1:3965/mailbox?path=INBOX   → [{uid, subject, flags, labels}]
//
// Credentials: testuser@example.com / testpass (and testuser / testpass).
// Plain connections (no TLS): only a test stand (ZVENA_STAND=test) may use them.

"use strict";

const http = require("node:http");
const hoodiecrow = require("hoodiecrow-imap");
const { SMTPServer } = require("smtp-server");

const PLUGINS = ["ID", "IDLE", "UIDPLUS", "MOVE", "SPECIAL-USE", "ENABLE", "CONDSTORE", "NAMESPACE", "UNSELECT", "ESEARCH", "LITERALPLUS"];

function storage(gmail) {
  if (gmail)
    return {
      INBOX: {},
      "": {
        separator: "/",
        folders: {
          "[Gmail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": { "special-use": "\\All" },
              Drafts: { "special-use": "\\Drafts" },
              "Sent Mail": { "special-use": "\\Sent" },
              Spam: { "special-use": "\\Junk" },
              Trash: { "special-use": "\\Trash" },
              Starred: { "special-use": "\\Flagged" },
            },
          },
        },
      },
    };
  return {
    INBOX: {},
    "": {
      separator: "/",
      folders: {
        Sent: { "special-use": "\\Sent" },
        Drafts: { "special-use": "\\Drafts" },
        Trash: { "special-use": "\\Trash" },
        Junk: { "special-use": "\\Junk" },
        Archive: { "special-use": "\\Archive" },
        Clients: {},
      },
    },
  };
}

const crlf = (s) => s.replace(/\r?\n/g, "\r\n");

/** A small RFC 5322 message (text, or text + HTML), for tests. */
function buildRaw(m) {
  const id = m.messageId || `${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
  const headers = [
    `From: ${m.from || "Ann Example <ann@example.com>"}`,
    `To: ${m.to || "testuser@example.com"}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${m.subject || "Hello"}`,
    `Date: ${new Date(m.date || Date.now()).toUTCString()}`,
    `Message-ID: <${id.replace(/^<|>$/g, "")}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo.replace(/^<|>$/g, "")}>`] : []),
    ...(m.references ? [`References: ${[].concat(m.references).map((r) => `<${r.replace(/^<|>$/g, "")}>`).join(" ")}`] : []),
    "MIME-Version: 1.0",
  ];
  const text = m.text || "Hi there.";
  if (!m.html && !m.attachment) return crlf(`${headers.join("\n")}\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n\n${text}\n`);
  const b = `b${Math.random().toString(36).slice(2)}`;
  const parts = [`--${b}\nContent-Type: text/plain; charset=utf-8\n\n${text}\n`];
  if (m.html) parts.push(`--${b}\nContent-Type: text/html; charset=utf-8\n\n${m.html}\n`);
  if (!m.attachment) return crlf(`${headers.join("\n")}\nContent-Type: multipart/alternative; boundary="${b}"\n\n${parts.join("")}--${b}--\n`);
  const outer = `o${Math.random().toString(36).slice(2)}`;
  const alt = `${headers.join("\n")}\nContent-Type: multipart/mixed; boundary="${outer}"\n\n--${outer}\nContent-Type: multipart/alternative; boundary="${b}"\n\n${parts.join("")}--${b}--\n`;
  const att = `--${outer}\nContent-Type: ${m.attachment.type || "text/plain"}; name="${m.attachment.name}"\nContent-Disposition: attachment; filename="${m.attachment.name}"\nContent-Transfer-Encoding: base64\n\n${Buffer.from(m.attachment.content).toString("base64")}\n--${outer}--\n`;
  return crlf(alt + att);
}

/**
 * Starts the servers (port 0: any free port). `deliver(msg, path?, props?)`
 * files a message as if it had arrived; Gmail layouts file into All Mail
 * with \Inbox unless `props` says otherwise.
 */
function startMailServer(opts = {}) {
  const gmail = Boolean(opts.gmail);
  const imap = hoodiecrow({
    plugins: gmail ? [...PLUGINS, "X-GM-EXT-1", "OBJECTID"] : PLUGINS,
    storage: storage(gmail),
    users: { "testuser@example.com": { password: "testpass" }, testuser: { password: "testpass" } },
    debug: false,
  });
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, done) {
      if (auth.password === "testpass") done(null, { user: auth.username });
      else done(new Error("Invalid username or password"));
    },
    onData(stream, _session, done) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("error", done);
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("binary");
        if (gmail) imap.appendMessage("[Gmail]/All Mail", [], new Date(), raw, false, { "X-GM-LABELS": ["\\Inbox"] });
        else imap.appendMessage("INBOX", [], new Date(), raw);
        done();
      });
    },
  });
  const sent = [];
  smtp.on("error", () => undefined);
  const deliver = (m, path, props) => {
    const raw = typeof m === "string" ? crlf(m) : buildRaw(m);
    const where = path || (gmail ? "[Gmail]/All Mail" : "INBOX");
    const r = imap.appendMessage(where, [].concat((m && m.flags) || []), new Date(m.date || Date.now()), raw, false, props || (gmail && !path ? { "X-GM-LABELS": ["\\Inbox"] } : undefined));
    return r.message;
  };
  const list = (path) => {
    const box = imap.getMailbox(path);
    return box ? box.messages.map((x) => ({ uid: x.uid, flags: [...(x.flags || [])], labels: [...(x["X-GM-LABELS"] || [])], subject: (/^Subject: (.*)$/im.exec(x.raw) || [])[1] || "" })) : null;
  };
  return new Promise((resolve) => {
    imap.listen(opts.imapPort || 0, "127.0.0.1", () => {
      smtp.listen(opts.smtpPort || 0, "127.0.0.1", () => {
        resolve({
          imap,
          smtp,
          imapPort: imap.server ? imap.server.address().port : imap.address().port,
          smtpPort: smtp.server.address().port,
          deliver,
          list,
          sent,
          close: () => new Promise((done) => smtp.close(() => imap.close(() => done()))),
        });
      });
    });
  });
}

module.exports = { startMailServer, buildRaw };

if (require.main === module) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  startMailServer({ imapPort: Number(arg("imap", 3963)), smtpPort: Number(arg("smtp", 3964)), gmail: process.argv.includes("--gmail") }).then((s) => {
    const port = Number(arg("http", 3965));
    http
      .createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        const reply = (code, body) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method === "POST" && u.pathname === "/deliver") {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => {
            try {
              const m = JSON.parse(b || "{}");
              const msg = s.deliver(m, m.path);
              reply(200, { ok: true, uid: msg.uid });
            } catch (e) {
              reply(400, { error: String(e && e.message) });
            }
          });
          return;
        }
        if (req.method === "GET" && u.pathname === "/mailbox") return reply(200, s.list(u.searchParams.get("path") || "INBOX") || []);
        reply(404, { error: "not found" });
      })
      .listen(port, "127.0.0.1", () => console.log(`mail test server: imap ${s.imapPort}, smtp ${s.smtpPort}, control http://127.0.0.1:${port}`));
  });
}
