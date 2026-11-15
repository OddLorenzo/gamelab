import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_JOINS, makeId } from '../src/room';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const BASE = 'https://signal.test';
const TEN_MIN = 10 * 60_000;

async function createRoom(): Promise<string> {
  const res = await api(`${BASE}/rooms`, { method: 'POST' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { code: string };
  return body.code;
}

let ipCounter = 0;
/** Every request comes from a fresh client IP so the per-IP limits (see limits.test.ts) never leak between tests. */
function api(url: string, init: RequestInit = {}): Promise<Response> {
  ipCounter += 1;
  const ip = `198.18.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  return exports.default.fetch(url, { ...init, headers: { 'CF-Connecting-IP': ip, ...init.headers } });
}

type Msg = Record<string, unknown>;

class Client {
  readonly msgs: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (e) => {
      const raw = e.data as string;
      try {
        this.msgs.push(JSON.parse(raw) as Msg);
      } catch {
        this.msgs.push({ raw }); // a non-JSON frame such as the keepalive pong
      }
      this.waiters.splice(0).forEach((w) => w());
    });
    ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  async waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for ${label}; msgs=${JSON.stringify(this.msgs)} closed=${JSON.stringify(this.closed)}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  waitCount(n: number): Promise<void> {
    return this.waitFor(() => this.msgs.length >= n, `${n} messages`);
  }

  get id(): string {
    return this.msgs[0].id as string;
  }

  send(value: unknown): void {
    this.ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  }
}

async function connect(code: string): Promise<Client> {
  const res = await api(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  expect(res.webSocket).toBeTruthy();
  return new Client(res.webSocket!);
}

/** Join in order, waiting until each client has its hello + peers. */
async function joinThree(code: string): Promise<[Client, Client, Client]> {
  const a = await connect(code);
  await a.waitCount(2);
  const b = await connect(code);
  await b.waitCount(2);
  const c = await connect(code);
  await c.waitCount(2);
  await a.waitCount(3);
  await b.waitCount(3);
  return [a, b, c];
}

const sorted = (ids: unknown) => [...(ids as string[])].sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('POST /rooms', () => {
  it('returns a 4-letter code from the 23-letter alphabet', async () => {
    const res = await api(`${BASE}/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { code: string };
    expect(Object.keys(body)).toEqual(['code']);
    expect(body.code).toMatch(new RegExp(`^[${ALPHABET}]{4}$`));
  });

  it('only ever uses the alphabet (no I, L, O)', async () => {
    const codes = await Promise.all(Array.from({ length: 40 }, () => createRoom()));
    for (const code of codes) {
      for (const ch of code) expect(ALPHABET).toContain(ch);
    }
  });

  it('gives two rooms different codes', async () => {
    const a = await createRoom();
    const b = await createRoom();
    expect(a).not.toBe(b);
  });

  it('reports a code that already exists as taken (so the router retries)', async () => {
    const code = await createRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const res = await stub.fetch('https://room/init', { method: 'POST' });
    expect(res.status).toBe(409);
  });
});

