import type { RateDecision } from './rate-limiter';

/** One bucket per route class; each client IP has its own counter per bucket. */
export type Bucket = 'turn' | 'rooms' | 'ws';

/** Requests allowed per 60 s window and client. A normal join uses 2 `ws` calls (preflight + upgrade), a create 1 `rooms` call. */
export const BUCKET_LIMITS: Readonly<Record<Bucket, number>> = { turn: 20, rooms: 10, ws: 40 };

export const NO_IP = 'no-ip';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

function parseIpv4(s: string): number[] | null {
  const m = IPV4_RE.exec(s);
  if (m === null) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** The 8 hextets (numbers) of an IPv6 address, or null when `s` is not one. */
function parseIpv6(s: string): number[] | null {
  let text = s;
  // a trailing dotted IPv4 stands for the last two hextets
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || !groups.every((g) => HEXTET_RE.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The key a client is counted under. IPv4 stays as is; IPv6 collapses to its /64 prefix (one
 * subscriber owns a whole /64, so per-address counting would be no limit at all), written as
 * four lowercase hextets without leading zeros (`2001:db8:1:2`); an IPv4-mapped IPv6 address
 * counts as that IPv4 address. A missing or unparseable header shares the constant `no-ip`.
 */
export function ipKey(raw: string | null | undefined): string {
  const ip = (raw ?? '').trim().toLowerCase().replace(/%.*$/, '');
  if (ip === '') return NO_IP;
  const v4 = parseIpv4(ip);
  if (v4 !== null) return v4.join('.');
  if (!ip.includes(':')) return NO_IP;
  const g = parseIpv6(ip);
  if (g === null) return NO_IP;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':');
}

/**
 * Count this request against `bucket` for the caller's IP. Returns the 429 response when the
 * limit is hit, null when the request may go on. Call it only AFTER the origin check and
 * BEFORE any Room or provider call.
 */
export async function rateLimited(request: Request, env: Cloudflare.Env, bucket: Bucket): Promise<Response | null> {
  const key = `${bucket}:${ipKey(request.headers.get('CF-Connecting-IP'))}`;
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key)) as unknown as {
    hit(limit: number): Promise<RateDecision>;
  };
  const decision = await stub.hit(BUCKET_LIMITS[bucket]);
  if (decision.ok) return null;
  return new Response(JSON.stringify({ error: 'rate-limited' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(decision.retryAfterSec) },
  });
}
