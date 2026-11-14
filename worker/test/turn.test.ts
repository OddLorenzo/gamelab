import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTurn } from '../src/turn';

const BASE = 'https://signal.test';
const STUN = { urls: ['stun:stun.cloudflare.com:3478'] };
const PROVIDER_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys/test-key-id/credentials/generate';
const TOKEN = 'test-token-SECRET-9f3a';

type IceServer = { urls: string[]; username?: string; credential?: string };
type TurnBody = { iceServers: IceServer[]; ttlSec: number };

let ipCounter = 0;
/** A fresh client IP per test so rate-limit state never leaks between tests. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function getTurn(ip: string | null, method = 'GET'): Promise<Response> {
  const headers: Record<string, string> = {};
  if (ip !== null) headers['CF-Connecting-IP'] = ip;
  return exports.default.fetch(`${BASE}/turn`, { method, headers });
}

function providerOk(): Response {
  return new Response(
    JSON.stringify({
      iceServers: {
        urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'prov-user',
        credential: 'prov-credential',
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl as typeof fetch);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Env as the worker sees it when the TURN secrets were never set. */
function envWithoutSecrets(): Cloudflare.Env {
  return { ROOM: env.ROOM, RATE_LIMITER: env.RATE_LIMITER } as Cloudflare.Env;
}

