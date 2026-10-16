// Server-only: per-person budgets for what the server fetches on someone's
// behalf (Mail's remote pictures, the Web Clipper's downloads): requests a
// minute and bytes a day. The per-IP limiter (rate-limit.ts) cannot stop one
// account behind many addresses from using our server and bandwidth as a
// download relay. In-process, like the limiter: a restart forgets them,
// which errs on the side of the person.

const DAY = 86_400_000;
const MINUTE = 60_000;

interface Budget {
  day: number;
  bytes: Map<string, number>;
  minute: Map<string, number[]>;
}

const KEY = Symbol.for("zvena.byte-budget");
const g = globalThis as unknown as Record<symbol, Map<string, Budget> | undefined>;
const scopes: Map<string, Budget> = (g[KEY] ??= new Map());

function scope(name: string, now: number): Budget {
  const day = Math.floor(now / DAY);
  let b = scopes.get(name);
  if (!b || b.day !== day) {
    b = { day, bytes: new Map(), minute: b?.minute ?? new Map() };
    scopes.set(name, b);
  }
  return b;
}

/** A megabyte budget from the environment (unset or invalid: the default). */
export function mbFromEnv(name: string, fallbackMb: number): number {
  const v = Number(process.env[name]);
  return (Number.isFinite(v) && v > 0 ? v : fallbackMb) * 1024 * 1024;
}

/** Bytes `who` may still fetch today in `name` (out of `cap`). */
export function bytesLeft(name: string, who: string, cap: number, now = Date.now()): number {
  return Math.max(0, cap - (scope(name, now).bytes.get(who) ?? 0));
}

/** Counts `n` fetched bytes against today's budget of `who` (a negative `n` gives back what a reservation did not use). */
export function spendBytes(name: string, who: string, n: number, now = Date.now()): void {
  const b = scope(name, now);
  b.bytes.set(who, Math.max(0, (b.bytes.get(who) ?? 0) + n));
}

/** One request of `who` in `name`; false when they made `limit` in the last minute. */
export function perPersonRate(name: string, who: string, limit: number, now = Date.now()): boolean {
  const b = scope(name, now);
  if (b.minute.size > 5000) for (const [k, v] of b.minute) if (!v.length || now - v[v.length - 1] >= MINUTE) b.minute.delete(k);
  const arr = (b.minute.get(who) ?? []).filter((t) => now - t < MINUTE);
  if (arr.length >= limit) {
    b.minute.set(who, arr);
    return false;
  }
  arr.push(now);
  b.minute.set(who, arr);
  return true;
}
