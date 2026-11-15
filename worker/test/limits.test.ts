import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { BUCKET_LIMITS, NO_IP, ipKey } from '../src/limits';

// Each request crosses 2 Durable Objects; a 40-request loop takes a few seconds.
vi.setConfig({ testTimeout: 30_000 });

const BASE = 'https://signal.test';
const OK = 'https://game.example';
const EVIL = 'https://evil.example';

let ipCounter = 0;
/** A fresh client IP per call so counters never leak between tests. */
function freshIp(): string {
  ipCounter += 1;
  return `100.64.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

function call(path: string, init: { method?: string; ip?: string; origin?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.ip !== undefined) headers['CF-Connecting-IP'] = init.ip;
  if (init.origin !== undefined) headers.Origin = init.origin;
  return exports.default.fetch(`${BASE}${path}`, { method: init.method ?? 'GET', headers });
}

const createRoom = (ip: string, origin?: string) => call('/rooms', { method: 'POST', ip, origin });
const probeWs = (ip: string, code = 'ABCD', origin?: string) => call(`/rooms/${code}/ws`, { ip, origin, headers: { Upgrade: 'websocket' } });
const getTurn = (ip: string) => call('/turn', { ip });

afterEach(() => {
  vi.restoreAllMocks();
});

function stubProvider(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
    new Response(
      JSON.stringify({ iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch);
}

async function expectLimited(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: 'rate-limited' });
  expect(res.headers.get('content-type')).toContain('application/json');
  const retry = Number(res.headers.get('retry-after'));
  expect(Number.isInteger(retry)).toBe(true);
  expect(retry).toBeGreaterThanOrEqual(1);
  expect(retry).toBeLessThanOrEqual(60);
}

describe('ipKey', () => {
  const table: [string, string | null | undefined, string][] = [
    ['IPv4 stays as is', '203.0.113.7', '203.0.113.7'],
    ['IPv4 with padding spaces', ' 203.0.113.7 ', '203.0.113.7'],
    ['full IPv6 collapses to the /64', '2001:0db8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2'],
    ['uppercase IPv6 is lowercased', '2001:DB8:AB:CD:1:2:3:4', '2001:db8:ab:cd'],
    ['leading zeros do not matter', '2001:db8:0:0:1:2:3:4', '2001:db8:0:0'],
    [':: in the middle', '2001:db8:1:2::9', '2001:db8:1:2'],
    ['two addresses of one /64 share a key', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2'],
    ['two /64s differ', '2001:db8:1:3::1', '2001:db8:1:3'],
    ['::  expanding inside the prefix', '2001:db8::1', '2001:db8:0:0'],
    ['trailing ::', '2001:db8:1:2:3::', '2001:db8:1:2'],
    ['leading ::', '::1', '0:0:0:0'],
    ['the unspecified address', '::', '0:0:0:0'],
    ['IPv4-mapped (dotted) is that IPv4 address', '::ffff:1.2.3.4', '1.2.3.4'],
    ['IPv4-mapped uppercase', '::FFFF:10.20.30.40', '10.20.30.40'],
    ['IPv4-mapped (hex form)', '::ffff:0102:0304', '1.2.3.4'],
    ['zone id is dropped', 'fe80::1%eth0', 'fe80:0:0:0'],
    ['missing header', null, NO_IP],
    ['undefined', undefined, NO_IP],
    ['empty header', '', NO_IP],
    ['garbage', 'not-an-ip', NO_IP],
    ['IPv4 with a too big octet', '999.1.1.1', NO_IP],
    ['IPv4 with too few octets', '1.2.3', NO_IP],
    ['IPv6 with two ::', '2001::db8::1', NO_IP],
    ['IPv6 with too many groups', '1:2:3:4:5:6:7:8:9', NO_IP],
    ['IPv6 with too few groups', '1:2:3:4', NO_IP],
    ['IPv6 with a non-hex group', '2001:db8:xyz::1', NO_IP],
    ['IPv6 with an over-long group', '2001:db8:12345::1', NO_IP],
    ['IPv6 with a bad dotted tail', '::ffff:1.2.3.999', NO_IP],
    ['a list of addresses', '1.2.3.4, 5.6.7.8', NO_IP],
  ];
  for (const [name, input, expected] of table) {
    it(name, () => expect(ipKey(input)).toBe(expected));
  }
});

describe('POST /rooms is limited per IP (bucket rooms, 10 per minute)', () => {
  it('allows 10 creates and answers the 11th with 429 + Retry-After; another IP is unaffected', async () => {
    expect(BUCKET_LIMITS.rooms).toBe(10);
    const ip = freshIp();
    for (let i = 1; i <= 10; i++) expect((await createRoom(ip)).status, `create ${i}`).toBe(201);
    await expectLimited(await createRoom(ip));
    expect((await createRoom(freshIp())).status).toBe(201);
  });

  it('a limited create never reaches the Room Durable Object (no room, no probe)', async () => {
    const ip = freshIp();
    const roomFetch = vi.fn(async () => new Response('{}', { status: 201 }));
    const roomGet = vi.fn(() => ({ fetch: roomFetch }));
    const e = { ...env, ROOM: { idFromName: () => 'id', get: roomGet } } as unknown as Cloudflare.Env;
    const req = () => new Request(`${BASE}/rooms`, { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
    for (let i = 0; i < 10; i++) expect((await worker.fetch(req(), e)).status).toBe(201);
    expect(roomFetch).toHaveBeenCalledTimes(10);
    expect((await worker.fetch(req(), e)).status).toBe(429);
    expect(roomGet).toHaveBeenCalledTimes(10);
    expect(roomFetch).toHaveBeenCalledTimes(10);
  });

  it('a request refused by the origin policy consumes no quota', async () => {
    const ip = freshIp();
    for (let i = 0; i < 12; i++) expect((await createRoom(ip, EVIL)).status).toBe(403);
    for (let i = 1; i <= 10; i++) expect((await createRoom(ip, OK)).status, `allowed ${i}`).toBe(201);
    expect((await createRoom(ip, OK)).status).toBe(429);
  });

  it('wrong methods (405) do not consume quota', async () => {
    const ip = freshIp();
    for (let i = 0; i < 12; i++) expect((await call('/rooms', { method: 'GET', ip })).status).toBe(405);
    for (let i = 1; i <= 10; i++) expect((await createRoom(ip)).status).toBe(201);
  });

  it('the 429 carries the CORS headers for an allowed origin', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) await createRoom(ip, OK);
    const res = await createRoom(ip, OK);
    expect(res.status).toBe(429);
    expect(res.headers.get('access-control-allow-origin')).toBe(OK);
  });
});

describe('/rooms/:code/ws is limited per IP (bucket ws, 40 per minute, every request counts)', () => {
  it('counts unknown rooms too: 40 probes answer 404, the 41st 429; another IP is unaffected', async () => {
    expect(BUCKET_LIMITS.ws).toBe(40);
    const ip = freshIp();
    for (let i = 1; i <= 40; i++) expect((await probeWs(ip, 'ZZZZ')).status, `probe ${i}`).toBe(404);
    await expectLimited(await probeWs(ip, 'ZZZZ'));
    expect((await probeWs(freshIp(), 'ZZZZ')).status).toBe(404);
  });

  it('counts plain GETs on a live room (426) and malformed codes the same way', async () => {
    const code = ((await (await createRoom(freshIp())).json()) as { code: string }).code;
    const ip = freshIp();
    for (let i = 0; i < 20; i++) expect((await call(`/rooms/${code}/ws`, { ip })).status).toBe(426);
    for (let i = 0; i < 20; i++) expect((await call('/rooms/nope/ws', { ip })).status).toBe(404);
    await expectLimited(await call(`/rooms/${code}/ws`, { ip }));
  });

  it('a limited request never reaches the Room Durable Object', async () => {
    const ip = freshIp();
    const roomFetch = vi.fn(async () => new Response('x', { status: 426 }));
    const roomGet = vi.fn(() => ({ fetch: roomFetch }));
    const e = { ...env, ROOM: { idFromName: () => 'id', get: roomGet } } as unknown as Cloudflare.Env;
    const req = () => new Request(`${BASE}/rooms/ABCD/ws`, { headers: { 'CF-Connecting-IP': ip } });
    for (let i = 0; i < 40; i++) expect((await worker.fetch(req(), e)).status).toBe(426);
    expect(roomFetch).toHaveBeenCalledTimes(40);
    expect((await worker.fetch(req(), e)).status).toBe(429);
    expect(roomFetch).toHaveBeenCalledTimes(40);
  });

  it('a request refused by the origin policy consumes no quota', async () => {
    const ip = freshIp();
    for (let i = 0; i < 45; i++) expect((await probeWs(ip, 'ZZZZ', EVIL)).status).toBe(403);
    for (let i = 1; i <= 40; i++) expect((await probeWs(ip, 'ZZZZ', OK)).status, `allowed ${i}`).toBe(404);
    expect((await probeWs(ip, 'ZZZZ', OK)).status).toBe(429);
  });

  it('a normal join (one preflight GET, one upgrade) uses 2 of the 40', async () => {
    const code = ((await (await createRoom(freshIp())).json()) as { code: string }).code;
    const ip = freshIp();
    expect((await call(`/rooms/${code}/ws`, { ip })).status).toBe(426);
    const up = await probeWs(ip, code);
    expect(up.status).toBe(101);
    up.webSocket!.accept();
    up.webSocket!.close();
    for (let i = 0; i < 38; i++) expect((await probeWs(ip, 'ZZZZ')).status).toBe(404);
    expect((await probeWs(ip, 'ZZZZ')).status).toBe(429);
  });
});

describe('buckets are independent and named bucket:ipKey', () => {
  it('exhausting rooms does not limit turn or ws, and exhausting ws does not limit rooms', async () => {
    stubProvider();
    const ip = freshIp();
    for (let i = 0; i < 11; i++) await createRoom(ip);
    expect((await createRoom(ip)).status).toBe(429);
    expect((await getTurn(ip)).status).toBe(200);
    expect((await probeWs(ip, 'ZZZZ')).status).toBe(404);

    const ip2 = freshIp();
    for (let i = 0; i < 41; i++) await probeWs(ip2, 'ZZZZ');
    expect((await probeWs(ip2, 'ZZZZ')).status).toBe(429);
    expect((await createRoom(ip2)).status).toBe(201);
    expect((await getTurn(ip2)).status).toBe(200);
  });

  it('turn keeps its 20 per minute', async () => {
    stubProvider();
    const ip = freshIp();
    for (let i = 1; i <= 20; i++) expect((await getTurn(ip)).status, `turn ${i}`).toBe(200);
    await expectLimited(await getTurn(ip));
  });

  it('the Durable Object name is bucket, colon, ipKey', async () => {
    const ip = freshIp();
    await createRoom(ip);
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`rooms:${ip}`));
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get('count'))).toBe(1);
    const bare = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    expect(await runInDurableObject(bare, (_i, state) => state.storage.get('count'))).toBeUndefined();
  });
});

describe('IPv6 clients are counted by /64 in every bucket', () => {
  it('rooms: addresses of one /64 share the quota, another /64 does not', async () => {
    const a = '2001:db8:aa:1::1';
    for (let i = 0; i < 10; i++) expect((await createRoom(a)).status).toBe(201);
    expect((await createRoom('2001:0db8:00aa:0001:dead:beef:0:42')).status).toBe(429);
    expect((await createRoom('2001:db8:aa:2::1')).status).toBe(201);
  });

  it('ws: same /64, 40 shared', async () => {
    for (let i = 0; i < 40; i++) await probeWs(`2001:db8:bb:1::${i + 1}`, 'ZZZZ');
    expect((await probeWs('2001:db8:bb:1:9::9', 'ZZZZ')).status).toBe(429);
  });

  it('turn: same /64, 20 shared', async () => {
    stubProvider();
    for (let i = 0; i < 20; i++) expect((await getTurn(`2001:db8:cc:1::${i + 1}`)).status).toBe(200);
    expect((await getTurn('2001:db8:cc:1:ffff::1')).status).toBe(429);
    expect((await getTurn('2001:db8:cc:2::1')).status).toBe(200);
  });

  it('an IPv4-mapped IPv6 address counts as the IPv4 address', async () => {
    for (let i = 0; i < 10; i++) expect((await createRoom('198.51.100.77')).status).toBe(201);
    expect((await createRoom('::ffff:198.51.100.77')).status).toBe(429);
  });
});
