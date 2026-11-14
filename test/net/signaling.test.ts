import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_ICE_SERVERS,
  RoomSignaling,
  closeCodeError,
  createRoom,
  joinStatusError,
  loadIceServers,
  preflightRoom,
  roomWsUrl,
} from '../../src/net/signaling';
import type { WebSocketLike } from '../../src/net/signaling';

class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  /** What the Worker would send. */
  server(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  serverClose(code: number, reason: string): void {
    this.onclose?.({ code, reason });
  }
}

const open = (): { sig: RoomSignaling; ws: FakeWebSocket } => {
  const sig = new RoomSignaling('wss://w.example/rooms/ABCD/ws', FakeWebSocket);
  return { sig, ws: FakeWebSocket.last };
};

const joined = (): { sig: RoomSignaling; ws: FakeWebSocket } => {
  const r = open();
  r.ws.server({ type: 'hello', id: 'abcd1234' });
  r.ws.server({ type: 'peers', ids: ['abcd1234'] });
  return r;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('RoomSignaling', () => {
  it('connects to the given url', () => {
    expect(open().ws.url).toBe('wss://w.example/rooms/ABCD/ws');
  });

  it('hello sets the id, peers updates the list, and ready resolves after both', async () => {
    const { sig, ws } = open();
    let ready = false;
    void sig.ready.then(() => {
      ready = true;
    });
    expect(sig.id).toBeNull();
    ws.server({ type: 'hello', id: 'abcd1234' });
    expect(sig.id).toBe('abcd1234');
    await Promise.resolve();
    expect(ready).toBe(false); // still waiting for the first peers list
    const seen: string[][] = [];
    sig.onPeers((ids) => seen.push(ids));
    ws.server({ type: 'peers', ids: ['abcd1234', 'zzzz0000'] });
    expect(sig.peers).toEqual(['abcd1234', 'zzzz0000']);
    await sig.ready;
    ws.server({ type: 'peers', ids: ['abcd1234'] });
    expect(sig.peers).toEqual(['abcd1234']);
    expect(seen).toEqual([['abcd1234', 'zzzz0000'], ['abcd1234']]);
  });

  it('a second hello does not change the id', () => {
    const { sig, ws } = joined();
    ws.server({ type: 'hello', id: 'other999' });
    expect(sig.id).toBe('abcd1234');
  });

  it('SPOOF GUARD: a relayed message (with `from`) of type peers does not touch the peer list', () => {
    const { sig, ws } = joined();
    const seen: string[][] = [];
    sig.onPeers((ids) => seen.push(ids));
    ws.server({ type: 'peers', ids: ['evil0001', 'evil0002'], from: 'zzzz0000' });
    expect(sig.peers).toEqual(['abcd1234']);
    expect(seen).toEqual([]);
  });

  it('SPOOF GUARD: a relayed hello cannot change the id and is not relayed to onMessage', () => {
    const { sig, ws } = joined();
    const got: unknown[] = [];
    sig.onMessage((from, msg) => got.push([from, msg]));
    ws.server({ type: 'hello', id: 'evil0001', from: 'zzzz0000' });
    expect(sig.id).toBe('abcd1234');
    expect(got).toEqual([]);
  });

  it('a spoofed hello or peers before the real ones does not poison the state', () => {
    const { sig, ws } = open();
    ws.server({ type: 'hello', id: 'evil0001', from: 'zzzz0000' });
    ws.server({ type: 'peers', ids: ['evil0001'], from: 'zzzz0000' });
    expect(sig.id).toBeNull();
    expect(sig.peers).toEqual([]);
    ws.server({ type: 'hello', id: 'abcd1234' });
    expect(sig.id).toBe('abcd1234');
  });

  it('relays messages with `from` to onMessage, without the from field', () => {
    const { sig, ws } = joined();
    const got: [string, unknown][] = [];
    sig.onMessage((from, msg) => got.push([from, msg]));
    ws.server({ kind: 'offer', to: 'abcd1234', data: { type: 'offer', sdp: 'x' }, from: 'zzzz0000' });
    expect(got).toEqual([['zzzz0000', { kind: 'offer', to: 'abcd1234', data: { type: 'offer', sdp: 'x' } }]]);
  });

  it('ignores server messages (no `from`) that are neither hello nor peers', () => {
    const { sig, ws } = joined();
    const got: unknown[] = [];
    sig.onMessage((from, msg) => got.push([from, msg]));
    ws.server({ kind: 'offer', to: 'abcd1234', data: {} });
    ws.server({ type: 'mystery' });
    expect(got).toEqual([]);
    expect(sig.peers).toEqual(['abcd1234']);
  });

  it('rejects malformed hello and peers', () => {
    const { sig, ws } = open();
    ws.server({ type: 'hello', id: 7 });
    ws.server({ type: 'hello' });
    expect(sig.id).toBeNull();
    ws.server({ type: 'hello', id: 'abcd1234' });
    ws.server({ type: 'peers', ids: 'abcd1234' });
    ws.server({ type: 'peers', ids: ['abcd1234', 5] });
    ws.server({ type: 'peers' });
    expect(sig.peers).toEqual([]);
  });

  it('ignores non-JSON frames, non-object JSON and binary frames', () => {
    const { sig, ws } = joined();
    const got: unknown[] = [];
    sig.onMessage((from, msg) => got.push([from, msg]));
    const closes: unknown[] = [];
    sig.onClose((c, r) => closes.push([c, r]));
    expect(() => {
      ws.server('not json {');
      ws.server('');
      ws.server('null');
      ws.server('42');
      ws.server('"peers"');
      ws.server('[{"type":"peers","ids":["x"],"from":"y"}]');
      ws.onmessage?.({ data: new ArrayBuffer(8) });
      ws.onmessage?.({ data: undefined });
    }).not.toThrow();
    expect(got).toEqual([]);
    expect(sig.peers).toEqual(['abcd1234']);
    expect(closes).toEqual([]);
  });

  it('ignores a relayed frame whose `from` is not a string', () => {
    const { sig, ws } = joined();
    const got: unknown[] = [];
    sig.onMessage((from, msg) => got.push([from, msg]));
    ws.server({ kind: 'ice', to: 'abcd1234', data: {}, from: 5 });
    expect(got).toEqual([]);
  });

  it('send serializes the message as JSON', () => {
    const { sig, ws } = joined();
    sig.send({ kind: 'offer', to: 'zzzz0000', data: { type: 'offer', sdp: 'v=0' } });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ kind: 'offer', to: 'zzzz0000', data: { type: 'offer', sdp: 'v=0' } });
  });

  it('send after close sends nothing and does not throw', () => {
    const { sig, ws } = joined();
    ws.serverClose(1006, '');
    expect(() => sig.send({ kind: 'ice', to: 'x', data: {} })).not.toThrow();
    expect(ws.sent).toEqual([]);
  });

  it('close 4001 full before ready rejects ready with Error(full) and reports the close', async () => {
    const { sig, ws } = open();
    const closes: [number, string][] = [];
    sig.onClose((c, r) => closes.push([c, r]));
    ws.serverClose(4001, 'full');
    await expect(sig.ready).rejects.toThrow('full');
    expect(closes).toEqual([[4001, 'full']]);
  });

  it('any other close before ready rejects with Error(network)', async () => {
    const { sig, ws } = open();
    ws.serverClose(1006, '');
    await expect(sig.ready).rejects.toThrow('network');
  });

  it('a socket error before ready rejects with Error(network)', async () => {
    const { sig, ws } = open();
    ws.onerror?.({});
    await expect(sig.ready).rejects.toThrow('network');
  });

  it('a close after ready keeps ready resolved and still reports the close', async () => {
    const { sig, ws } = joined();
    const closes: [number, string][] = [];
    sig.onClose((c, r) => closes.push([c, r]));
    ws.serverClose(1000, 'bye');
    await expect(sig.ready).resolves.toBeUndefined();
    expect(closes).toEqual([[1000, 'bye']]);
  });

  it('close() closes the socket', () => {
    const { sig, ws } = joined();
    sig.close();
    expect(ws.closed).not.toBeNull();
  });
});

