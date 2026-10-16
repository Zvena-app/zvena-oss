/**
 * Bounded JSON parsing: reject hostile bodies BEFORE they become memory.
 *
 * `req.json()` buffers the whole body; a missing/lying Content-Length means
 * the only real guard is measured length. Read the body as a stream, stop at
 * the byte budget, then parse. Same idea for upstream fetches: honor Content-Length when
 * present, otherwise stream with a cumulative cap.
 *
 * Framework-free (no next/server import) so unit tests can run under plain
 * node: failures carry an HTTP status; routes render the JSON envelope.
 */

export type CappedJson =
  | { ok: true; raw: string; value: unknown }
  | { ok: false; status: 400 | 413 };

/**
 * The request body as bytes, read as a stream and cut off at `maxBytes`:
 * a body without Content-Length (chunked) never grows past the budget.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 }> {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) return { ok: false, status: 413 };
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already closed — nothing to release.
        }
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

export async function readJsonCapped(req: Request, maxBytes = 2_000_000): Promise<CappedJson> {
  const body = await readBodyCapped(req, maxBytes);
  if (!body.ok) return body;
  const raw = new TextDecoder().decode(body.bytes);
  if (!raw.trim()) {
    return { ok: false, status: 400 };
  }
  try {
    return { ok: true, raw, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * Bounded text fetch for upstream documents (RSS/XML). Decodes with the
 * charset from Content-Type or the XML prolog (some feeds are windows-1251).
 */
export async function fetchTextCapped(
  url: string,
  init: RequestInit,
  maxBytes = 2_000_000
): Promise<{ ok: true; text: string } | { ok: false }> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    return { ok: false };
  }
  if (!r.ok || !r.body) return { ok: false };
  if (Number(r.headers.get("content-length") ?? "0") > maxBytes) {
    try {
      await r.body.cancel();
    } catch {
      // Already closed — nothing to release.
    }
    return { ok: false };
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already closed — nothing to release.
        }
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false };
  }
  const bytes = Buffer.concat(chunks);
  const label =
    /charset=([\w-]+)/i.exec(r.headers.get("content-type") ?? "")?.[1] ??
    /^<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(bytes.subarray(0, 200).toString("latin1"))?.[1] ??
    "utf-8";
  try {
    return { ok: true, text: new TextDecoder(label.toLowerCase()).decode(bytes) };
  } catch {
    return { ok: true, text: new TextDecoder().decode(bytes) };
  }
}

export async function fetchJsonCapped(
  url: string,
  init: RequestInit,
  maxBytes = 2_000_000
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    return { ok: false };
  }
  if (!r.ok || !r.body) return { ok: false };
  const declared = Number(r.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    try {
      await r.body.cancel();
    } catch {
      // Already closed — nothing to release.
    }
    return { ok: false };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (text.length > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already closed — nothing to release.
        }
        return { ok: false };
      }
    }
    text += dec.decode();
  } catch {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
