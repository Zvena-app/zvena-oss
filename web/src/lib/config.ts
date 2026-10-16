// zvena settings, read from the environment (.env outside git; see .env.example).
// Every limit is configurable; defaults are the product's current decisions.

function int(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def;
}

function url(name: string, def: string): string {
  return (process.env[name] || def).trim().replace(/\/+$/, "");
}

export const GiB = 1024 ** 3;

/** This instance's host name (from APP_URL): the default domain of its own addresses, never another install's. */
function ownHost(): string {
  try {
    return new URL(url("APP_URL", "http://localhost:3100")).hostname;
  } catch {
    return "localhost";
  }
}

/** When the legal texts last changed (privacy: settings, Design library usage; 2026-10-15). */
const LEGAL_UPDATED = "2026-10-16";

export const config = {
  /** Public address of the app (home, Documents, account). */
  get appUrl() {
    return url("APP_URL", "http://localhost:3100");
  },
  /** Public address of Design (the Penpot fork). */
  get designUrl() {
    return url("DESIGN_URL", "http://localhost:3110");
  },
  /** Storage per account: documents, their files and designs together. */
  get storageQuota() {
    return int("ZVENA_STORAGE_QUOTA_BYTES", 2 * GiB);
  },
  /**
   * People editing one document at the same time. 0 = no limit. Values under
   * 3 are raised to 3: up to three editors are never limited.
   */
  get maxEditorsPerDoc() {
    const v = int("ZVENA_MAX_EDITORS_PER_DOC", 0);
    return v === 0 ? 0 : Math.max(3, v);
  },
  /** Members per workspace (0 = no limit). */
  get maxMembers() {
    return int("ZVENA_MAX_MEMBERS", 0);
  },
  /** Workspaces one person may create (0 = no limit). */
  get maxWorkspaces() {
    return int("ZVENA_MAX_WORKSPACES", 20);
  },
  /** Guest uploads: removed after this many days without a visit… */
  get guestFileTtlDays() {
    return int("ZVENA_GUEST_FILE_TTL_DAYS", 30);
  },
  /** …and the app warns the guest this many days before. */
  get guestWarnDays() {
    return int("ZVENA_GUEST_WARN_DAYS", 7);
  },
  /** Guests (no account) upload pictures only: this many MB per guest… */
  get guestUploadMb() {
    return int("ZVENA_GUEST_UPLOAD_MB", 20);
  },
  /** …this many MB a day from one network (IPv4 address or IPv6 /64)… */
  get guestUploadMbPerIp() {
    return int("ZVENA_GUEST_UPLOAD_MB_PER_IP", 60);
  },
  /** …and this many MB a day from all guests together (0 = guests cannot upload). */
  get guestUploadMbPerDay() {
    return int("ZVENA_GUEST_UPLOAD_MB_PER_DAY", 1000);
  },
  /** Longest side of an uploaded photo after compression (px). */
  get imageMaxSide() {
    return int("ZVENA_IMAGE_MAX_SIDE", 2560);
  },
  /** Invite links live this many days by default. */
  get inviteDays() {
    return int("ZVENA_INVITE_DAYS", 14);
  },
  // Page history (lib/notes/versions.ts). Versions never count towards the
  // storage quota; a workspace's history has its own hard cap.
  /** One person's edits within this many minutes make one version. */
  get versionsGapMinutes() {
    return int("ZVENA_VERSIONS_GAP_MINUTES", 10);
  },
  /** The newest versions of a page always kept… */
  get versionsKeepNewest() {
    return int("ZVENA_VERSIONS_KEEP_NEWEST", 200);
  },
  /** …and every version newer than this many days… */
  get versionsKeepDays() {
    return int("ZVENA_VERSIONS_KEEP_DAYS", 30);
  },
  /** …older ones thinned to one a day, and gone after this many days. */
  get versionsMaxDays() {
    return int("ZVENA_VERSIONS_MAX_DAYS", 365);
  },
  /** A page deleted forever keeps its versions this many days, then they go too. */
  get versionsDeletedDays() {
    return int("ZVENA_VERSIONS_DELETED_DAYS", 30);
  },
  /** All versions of one workspace (compressed bytes); past it the oldest go first. */
  get versionsWorkspaceBytes() {
    return int("ZVENA_VERSIONS_WORKSPACE_BYTES", 256 * 1024 ** 2);
  },
  /**
   * The test sign-in ("Sign in as a test user"): only on a test stand,
   * never in production. Both flags are needed.
   */
  get devLogin() {
    return process.env.ZVENA_DEV_LOGIN === "1" && process.env.ZVENA_STAND === "test";
  },
  /** Test stand: noindex everywhere and a banner. */
  get isTestStand() {
    return process.env.ZVENA_STAND === "test";
  },
  /** The current version of the Terms and Privacy Policy people agree to (a date). */
  get consentVersion() {
    return (process.env.ZVENA_CONSENT_VERSION || "2026-10-15").trim();
  },
  /** The effective date shown on the legal texts (YYYY-MM-DD). Kept apart from
   *  consentVersion, which is only a label of what people accepted: changing
   *  that one makes everyone accept again, and it may run ahead of the
   *  calendar. Move LEGAL_UPDATED with every change to the texts. */
  get legalUpdated() {
    const v = (process.env.ZVENA_LEGAL_UPDATED || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : LEGAL_UPDATED;
  },
  /** Who runs this server and how to reach them. Contact addresses default to
   *  addresses on the app's own domain; set them in the environment. */
  get company() {
    const email = (process.env.ZVENA_CONTACT_EMAIL || "").trim() || `admin@${ownHost()}`;
    return {
      name: (process.env.ZVENA_COMPANY_NAME || "").trim() || "the operator of this server",
      email,
      /** Help with using zvena (Help center, questions, bugs); everything else goes to `email`. */
      supportEmail: (process.env.ZVENA_SUPPORT_EMAIL || "").trim() || email,
      privacyEmail: (process.env.ZVENA_PRIVACY_EMAIL || "").trim() || email,
      abuseEmail: (process.env.ZVENA_ABUSE_EMAIL || "").trim() || email,
    };
  },
  /** Where people get the source of the version this server runs (AGPL 3.0 §13):
   *  an operator who changes zvena points this at their own repository. */
  get sourceUrl() {
    return url("ZVENA_SOURCE_URL", "https://github.com/Zvena-app/zvena-oss");
  },
  /** The operator's own Terms of Service and Privacy Policy (/legal/terms and
   *  /legal/privacy send visitors there; see components/zvena/OperatorLegal). */
  get legal() {
    const link = (name: string) => {
      const v = (process.env[name] || "").trim();
      return /^https?:\/\//.test(v) ? v : "";
    };
    return { termsUrl: link("ZVENA_TERMS_URL"), privacyUrl: link("ZVENA_PRIVACY_URL") };
  },
};