describe('error mapping', () => {
  it('HTTP 404 means no-room, other failures mean network', () => {
    expect(joinStatusError(404).message).toBe('no-room');
    expect(joinStatusError(500).message).toBe('network');
    expect(joinStatusError(429).message).toBe('network');
  });
  it('close 4001 means full, anything else network', () => {
    expect(closeCodeError(4001, 'full').message).toBe('full');
    expect(closeCodeError(4001, 'whatever').message).toBe('full');
    expect(closeCodeError(1006, '').message).toBe('network');
    expect(closeCodeError(1000, 'full').message).toBe('network');
  });
});

const fakeFetch = (res: { status: number; body?: unknown } | Error): typeof fetch =>
  vi.fn(() => {
    if (res instanceof Error) return Promise.reject(res);
    return Promise.resolve(
      new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status }),
    );
  }) as unknown as typeof fetch;

describe('room http helpers', () => {
  it('builds the websocket url from the worker url', () => {
    expect(roomWsUrl('https://w.example', 'ABCD')).toBe('wss://w.example/rooms/ABCD/ws');
    expect(roomWsUrl('https://w.example/', 'ABCD')).toBe('wss://w.example/rooms/ABCD/ws');
    expect(roomWsUrl('http://localhost:8787', 'ABCD')).toBe('ws://localhost:8787/rooms/ABCD/ws');
    expect(roomWsUrl('https://w.example', 'A/B?')).toBe('wss://w.example/rooms/A%2FB%3F/ws');
  });

  it('preflightRoom rejects only on 404 (no-room); a live room, an error status or an unreachable fetch all let the join try', async () => {
    await expect(preflightRoom('https://w.example', 'ABCD', fakeFetch({ status: 404, body: { error: 'no-room' } }))).rejects.toThrow('no-room');
    await expect(preflightRoom('https://w.example', 'ABCD', fakeFetch({ status: 426 }))).resolves.toBeUndefined();
    await expect(preflightRoom('https://w.example', 'ABCD', fakeFetch({ status: 500 }))).resolves.toBeUndefined();
    // a cross-origin fetch without CORS headers also fails like this: the websocket decides then
    await expect(preflightRoom('https://w.example', 'ABCD', fakeFetch(new TypeError('offline')))).resolves.toBeUndefined();
  });

  it('preflightRoom asks the ws endpoint of that code over http', async () => {
    const f = fakeFetch({ status: 426 });
    await preflightRoom('https://w.example/', 'ABCD', f);
    expect(f).toHaveBeenCalledWith('https://w.example/rooms/ABCD/ws', expect.anything());
  });

  it('loadIceServers returns the Worker list and falls back to public STUN on any failure', async () => {
    const servers = [{ urls: 'stun:s.example' }, { urls: ['turn:t.example'], username: 'u', credential: 'c' }];
    expect(await loadIceServers('https://w.example', fakeFetch({ status: 200, body: { iceServers: servers, ttlSec: 60 } }))).toEqual(servers);
    expect(await loadIceServers('https://w.example', fakeFetch({ status: 500 }))).toEqual(FALLBACK_ICE_SERVERS);
    expect(await loadIceServers('https://w.example', fakeFetch(new TypeError('offline')))).toEqual(FALLBACK_ICE_SERVERS);
    expect(await loadIceServers('https://w.example', fakeFetch({ status: 200, body: { iceServers: 'nope' } }))).toEqual(FALLBACK_ICE_SERVERS);
    expect(await loadIceServers('https://w.example', fakeFetch({ status: 200, body: { iceServers: [] } }))).toEqual(FALLBACK_ICE_SERVERS);
    expect(await loadIceServers('https://w.example', fakeFetch({ status: 200, body: null }))).toEqual(FALLBACK_ICE_SERVERS);
    expect(FALLBACK_ICE_SERVERS.length).toBeGreaterThan(0);
  });

  it('createRoom returns the code from a 201 and maps failures to network', async () => {
    expect(await createRoom('https://w.example', fakeFetch({ status: 201, body: { code: 'ABCD' } }))).toBe('ABCD');
    await expect(createRoom('https://w.example', fakeFetch({ status: 503, body: { error: 'unavailable' } }))).rejects.toThrow('network');
    await expect(createRoom('https://w.example', fakeFetch({ status: 201, body: { code: 5 } }))).rejects.toThrow('network');
    await expect(createRoom('https://w.example', fakeFetch(new TypeError('offline')))).rejects.toThrow('network');
  });
});
