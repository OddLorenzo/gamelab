/**
 * CORS and origin policy.
 *
 * `ALLOWED_ORIGINS` is a comma-separated list of exact origins (scheme://host[:port], no path, no
 * trailing slash). Matching is exact and case-sensitive. There is no wildcard: a literal `*`
 * entry is dropped. A missing or empty value allows no origin (fail closed).
 *
 * A request WITHOUT an `Origin` header (curl, server-side tools) is let through: non-browser
 * clients can send any header anyway, so this check protects users' browsers, not the Worker
 * from scripts. A request WITH an unlisted `Origin` (including the string "null" sent by sandboxed
 * iframes) is refused before any Durable Object or provider call.
 */
export function parseAllowedOrigins(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (entry !== '' && entry !== '*') out.add(entry);
  }
  return out;
}

/** The request's `Origin` when it is allowed, null when it is absent or not listed. */
export function allowedOriginOf(request: Request, env: Cloudflare.Env): string | null {
  const origin = request.headers.get('Origin');
  if (origin === null) return null;
  return parseAllowedOrigins(env.ALLOWED_ORIGINS).has(origin) ? origin : null;
}

export const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
} as const;

/** Copy of `res` with the CORS headers for `origin`. A WebSocket upgrade (101) is returned untouched: browsers do not use CORS for it. */
export function withCors(res: Response, origin: string): Response {
  if (res.status === 101) return res;
  const copy = new Response(res.body, res);
  copy.headers.set('Access-Control-Allow-Origin', origin);
  copy.headers.append('Vary', 'Origin');
  return copy;
}
