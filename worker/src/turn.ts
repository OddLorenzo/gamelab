import { rateLimited } from './limits';

export const TURN_TTL_SEC = 3600;
const PROVIDER_TIMEOUT_MS = 5000;
const STUN = { urls: ['stun:stun.cloudflare.com:3478'] };

type IceServer = { urls: string[]; username?: string; credential?: string };

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Ask the provider for one short-lived TURN credential.
 *
 * ASSUMED provider response shape (from Cloudflare Realtime TURN docs, not yet
 * verified against the live API; the owner verifies this at deploy time):
 *   { iceServers: { urls: string[], username: string, credential: string } }
 * Note `iceServers` is a single OBJECT there, not an array. Returns null on any
 * failure (missing secrets, network error, timeout, non-2xx, bad JSON, wrong
 * shape) so the caller falls back to STUN only. Error text is never forwarded.
 */
async function fetchTurnServer(env: Cloudflare.Env): Promise<IceServer | null> {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return null;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_SEC }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { iceServers?: { urls?: unknown; username?: unknown; credential?: unknown } };
    const s = data?.iceServers;
    if (!s || !Array.isArray(s.urls) || typeof s.username !== 'string' || typeof s.credential !== 'string') return null;
    const urls = s.urls.filter((u): u is string => typeof u === 'string' && /^turns?:/.test(u));
    if (urls.length === 0 || !s.username || !s.credential) return null;
    return { urls, username: s.username, credential: s.credential };
  } catch {
    return null;
  }
}

export async function handleTurn(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });

  const limited = await rateLimited(request, env, 'turn');
  if (limited) return limited;

  const turn = await fetchTurnServer(env);
  return json({ iceServers: turn ? [STUN, turn] : [STUN], ttlSec: TURN_TTL_SEC }, 200);
}
