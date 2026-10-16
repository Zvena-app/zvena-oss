// A tiny OpenID Connect provider for the unit tests (127.0.0.1, a random
// port): discovery, keys, and a token endpoint that checks the client
// secret, the code, PKCE and the redirect URI, and answers with an RS256 ID
// token. `authorize()` stands in for the provider's sign-in page.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface Who {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  upn?: string;
  name?: string;
}

export interface Twist {
  aud?: string;
  nonce?: string;
  iss?: string;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
  exp?: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class MockOidc {
  server: Server;
  issuer = "";
  readonly clientId = "zvena-test-client";
  readonly clientSecret = randomBytes(16).toString("hex");
  private key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private codes = new Map<string, { who: Who; nonce: string; challenge: string; redirect: string; twist: Twist }>();
  tokenCalls = 0;

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", this.issuer);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/openid-configuration") {
        return send(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (url.pathname === "/jwks") return send(200, { keys: [{ ...(this.key.publicKey.export({ format: "jwk" }) as object), kid: "k1", alg: "RS256", use: "sig" }] });
      if (url.pathname === "/token" && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          this.tokenCalls++;
          const form = new URLSearchParams(raw);
          const basic = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
          const [id, secret] = basic.split(":").map(decodeURIComponent);
          if (id !== this.clientId || secret !== this.clientSecret) return send(401, { error: "invalid_client" });
          const c = this.codes.get(form.get("code") ?? "");
          this.codes.delete(form.get("code") ?? "");
          if (!c) return send(400, { error: "invalid_grant" });
          if (form.get("redirect_uri") !== c.redirect) return send(400, { error: "invalid_grant", error_description: "redirect_uri" });
          if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return send(400, { error: "invalid_grant", error_description: "pkce" });
          const now = Math.floor(Date.now() / 1000);
          const claims = { ...c.who, iss: c.twist.iss ?? this.issuer, aud: c.twist.aud ?? this.clientId, iat: now, exp: c.twist.exp ?? now + 300, nonce: c.twist.nonce ?? c.nonce, jti: randomBytes(8).toString("hex") };
          send(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: this.jwt(claims, c.twist.foreignKey ? this.other.privateKey : this.key.privateKey) });
        });
        return;
      }
      send(404, { error: "not found" });
    });
  }

  private jwt(claims: Record<string, unknown>, key: KeyObject): string {
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
    const body = b64u(JSON.stringify(claims));
    return `${head}.${body}.${b64u(sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key))}`;
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.issuer = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  /** The provider's sign-in page: the person is `who`; returns the redirect back (the callback's query). */
  authorize(authUrl: string, who: Who, twist: Twist = {}): URLSearchParams {
    const u = new URL(authUrl);
    if (u.searchParams.get("client_id") !== this.clientId || u.searchParams.get("code_challenge_method") !== "S256") throw new Error("bad authorization request");
    const code = randomBytes(12).toString("hex");
    this.codes.set(code, { who, nonce: u.searchParams.get("nonce") ?? "", challenge: u.searchParams.get("code_challenge") ?? "", redirect: u.searchParams.get("redirect_uri") ?? "", twist });
    return new URLSearchParams({ code, state: u.searchParams.get("state") ?? "", iss: this.issuer });
  }
}
