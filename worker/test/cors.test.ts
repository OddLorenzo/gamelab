import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const BASE = 'https://signal.test';
const OK = 'https://game.example';
const OK2 = 'http://localhost:5173';
const EVIL = 'https://evil.example';

let ipCounter = 100;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function providerOk(): Response {
  return new Response(
    JSON.stringify({ iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubProvider() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((async () => providerOk()) as typeof fetch);
}

afterEach(() => {
  vi.restoreAllMocks();
});

type Init = { method?: string; origin?: string | null; ip?: string; headers?: Record<string, string> };

function call(path: string, { method = 'GET', origin = null, ip, headers = {} }: Init = {}): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (origin !== null) h.Origin = origin;
  h['CF-Connecting-IP'] = ip ?? freshIp();
  return exports.default.fetch(`${BASE}${path}`, { method, headers: h });
}

/** Env as the Worker sees it with a different (or missing) ALLOWED_ORIGINS. */
function envWith(allowed: string | undefined): Cloudflare.Env {
  const e = { ROOM: env.ROOM, RATE_LIMITER: env.RATE_LIMITER, TURN_KEY_ID: 'test-key-id', TURN_API_TOKEN: 'tok' } as Cloudflare.Env;
  if (allowed !== undefined) e.ALLOWED_ORIGINS = allowed;
  return e;
}

function withEnv(allowed: string | undefined, path: string, init: Init = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.origin !== undefined && init.origin !== null) headers.set('Origin', init.origin);
  headers.set('CF-Connecting-IP', init.ip ?? freshIp());
  return worker.fetch(new Request(`${BASE}${path}`, { method: init.method ?? 'GET', headers }), envWith(allowed));
}

/** An env whose Durable Object namespaces record every use. */
function spyEnv(allowed: string | undefined) {
  const roomGet = vi.fn(() => {
    throw new Error('Room DO must not be reached');
  });
  const limiterGet = vi.fn(() => {
    throw new Error('RateLimiter DO must not be reached');
  });
  const e = {
    ROOM: { idFromName: vi.fn(() => 'id'), get: roomGet },
    RATE_LIMITER: { idFromName: vi.fn(() => 'id'), get: limiterGet },
    TURN_KEY_ID: 'test-key-id',
    TURN_API_TOKEN: 'tok',
  } as unknown as Cloudflare.Env;
  if (allowed !== undefined) e.ALLOWED_ORIGINS = allowed;
  return { e, roomGet, limiterGet };
}

function expectCors(res: Response, origin: string): void {
  expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  expect(res.headers.get('vary')).toBe('Origin');
}

function expectNoCors(res: Response): void {
  for (const name of [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-max-age',
    'access-control-allow-credentials',
  ]) {
    expect(res.headers.get(name), name).toBeNull();
  }
  expect(res.headers.get('vary')).toBeNull();
}

async function expectRejected(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'origin-not-allowed' });
  expect(res.headers.get('content-type')).toContain('application/json');
  expectNoCors(res);
}