describe('routing', () => {
  it('unknown route returns 404 not-found', async () => {
    const res = await api(`${BASE}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
  });

  it('wrong method returns 405', async () => {
    const res = await api(`${BASE}/rooms`, { method: 'GET' });
    expect(res.status).toBe(405);
    const code = await createRoom();
    const res2 = await api(`${BASE}/rooms/${code}/ws`, { method: 'POST' });
    expect(res2.status).toBe(405);
  });

  it('non-websocket request to /ws returns 426', async () => {
    const code = await createRoom();
    const res = await api(`${BASE}/rooms/${code}/ws`);
    expect(res.status).toBe(426);
  });

  it('unknown code returns 404 no-room', async () => {
    const res = await api(`${BASE}/rooms/ZZZZ/ws`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no-room' });
  });

  it('malformed codes return 404 no-room', async () => {
    for (const bad of ['ABC', 'ABCDE', 'abcd', 'ABCI', 'ABCL', 'ABCO', 'AB1D', 'AB-D']) {
      const res = await api(`${BASE}/rooms/${bad}/ws`, { headers: { Upgrade: 'websocket' } });
      expect(res.status, bad).toBe(404);
      expect(await res.json(), bad).toEqual({ error: 'no-room' });
    }
  });
});

describe('room signaling', () => {
  it('sends hello then peers to a joiner, and peers updates to the others', async () => {
    const code = await createRoom();
    const a = await connect(code);
    await a.waitCount(2);
    expect(a.msgs[0].type).toBe('hello');
    expect(a.id).toMatch(/^[a-z0-9]{8}$/);
    expect(a.msgs[1]).toEqual({ type: 'peers', ids: [a.id] });

    const b = await connect(code);
    await b.waitCount(2);
    await a.waitCount(3);
    expect(b.id).toMatch(/^[a-z0-9]{8}$/);
    expect(b.id).not.toBe(a.id);
    expect(b.msgs[0]).toEqual({ type: 'hello', id: b.id });
    expect(b.msgs[1].type).toBe('peers');
    expect(sorted(b.msgs[1].ids)).toEqual([a.id, b.id].sort());
    expect(a.msgs[2].type).toBe('peers');
    expect(sorted(a.msgs[2].ids)).toEqual([a.id, b.id].sort());
    expect(a.msgs).toHaveLength(3);
    expect(b.msgs).toHaveLength(2);
  });

  it('3 sockets each get their own hello and a peers update listing all current ids', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    const all = [a.id, b.id, c.id].sort();
    expect(new Set(all).size).toBe(3);
    for (const x of [a, b, c]) {
      expect(x.msgs[0]).toEqual({ type: 'hello', id: x.id });
    }
    expect(sorted(c.msgs[1].ids)).toEqual(all);
    expect(sorted(a.msgs[a.msgs.length - 1].ids)).toEqual(all);
    expect(sorted(b.msgs[b.msgs.length - 1].ids)).toEqual(all);
    // A: hello, peers(1), peers(2), peers(3). B: hello, peers(2), peers(3). C: hello, peers(3)
    expect(a.msgs.map((m) => m.type)).toEqual(['hello', 'peers', 'peers', 'peers']);
    expect(b.msgs.map((m) => m.type)).toEqual(['hello', 'peers', 'peers']);
    expect(c.msgs.map((m) => m.type)).toEqual(['hello', 'peers']);
  });

  it('relays a message from A to B and C but not back to A, with the real from', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    a.send({ type: 'sig', n: 1 });
    await b.waitCount(4);
    await c.waitCount(3);
    expect(b.msgs[3]).toEqual({ type: 'sig', n: 1, from: a.id });
    expect(c.msgs[2]).toEqual({ type: 'sig', n: 1, from: a.id });
    // barrier: B's marker reaches A strictly after any wrongly echoed copy of A's message
    b.send({ type: 'marker' });
    await a.waitCount(5);
    expect(a.msgs).toHaveLength(5);
    expect(a.msgs[4]).toEqual({ type: 'marker', from: b.id });
    expect(a.msgs.filter((m) => m.type === 'sig')).toEqual([]);
  });

  it('overwrites a client-supplied from', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    a.send({ type: 'sig', from: c.id });
    await b.waitCount(4);
    expect(b.msgs[3]).toEqual({ type: 'sig', from: a.id });
    await c.waitCount(3);
    expect(c.msgs[2]).toEqual({ type: 'sig', from: a.id });
  });

  it('closes a 4th socket with 4001 full, and the first three keep working untouched', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    const d = await connect(code);
    await d.waitFor(() => d.closed !== null, '4th socket close');
    expect(d.closed).toEqual({ code: 4001, reason: 'full' });
    expect(d.msgs.filter((m) => m.type === 'peers')).toEqual([]);

    a.send({ type: 'after-full' });
    await b.waitCount(4);
    await c.waitCount(3);
    expect(b.msgs[3]).toEqual({ type: 'after-full', from: a.id });
    expect(c.msgs[2]).toEqual({ type: 'after-full', from: a.id });
    // the rejected socket's join/leave must not have produced extra peers broadcasts
    b.send({ type: 'marker' });
    await a.waitCount(5);
    await c.waitCount(4);
    expect(a.msgs.map((m) => m.type)).toEqual(['hello', 'peers', 'peers', 'peers', 'marker']);
    expect(b.msgs.map((m) => m.type)).toEqual(['hello', 'peers', 'peers', 'after-full']);
    expect(c.msgs.map((m) => m.type)).toEqual(['hello', 'peers', 'after-full', 'marker']);
    expect(a.closed).toBeNull();
    expect(b.closed).toBeNull();
    expect(c.closed).toBeNull();
    expect(d.msgs.find((m) => m.type === 'after-full')).toBeUndefined();
  });

  it('broadcasts peers to the rest when a socket leaves', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    c.ws.close(1000, 'bye');
    await a.waitCount(5);
    await b.waitCount(4);
    expect(a.msgs[4].type).toBe('peers');
    expect(sorted(a.msgs[4].ids)).toEqual([a.id, b.id].sort());
    expect(b.msgs[3].type).toBe('peers');
    expect(sorted(b.msgs[3].ids)).toEqual([a.id, b.id].sort());
    expect(a.msgs).toHaveLength(5);
    expect(b.msgs).toHaveLength(4);
  });

  it('lets a new socket take the freed slot after a leave', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    c.ws.close(1000, 'bye');
    await a.waitCount(5);
    const d = await connect(code);
    await d.waitCount(2);
    expect(d.closed).toBeNull();
    expect(sorted(d.msgs[1].ids)).toEqual([a.id, b.id, d.id].sort());
  });

  it('drops invalid JSON, non-object JSON and oversize messages without closing the socket', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    a.send('this is not json');
    a.send('[1,2,3]');
    a.send('42');
    a.send('null');
    a.send('"str"');
    a.send(JSON.stringify({ pad: 'x'.repeat(16 * 1024) })); // over the limit
    a.send({ type: 'ok' });
    await b.waitCount(4);
    await c.waitCount(3);
    expect(b.msgs).toHaveLength(4);
    expect(b.msgs[3]).toEqual({ type: 'ok', from: a.id });
    expect(c.msgs).toHaveLength(3);
    expect(c.msgs[2]).toEqual({ type: 'ok', from: a.id });
    expect(a.closed).toBeNull();
    b.send({ type: 'back' });
    await a.waitCount(5);
    expect(a.msgs[4]).toEqual({ type: 'back', from: b.id });
  });

  it('relays a message of exactly 16 KB and drops one byte more', async () => {
    const code = await createRoom();
    const [a, b] = await joinThree(code);
    const overhead = JSON.stringify({ pad: '' }).length;
    const exact = JSON.stringify({ pad: 'x'.repeat(16 * 1024 - overhead) });
    expect(new TextEncoder().encode(exact).byteLength).toBe(16 * 1024);
    const over = JSON.stringify({ pad: 'x'.repeat(16 * 1024 - overhead + 1) });
    a.send(over);
    a.send(exact);
    await b.waitCount(4);
    expect(b.msgs).toHaveLength(4);
    expect((b.msgs[3].pad as string).length).toBe(16 * 1024 - overhead);
    expect(b.msgs[3].from).toBe(a.id);
  });

  it('drops binary messages without closing the socket', async () => {
    const code = await createRoom();
    const [a, b] = await joinThree(code);
    a.ws.send(new TextEncoder().encode('{"type":"bin"}'));
    a.send({ type: 'ok' });
    await b.waitCount(4);
    expect(b.msgs[3]).toEqual({ type: 'ok', from: a.id });
    expect(b.msgs).toHaveLength(4);
    expect(a.closed).toBeNull();
  });
});

describe('room expiry', () => {
  it('an unjoined room has an alarm about 10 minutes out; when it fires the code stops working', async () => {
    const code = await createRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const alarmAt = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    const delta = alarmAt! - Date.now();
    expect(delta).toBeGreaterThan(TEN_MIN - 60_000);
    expect(delta).toBeLessThanOrEqual(TEN_MIN);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const res = await api(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no-room' });
  });

  it('a room with a connected socket does not expire and has no pending alarm', async () => {
    const code = await createRoom();
    const a = await connect(code);
    await a.waitCount(2);
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    const b = await connect(code);
    await b.waitCount(2);
    expect(b.closed).toBeNull();
  });

  it('re-arms a 10 minute alarm when the last socket leaves, and firing it expires the code', async () => {
    const code = await createRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const a = await connect(code);
    await a.waitCount(2);
    a.ws.close(1000, 'bye');
    let alarmAt: number | null = null;
    for (let i = 0; i < 100 && alarmAt === null; i++) {
      alarmAt = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
      if (alarmAt === null) await sleep(20);
    }
    expect(alarmAt).not.toBeNull();
    const delta = alarmAt! - Date.now();
    expect(delta).toBeGreaterThan(TEN_MIN - 60_000);
    expect(delta).toBeLessThanOrEqual(TEN_MIN);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const res = await api(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(404);
  });

  it('does not expire a room that still has sockets when a stale alarm fires', async () => {
    const code = await createRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const a = await connect(code);
    await a.waitCount(2);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.setAlarm(Date.now() + 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const b = await connect(code);
    await b.waitCount(2);
    expect(b.closed).toBeNull();
  });
});

const ID_RE = /^[a-z0-9]{8}$/;
const prefixOf = (id: string): string => id.slice(0, 3);

describe('ids come in join order (the room creator is the lowest id, so the host)', () => {
  it('first, second and third joiner get strictly increasing ids of the old 8-char format', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    for (const x of [a, b, c]) expect(x.id).toMatch(ID_RE);
    expect(a.id < b.id).toBe(true);
    expect(b.id < c.id).toBe(true);
    expect([a.id, b.id, c.id].sort()).toEqual([a.id, b.id, c.id]);
    expect([prefixOf(a.id), prefixOf(b.id), prefixOf(c.id)]).toEqual(['000', '001', '002']);
  });

  it('a leave and rejoin gets an id greater than every current id, also when the FIRST joiner left', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    a.ws.close(1000, 'bye');
    await b.waitCount(4);
    const d = await connect(code);
    await d.waitCount(2);
    expect(d.id).toMatch(ID_RE);
    expect(d.id > a.id && d.id > b.id && d.id > c.id).toBe(true);
    expect(prefixOf(d.id)).toBe('003');
  });

  it('a rejected 4th socket does not advance the counter', async () => {
    const code = await createRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const [a, b, c] = await joinThree(code);
    const d = await connect(code);
    await d.waitFor(() => d.closed !== null, '4th socket close');
    expect(d.closed).toEqual({ code: 4001, reason: 'full' });
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get('joins'))).toBe(3);
    c.ws.close(1000, 'bye');
    await a.waitCount(5);
    const e = await connect(code);
    await e.waitCount(2);
    expect(prefixOf(e.id)).toBe('003'); // counter + 1 after the three real joins, not 004
    expect(e.id > b.id).toBe(true);
  });

  it('the counter survives an eviction (hibernation): the next joiner still sorts after the first', async () => {
    const code = await createRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const a = await connect(code);
    await a.waitCount(2);
    await evictDurableObject(stub); // in-memory state is gone, storage and the hibernated socket stay
    const b = await connect(code);
    await b.waitCount(2);
    expect(prefixOf(a.id)).toBe('000');
    expect(prefixOf(b.id)).toBe('001');
    expect(b.id > a.id).toBe(true);
  });

  it('ids are unique over many joins and leaves and always rise', async () => {
    const code = await createRoom();
    const ids: string[] = [];
    let held: Client[] = [];
    for (let i = 0; i < 8; i++) {
      const x = await connect(code);
      await x.waitCount(2);
      ids.push(x.id);
      held.push(x);
      if (held.length === 3) {
        const gone = held.shift()!;
        gone.ws.close(1000, 'bye');
        await held[0].waitFor(() => held[0].msgs.filter((m) => m.type === 'peers').length >= 2, 'peers after leave');
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(ID_RE);
  });

  it('refuses further joins with 4001 full once the counter is exhausted; the last value is zzz', async () => {
    const code = await createRoom();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    await runInDurableObject(stub, (_i, state) => state.storage.put('joins', MAX_JOINS - 1));
    const last = await connect(code);
    await last.waitCount(2);
    expect(prefixOf(last.id)).toBe('zzz');
    last.ws.close(1000, 'bye');
    await sleep(50);
    const over = await connect(code);
    await over.waitFor(() => over.closed !== null, 'overflow close');
    expect(over.closed).toEqual({ code: 4001, reason: 'full' });
    expect(over.msgs).toEqual([]);
  });

  it('makeId: 3 base-36 counter digits then 5 random lowercase alphanumerics', () => {
    expect(makeId(0)).toMatch(/^000[a-z0-9]{5}$/);
    expect(makeId(35)).toMatch(/^00z[a-z0-9]{5}$/);
    expect(makeId(36)).toMatch(/^010[a-z0-9]{5}$/);
    expect(makeId(MAX_JOINS - 1)).toMatch(/^zzz[a-z0-9]{5}$/);
    expect(makeId(7)).not.toBe(makeId(7)); // random tail
    for (let n = 0; n < 2000; n += 37) expect(makeId(n) < makeId(n + 1)).toBe(true);
  });
});

describe('keepalive', () => {
  it('answers the text frame ping with pong, to the sender only, and relays nothing', async () => {
    const code = await createRoom();
    const [a, b, c] = await joinThree(code);
    a.send('ping');
    await a.waitFor(() => a.msgs.some((m) => m.raw === 'pong'), 'pong');
    expect(a.msgs[a.msgs.length - 1]).toEqual({ raw: 'pong' });
    b.send({ type: 'marker' });
    await c.waitCount(3);
    expect(b.msgs.map((m) => m.type)).toEqual(['hello', 'peers', 'peers']);
    expect(c.msgs.map((m) => m.type)).toEqual(['hello', 'peers', 'marker']);
  });

  it('still answers pong after the Room was evicted (answered without waking it)', async () => {
    const code = await createRoom();
    const a = await connect(code);
    await a.waitCount(2);
    await evictDurableObject(env.ROOM.get(env.ROOM.idFromName(code)));
    a.send('ping');
    await a.waitFor(() => a.msgs.some((m) => m.raw === 'pong'), 'pong after eviction');
  });
});