describe('GET /turn', () => {
  it('returns ttlSec 3600, the STUN entry and the provider TURN entry, with no-store', async () => {
    stubFetch(async () => providerOk());
    const res = await getTurn(freshIp());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as TurnBody;
    expect(body.ttlSec).toBe(3600);
    expect(body.iceServers).toContainEqual(STUN);
    const turn = body.iceServers.find((s) => s.urls.some((u) => /^turns?:/.test(u)));
    expect(turn).toBeDefined();
    expect(turn!.username).toBe('prov-user');
    expect(turn!.credential).toBe('prov-credential');
    expect(turn!.urls).toContain('turn:turn.cloudflare.com:3478?transport=udp');
    // the response is a flat array, not the provider's object
    expect(Array.isArray(body.iceServers)).toBe(true);
  });

  it('calls the provider once with the exact URL, bearer token, JSON headers and body ttl 3600', async () => {
    const spy = stubFetch(async () => providerOk());
    await getTurn(freshIp());
    expect(spy).toHaveBeenCalledTimes(1);
    const [input, init] = spy.mock.calls[0];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    expect(url).toBe(PROVIDER_URL);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ ttl: 3600 });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('never puts the secrets in any response body (success or fallback)', async () => {
    stubFetch(async () => providerOk());
    const ok = await (await getTurn(freshIp())).text();
    expect(ok).not.toContain(TOKEN);
    expect(ok).not.toContain('test-key-id');

    stubFetch(async () => new Response(`boom ${TOKEN} test-key-id`, { status: 500 }));
    const failed = await (await getTurn(freshIp())).text();
    expect(failed).not.toContain(TOKEN);
    expect(failed).not.toContain('test-key-id');

    // rate-limited response too
    const ip = freshIp();
    for (let i = 0; i < 20; i++) await getTurn(ip);
    const limited = await getTurn(ip);
    expect(limited.status).toBe(429);
    expect(await limited.text()).not.toContain(TOKEN);
  });

  it('returns 405 with Allow: GET for POST', async () => {
    const spy = stubFetch(async () => providerOk());
    const res = await getTurn(freshIp(), 'POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(await res.json()).toEqual({ error: 'method-not-allowed' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('provider failure falls back to STUN only', () => {
  async function expectStunOnly(res: Response, secretLeaks: string[] = []): Promise<void> {
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as TurnBody;
    expect(body).toEqual({ iceServers: [STUN], ttlSec: 3600 });
    for (const leak of secretLeaks) expect(text).not.toContain(leak);
  }

  it('network error', async () => {
    stubFetch(async () => {
      throw new TypeError('connect ECONNREFUSED provider-error-text');
    });
    await expectStunOnly(await getTurn(freshIp()), ['ECONNREFUSED', 'provider-error-text']);
  });

  it('HTTP 500 with an error body', async () => {
    stubFetch(async () => new Response('provider-error-text internal', { status: 500 }));
    await expectStunOnly(await getTurn(freshIp()), ['provider-error-text']);
  });

  it('HTTP 401', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: 'provider-error-text' }), { status: 401 }));
    await expectStunOnly(await getTurn(freshIp()), ['provider-error-text']);
  });

  it('a non-2xx is ignored even when its body looks like valid credentials', async () => {
    stubFetch(async () => new Response(await providerOk().text(), { status: 503 }));
    await expectStunOnly(await getTurn(freshIp()));
  });

  it('invalid JSON on a 200', async () => {
    stubFetch(async () => new Response('<html>provider-error-text</html>', { status: 200 }));
    await expectStunOnly(await getTurn(freshIp()), ['provider-error-text']);
  });

  it('a 200 with the wrong shape (no TURN urls / no credential)', async () => {
    stubFetch(async () => new Response(JSON.stringify({ iceServers: { urls: ['stun:x:3478'] } }), { status: 200 }));
    await expectStunOnly(await getTurn(freshIp()));
    stubFetch(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expectStunOnly(await getTurn(freshIp()));
  });

  it('a stalled provider is aborted by the 5 s timeout signal', { timeout: 15_000 }, async () => {
    let sawSignal: AbortSignal | undefined;
    stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          sawSignal = init?.signal ?? undefined;
          sawSignal?.addEventListener('abort', () => reject(sawSignal!.reason));
        }),
    );
    const started = Date.now();
    await expectStunOnly(await getTurn(freshIp()));
    const elapsed = Date.now() - started;
    expect(sawSignal).toBeDefined();
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(9000);
  });

  it('with the secrets missing the provider is never called and the response is STUN only', async () => {
    const spy = stubFetch(async () => providerOk());
    const res = await handleTurn(new Request(`${BASE}/turn`, { headers: { 'CF-Connecting-IP': freshIp() } }), envWithoutSecrets());
    await expectStunOnly(res);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(spy).not.toHaveBeenCalled();

    // one secret missing is also "not configured"
    const half = { ...envWithoutSecrets(), TURN_KEY_ID: 'only-id' } as Cloudflare.Env;
    await expectStunOnly(await handleTurn(new Request(`${BASE}/turn`, { headers: { 'CF-Connecting-IP': freshIp() } }), half));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('rate limit', () => {
  it('the 20th request passes, the 21st gets 429 with Retry-After; a different IP is unaffected', async () => {
    stubFetch(async () => providerOk());
    const ip = freshIp();
    for (let i = 1; i <= 20; i++) {
      const res = await getTurn(ip);
      expect(res.status, `request ${i}`).toBe(200);
    }
    const limited = await getTurn(ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate-limited' });
    const retry = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(limited.headers.get('cache-control')).toBe('no-store');

    // still limited on the next try
    expect((await getTurn(ip)).status).toBe(429);

    const other = await getTurn(freshIp());
    expect(other.status).toBe(200);
  });

  it('the provider is not called for a rate-limited request', async () => {
    const spy = stubFetch(async () => providerOk());
    const ip = freshIp();
    for (let i = 0; i < 20; i++) await getTurn(ip);
    expect(spy).toHaveBeenCalledTimes(20);
    await getTurn(ip);
    expect(spy).toHaveBeenCalledTimes(20);
  });

  it('applies even when the provider is not configured', async () => {
    const spy = stubFetch(async () => providerOk());
    const ip = freshIp();
    const mk = () => new Request(`${BASE}/turn`, { headers: { 'CF-Connecting-IP': ip } });
    for (let i = 0; i < 20; i++) expect((await handleTurn(mk(), envWithoutSecrets())).status).toBe(200);
    const res = await handleTurn(mk(), envWithoutSecrets());
    expect(res.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it('requests without CF-Connecting-IP share one constant bucket', async () => {
    stubFetch(async () => providerOk());
    // use the DO directly to assert on the bucket is overkill; observe via responses.
    // Another test may already have used the constant bucket, so just drain it.
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await getTurn(null)).status === 429;
    expect(limited).toBe(true);
    expect((await getTurn(freshIp())).status).toBe(200);
  });

  it('the counter resets when the window alarm fires (and the alarm empties storage)', async () => {
    stubFetch(async () => providerOk());
    const ip = freshIp();
    for (let i = 0; i < 20; i++) await getTurn(ip);
    expect((await getTurn(ip)).status).toBe(429);

    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    const alarmAt = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    const delta = alarmAt! - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(60_000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.list())).toEqual(new Map());

    expect((await getTurn(ip)).status).toBe(200);
  });

  it('the counter resets when the window has passed even if the alarm has not fired yet', async () => {
    stubFetch(async () => providerOk());
    const ip = freshIp();
    for (let i = 0; i < 20; i++) await getTurn(ip);
    expect((await getTurn(ip)).status).toBe(429);

    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    // age the stored window by 61 s, as if the clock had moved on
    await runInDurableObject(stub, async (_i, state) => {
      const all = await state.storage.list();
      const aged: Record<string, unknown> = {};
      for (const [k, v] of all) {
        aged[k] = typeof v === 'number' && v > 1_000_000_000_000 ? v - 61_000 : v;
      }
      await state.storage.put(aged);
    });
    expect((await getTurn(ip)).status).toBe(200);
  });

  it('a request inside the window does not extend it (fixed window)', async () => {
    stubFetch(async () => providerOk());
    const ip = freshIp();
    await getTurn(ip);
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    const first = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    await new Promise((r) => setTimeout(r, 30));
    await getTurn(ip);
    const second = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(second).toBe(first);
  });
});
