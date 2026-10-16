// Mail providers: the servers of the big mailbox services (presets), and how
// zvena signs in to a mailbox (auth methods). Shared by the server and the
// browser (the presets are data; the auth methods run on the server only).
//
// Today every mailbox signs in with a password over IMAP and SMTP: for
// Gmail, iCloud, Yahoo and Fastmail that is an app password (the service's
// security page makes one), for a custom server the mailbox password.
//
// OAuth (Gmail's and Microsoft's "Sign in with…") plugs in later without
// touching the sync or the composer:
//   1. register an OAuthMailProvider (registerOAuthProvider) with the
//      provider's client id and secret: its authorize URL, its token
//      exchange and refresh;
//   2. the connect flow stores { refreshToken } sealed in mail_accounts.secret
//      with auth = "oauth2:<provider id>" instead of { password };
//   3. `signIn()` below then hands IMAP an XOAUTH2 access token
//      ({ user, accessToken }: imapflow) and SMTP the same (nodemailer's
//      { type: "OAuth2", user, accessToken }); tokens are refreshed here and
//      kept in memory only.
// Nothing else changes: workers, sending and drafts all ask `signIn()`.

export type PresetId = "gmail" | "outlook" | "icloud" | "yahoo" | "fastmail" | "custom";

export interface ServerPreset {
  host: string;
  port: number;
  security: "tls" | "starttls";
}

export interface MailPreset {
  id: PresetId;
  name: string;
  /** Address domains that pick the preset when a person types their address. */
  domains: readonly string[];
  imap?: ServerPreset;
  smtp?: ServerPreset;
  /** The service files a copy of what SMTP sends into Sent by itself (zvena must not add a second one). */
  savesSent: boolean;
  /** Gmail's IMAP extensions (labels, threads): the account is synced through All Mail. */
  gmail?: boolean;
  /** Where the service makes app passwords. */
  appPasswordUrl?: string;
}

export const PRESETS: readonly MailPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    savesSent: true,
    gmail: true,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
  },
  {
    id: "outlook",
    name: "Outlook / Office 365",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imap: { host: "outlook.office365.com", port: 993, security: "tls" },
    smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
    savesSent: true,
    appPasswordUrl: "https://account.live.com/proofs/AppPassword",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
    smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
    savesSent: false,
    appPasswordUrl: "https://account.apple.com/account/manage",
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    imap: { host: "imap.mail.yahoo.com", port: 993, security: "tls" },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, security: "tls" },
    savesSent: false,
    appPasswordUrl: "https://login.yahoo.com/account/security",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    imap: { host: "imap.fastmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
    savesSent: false,
    appPasswordUrl: "https://app.fastmail.com/settings/security/apps",
  },
  { id: "custom", name: "IMAP / SMTP", domains: [], savesSent: false },
];

export function presetOf(id: unknown): MailPreset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** The preset an address suggests ("me@gmail.com" → Gmail), else the custom server. */
export function presetForEmail(email: string): MailPreset {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return PRESETS.find((p) => p.domains.includes(domain)) ?? (PRESETS.find((p) => p.id === "custom") as MailPreset);
}

// --- Signing in (server) -----------------------------------------------------------

/** What IMAP (imapflow) and SMTP (nodemailer) are handed. */
export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };
export type SmtpAuth = { user: string; pass: string } | { type: "OAuth2"; user: string; accessToken: string };

/** A provider's OAuth for mailboxes (none is registered yet: zvena has no client credentials). */
export interface OAuthMailProvider {
  /** "google", "microsoft". */
  id: string;
  /** The page a person approves access on (state and PKCE are the caller's). */
  authorizeUrl(opts: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string;
  /** The code from the redirect → a refresh token and the mailbox address. */
  exchange(opts: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; email: string }>;
  /** A fresh access token (and when it expires). */
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }>;
}

const KEY = Symbol.for("zvena.mail.oauth");
const g = globalThis as unknown as Record<symbol, Map<string, OAuthMailProvider> | undefined>;
const oauth: Map<string, OAuthMailProvider> = (g[KEY] ??= new Map());
const tokens = new Map<string, { accessToken: string; expiresAt: number }>();

export function registerOAuthProvider(p: OAuthMailProvider): void {
  oauth.set(p.id, p);
}

export function oauthProvider(id: string): OAuthMailProvider | null {
  return oauth.get(id) ?? null;
}

/** The sealed secret of an account, opened (crypto.ts). */
export type MailSecret = { password: string } | { refreshToken: string };

export class MailAuthError extends Error {}

/** IMAP and SMTP credentials of an account: `auth` is "password" or "oauth2:<provider>". */
export async function signIn(acct: { id: string; auth: string; username: string }, secret: MailSecret | null): Promise<{ imap: ImapAuth; smtp: SmtpAuth }> {
  if (!secret) throw new MailAuthError("credentials unreadable");
  if (acct.auth === "password" && "password" in secret) {
    return { imap: { user: acct.username, pass: secret.password }, smtp: { user: acct.username, pass: secret.password } };
  }
  if (acct.auth.startsWith("oauth2:") && "refreshToken" in secret) {
    const p = oauthProvider(acct.auth.slice(7));
    if (!p) throw new MailAuthError("oauth provider not configured");
    let t = tokens.get(acct.id);
    if (!t || t.expiresAt - Date.now() < 60_000) {
      t = await p.refresh(secret.refreshToken);
      tokens.set(acct.id, t);
    }
    return { imap: { user: acct.username, accessToken: t.accessToken }, smtp: { type: "OAuth2", user: acct.username, accessToken: t.accessToken } };
  }
  throw new MailAuthError("unknown auth method");
}

/** Forgets an account's cached access token (its secret changed, it was removed). */
export function forgetToken(accountId: string): void {
  tokens.delete(accountId);
}