describe('allowed origin: exact ACAO + Vary on every kind of response', () => {
  it('201 POST /rooms', async () => {
    const res = await call('/rooms', { method: 'POST', origin: OK });
    expect(res.status).toBe(201);
    expectCors(res, OK);
  });

  it('200 GET /turn', async () => {
    stubProvider();
    const res = await call('/turn', { origin: OK, ip: freshIp() });
    expect(res.status).toBe(200);
    expectCors(res, OK);
  });

  it('404 unknown path', async () => {
    const res = await call('/nope', { origin: OK });
    expect(res.status).toBe(404);
    expectCors(res, OK);
  });

  it('404 bad room code on the ws route', async () => {
    const res = await call('/rooms/abc/ws', { origin: OK, headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(404);
    expectCors(res, OK);
  });

  it('405 wrong method on /rooms and /turn', async () => {
    const a = await call('/rooms', { method: 'GET', origin: OK });
    expect(a.status).toBe(405);
    expectCors(a, OK);
    const b = await call('/turn', { method: 'POST', origin: OK, ip: freshIp() });
    expect(b.status).toBe(405);
    expectCors(b, OK);
  });

  it('426 from the Room when the ws route is hit without an Upgrade header', async () => {
    const created = await call('/rooms', { method: 'POST', origin: OK });
    const { code } = (await created.json()) as { code: string };
    const res = await call(`/rooms/${code}/ws`, { origin: OK });
    expect(res.status).toBe(426);
    expectCors(res, OK);
  });

  it('429 rate-limited /turn', async () => {
    stubProvider();
    const ip = freshIp();
    for (let i = 0; i < 20; i++) expect((await call('/turn', { origin: OK, ip })).status).toBe(200);
    const res = await call('/turn', { origin: OK, ip });
    expect(res.status).toBe(429);
    expectCors(res, OK);
    expect(res.headers.get('retry-after')).not.toBeNull();
  });

  it('503 when the Room cannot be created', async () => {
    const e = {
      ...envWith(OK),
      ROOM: { idFromName: () => 'id', get: () => ({ fetch: async () => new Response('x', { status: 500 }) }) },
    } as unknown as Cloudflare.Env;
    const res = await worker.fetch(new Request(`${BASE}/rooms`, { method: 'POST', headers: { Origin: OK } }), e);
    expect(res.status).toBe(503);
    expectCors(res, OK);
  });

  it('echoes the exact origin, whichever listed entry it is', async () => {
    expectCors(await call('/nope', { origin: OK2 }), OK2);
    expectCors(await call('/nope', { origin: OK }), OK);
  });

  it('keeps the existing headers (allow, cache-control)', async () => {
    stubProvider();
    const res = await call('/turn', { origin: OK, ip: freshIp() });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const m = await call('/rooms', { method: 'GET', origin: OK });
    expect(m.headers.get('allow')).toBe('POST');
  });
});

describe('unlisted origin is refused with 403 and no CORS headers', () => {
  it('POST /rooms: 403, and no room is created', async () => {
    const { e, roomGet } = spyEnv(OK);
    const res = await worker.fetch(new Request(`${BASE}/rooms`, { method: 'POST', headers: { Origin: EVIL } }), e);
    await expectRejected(res);
    expect(roomGet).not.toHaveBeenCalled();
  });

  it('GET /turn: 403, the provider is not called and the limiter is not touched', async () => {
    const provider = stubProvider();
    const { e, limiterGet } = spyEnv(OK);
    const res = await worker.fetch(new Request(`${BASE}/turn`, { headers: { Origin: EVIL, 'CF-Connecting-IP': freshIp() } }), e);
    await expectRejected(res);
    expect(provider).not.toHaveBeenCalled();
    expect(limiterGet).not.toHaveBeenCalled();
  });

  it('WebSocket upgrade: 403, the Room is not reached', async () => {
    const { e, roomGet } = spyEnv(OK);
    const res = await worker.fetch(new Request(`${BASE}/rooms/ABCD/ws`, { headers: { Origin: EVIL, Upgrade: 'websocket' } }), e);
    await expectRejected(res);
    expect(res.webSocket).toBeNull();
    expect(roomGet).not.toHaveBeenCalled();
  });

  it('through the real Worker: a rejected POST /rooms creates nothing', async () => {
    const rejected = await call('/rooms', { method: 'POST', origin: EVIL });
    await expectRejected(rejected);
    // a rejected ws upgrade to an existing room does not join it either
    const created = await call('/rooms', { method: 'POST', origin: OK });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    const ws = await call(`/rooms/${code}/ws`, { origin: EVIL, headers: { Upgrade: 'websocket' } });
    await expectRejected(ws);
    const ok = await call(`/rooms/${code}/ws`, { origin: OK, headers: { Upgrade: 'websocket' } });
    expect(ok.status).toBe(101);
    ok.webSocket!.accept();
    ok.webSocket!.close();
  });

  it('unknown paths and wrong methods are refused too (no information leak, no CORS)', async () => {
    await expectRejected(await call('/nope', { origin: EVIL }));
    await expectRejected(await call('/rooms', { method: 'GET', origin: EVIL }));
    await expectRejected(await call('/turn', { method: 'POST', origin: EVIL }));
  });

  it('a rejected /turn does not consume rate-limit quota: 20 rejected, then 20 allowed all succeed', async () => {
    const provider = stubProvider();
    const ip = freshIp();
    for (let i = 0; i < 20; i++) await expectRejected(await call('/turn', { origin: EVIL, ip }));
    expect(provider).not.toHaveBeenCalled();
    for (let i = 1; i <= 20; i++) expect((await call('/turn', { origin: OK, ip })).status, `allowed ${i}`).toBe(200);
    expect((await call('/turn', { origin: OK, ip })).status).toBe(429);
  });

  it('the rate limit still applies after the origin check', async () => {
    stubProvider();
    const ip = freshIp();
    for (let i = 0; i < 20; i++) await call('/turn', { origin: OK, ip });
    expect((await call('/turn', { origin: OK, ip })).status).toBe(429);
  });
});

describe('preflight (OPTIONS)', () => {
  it('allowed origin: 204 with the exact CORS headers, on any path', async () => {
    for (const path of ['/rooms', '/turn', '/rooms/ABCD/ws', '/anything']) {
      const res = await call(path, {
        method: 'OPTIONS',
        origin: OK,
        headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      });
      expect(res.status, path).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(OK);
      expect(res.headers.get('vary')).toBe('Origin');
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
      expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
      expect(res.headers.get('access-control-max-age')).toBe('600');
      expect(await res.text()).toBe('');
    }
  });

  it('preflight does not reach the Durable Objects or the provider', async () => {
    const provider = stubProvider();
    const { e, roomGet, limiterGet } = spyEnv(OK);
    const res = await worker.fetch(new Request(`${BASE}/turn`, { method: 'OPTIONS', headers: { Origin: OK } }), e);
    expect(res.status).toBe(204);
    expect(provider).not.toHaveBeenCalled();
    expect(roomGet).not.toHaveBeenCalled();
    expect(limiterGet).not.toHaveBeenCalled();
  });

  it('unlisted origin: 403 JSON without CORS headers', async () => {
    await expectRejected(await call('/rooms', { method: 'OPTIONS', origin: EVIL }));
  });

  it('missing origin: 403 JSON without CORS headers', async () => {
    await expectRejected(await call('/rooms', { method: 'OPTIONS' }));
  });
});

describe('no Origin header passes through (curl, server-side tools)', () => {
  it('POST /rooms, GET /turn, unknown path, ws upgrade: normal behaviour, no CORS headers', async () => {
    stubProvider();
    const rooms = await call('/rooms', { method: 'POST' });
    expect(rooms.status).toBe(201);
    expectNoCors(rooms);
    const { code } = (await rooms.json()) as { code: string };

    const turn = await call('/turn', { ip: freshIp() });
    expect(turn.status).toBe(200);
    expectNoCors(turn);

    const nope = await call('/nope');
    expect(nope.status).toBe(404);
    expectNoCors(nope);

    const ws = await call(`/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
    expect(ws.status).toBe(101);
    ws.webSocket!.accept();
    ws.webSocket!.close();
  });
});

describe('ALLOWED_ORIGINS parsing', () => {
  it('a literal * entry is ignored: nothing is allowed by it', async () => {
    await expectRejected(await withEnv('*', '/nope', { origin: EVIL }));
    await expectRejected(await withEnv('*', '/nope', { origin: OK }));
    await expectRejected(await withEnv('*', '/nope', { method: 'OPTIONS', origin: EVIL }));
  });

  it('a * entry next to real entries ignores only the star', async () => {
    expectCors(await withEnv(`*, ${OK}`, '/nope', { origin: OK }), OK);
    await expectRejected(await withEnv(`*, ${OK}`, '/nope', { origin: EVIL }));
  });

  it('missing ALLOWED_ORIGINS fails closed for every request with an Origin; no-Origin still passes', async () => {
    await expectRejected(await withEnv(undefined, '/nope', { origin: OK }));
    await expectRejected(await withEnv(undefined, '/rooms', { method: 'OPTIONS', origin: OK }));
    const noOrigin = await withEnv(undefined, '/nope');
    expect(noOrigin.status).toBe(404);
    expectNoCors(noOrigin);
  });

  it('empty or blank ALLOWED_ORIGINS fails closed too', async () => {
    for (const raw of ['', '   ', ',,', ' , ']) {
      await expectRejected(await withEnv(raw, '/nope', { origin: OK }));
      await expectRejected(await withEnv(raw, '/nope', { origin: '' }));
      expect((await withEnv(raw, '/nope')).status).toBe(404);
    }
  });

  it('entries are trimmed, empties dropped', async () => {
    const raw = `  ${OK} ,, ${OK2}  ,`;
    expectCors(await withEnv(raw, '/nope', { origin: OK }), OK);
    expectCors(await withEnv(raw, '/nope', { origin: OK2 }), OK2);
    await expectRejected(await withEnv(raw, '/nope', { origin: EVIL }));
  });

  it('matching is case-sensitive and exact', async () => {
    await expectRejected(await call('/nope', { origin: 'HTTPS://GAME.EXAMPLE' }));
    await expectRejected(await call('/nope', { origin: 'https://Game.example' }));
    await expectRejected(await call('/nope', { origin: `${OK}/` }));
    await expectRejected(await call('/nope', { origin: `${OK}/path` }));
    await expectRejected(await call('/nope', { origin: `${OK}:443` }));
    await expectRejected(await call('/nope', { origin: 'http://game.example' }));
    await expectRejected(await call('/nope', { origin: 'https://sub.game.example' }));
    await expectRejected(await call('/nope', { origin: 'https://game.example.evil.example' }));
  });

  it('a trailing slash in the configured entry does not match the real (slash-less) origin', async () => {
    await expectRejected(await withEnv(`${OK}/`, '/nope', { origin: OK }));
  });

  it('the string "null" (sandboxed iframes, file://) is not allowed', async () => {
    await expectRejected(await call('/nope', { origin: 'null' }));
    await expectRejected(await call('/rooms', { method: 'POST', origin: 'null' }));
    await expectRejected(await call('/rooms', { method: 'OPTIONS', origin: 'null' }));
  });
});
