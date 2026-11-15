import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATE_TIMEOUT_MS,
  FALLBACK_ICE_SERVERS,
  ICE_TIMEOUT_MS,
  LINK_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PREFLIGHT_TIMEOUT_MS,
  RoomSignaling,
  createLinkWatch,
  createRoom,
  loadIceServers,
  preflightRoom,
  reconcileLinks,
} from '../../src/net/signaling';
import type { WebSocketLike } from '../../src/net/signaling';

class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;
  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls += 1;
  }
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
  vi.useRealTimers();
});

describe('RoomSignaling keepalive', () => {
  it('sends the text frame ping every 25 s once joined, and nothing before', () => {
    vi.useFakeTimers();
    const { ws } = open();
    vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
    expect(ws.sent).toEqual([]); // not ready: a CONNECTING socket cannot send
    ws.server({ type: 'hello', id: 'abcd1234' });
    ws.server({ type: 'peers', ids: ['abcd1234'] });
    vi.advanceTimersByTime(PING_INTERVAL_MS - 1);
    expect(ws.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ws.sent).toEqual(['ping']);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 3);
    expect(ws.sent).toEqual(['ping', 'ping', 'ping', 'ping']);
    expect(PING_INTERVAL_MS).toBe(25_000);
  });

  it('stops after a local close()', () => {
    vi.useFakeTimers();
    const { sig, ws } = joined();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(ws.sent).toEqual(['ping']);
    sig.close();
    vi.advanceTimersByTime(PING_INTERVAL_MS * 4);
    expect(ws.sent).toEqual(['ping']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when the socket closes on its own', () => {
    vi.useFakeTimers();
    const { ws } = joined();
    ws.serverClose(1006, '');
    vi.advanceTimersByTime(PING_INTERVAL_MS * 4);
    expect(ws.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the injected timers', () => {
    const calls: [string, number][] = [];
    const timers = {
      setInterval: (_fn: () => void, ms: number) => {
        calls.push(['set', ms]);
        return 7;
      },
      clearInterval: (h: unknown) => {
        calls.push(['clear', h as number]);
      },
    };
    const sig = new RoomSignaling('wss://w.example/rooms/ABCD/ws', FakeWebSocket, timers);
    const ws = FakeWebSocket.last;
    ws.server({ type: 'hello', id: 'abcd1234' });
    ws.server({ type: 'peers', ids: ['abcd1234'] });
    sig.close();
    expect(calls).toEqual([
      ['set', 25_000],
      ['clear', 7],
    ]);
  });

  it('a throwing send during a ping does not escape', () => {
    vi.useFakeTimers();
    const { ws } = joined();
    ws.send = () => {
      throw new Error('InvalidStateError');
    };
    expect(() => vi.advanceTimersByTime(PING_INTERVAL_MS)).not.toThrow();
  });

  it('the pong frame is ignored: no message, no state change, no close', () => {
    const { sig, ws } = joined();
    const got: unknown[] = [];
    sig.onMessage((from, msg) => got.push([from, msg]));
    const peers: unknown[] = [];
    sig.onPeers((ids) => peers.push(ids));
    const closes: unknown[] = [];
    sig.onClose((c, r) => closes.push([c, r]));
    expect(() => ws.server('pong')).not.toThrow();
    expect(got).toEqual([]);
    expect(peers).toEqual([]);
    expect(closes).toEqual([]);
    expect(sig.peers).toEqual(['abcd1234']);
  });
});

describe('RoomSignaling onClose', () => {
  it('fires once with code and reason for an unexpected close', () => {
    const { sig, ws } = joined();
    const closes: [number, string][] = [];
    sig.onClose((c, r) => closes.push([c, r]));
    ws.serverClose(1006, 'gone');
    expect(closes).toEqual([[1006, 'gone']]);
  });

  it('does not fire for a close we asked for (the browser still delivers the close event)', () => {
    const { sig, ws } = joined();
    const closes: [number, string][] = [];
    sig.onClose((c, r) => closes.push([c, r]));
    sig.close();
    ws.serverClose(1000, '');
    expect(closes).toEqual([]);
  });
});

const okFetch = (body: unknown, status = 200): typeof fetch =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

describe('pre-connection fetch timeouts', () => {
  it('asks for 5 s on preflight and /turn and 8 s on create, and hands the signal to fetch', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const f = okFetch({ code: 'ABCD', iceServers: [{ urls: 'stun:x' }] }, 201);
    await preflightRoom('https://w.example', 'ABCD', f);
    await loadIceServers('https://w.example', f);
    await createRoom('https://w.example', f);
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([5000, 5000, 8000]);
    expect([PREFLIGHT_TIMEOUT_MS, ICE_TIMEOUT_MS, CREATE_TIMEOUT_MS]).toEqual([5000, 5000, 8000]);
    const calls = (f as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls;
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a timed-out preflight is skipped, a timed-out /turn falls back to STUN, a timed-out create is network', async () => {
    const timedOut = (): typeof fetch =>
      vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as unknown as typeof fetch;
    await expect(preflightRoom('https://w.example', 'ABCD', timedOut())).resolves.toBeUndefined();
    expect(await loadIceServers('https://w.example', timedOut())).toEqual(FALLBACK_ICE_SERVERS);
    await expect(createRoom('https://w.example', timedOut())).rejects.toThrow('network');
  });
});

type FakeLink = { id: string; wasOpen: boolean; left: boolean };
const link = (id: string, wasOpen = false, left = false): FakeLink => ({ id, wasOpen, left });

describe('reconcileLinks', () => {
  it('keeps listed links', () => {
    const a = link('a');
    expect(reconcileLinks([a], ['a', 'b'])).toEqual({ keep: [a], drop: [] });
  });

  it('a peers update without an OPEN link leaves that link alone (signaling blip, P2P still fine)', () => {
    const open = link('a', true);
    expect(reconcileLinks([open], [])).toEqual({ keep: [open], drop: [] });
  });

  it('drops a link that never opened and is no longer listed', () => {
    const pending = link('a');
    expect(reconcileLinks([pending], ['b'])).toEqual({ keep: [], drop: [pending] });
  });

  it('leaves links that have already left alone', () => {
    const gone = link('a', false, true);
    expect(reconcileLinks([gone], [])).toEqual({ keep: [gone], drop: [] });
  });

  it('splits a mixed set', () => {
    const [opened, pending, listed] = [link('a', true), link('b'), link('c')];
    const r = reconcileLinks([opened, pending, listed], ['c']);
    expect(r.keep).toEqual([opened, listed]);
    expect(r.drop).toEqual([pending]);
  });
});

describe('createLinkWatch', () => {
  const rig = () => {
    vi.useFakeTimers();
    const failed: string[] = [];
    const watch = createLinkWatch({
      timeoutMs: LINK_TIMEOUT_MS,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onFail: (id) => failed.push(id),
    });
    return { watch, failed };
  };

  it('fires once after 20 s without an open', () => {
    const { watch, failed } = rig();
    watch.start('a');
    vi.advanceTimersByTime(LINK_TIMEOUT_MS - 1);
    expect(failed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failed).toEqual(['a']);
    vi.advanceTimersByTime(LINK_TIMEOUT_MS * 3);
    expect(failed).toEqual(['a']);
    expect(LINK_TIMEOUT_MS).toBe(20_000);
  });

  it('never fires once the link opened', () => {
    const { watch, failed } = rig();
    watch.start('a');
    vi.advanceTimersByTime(19_000);
    watch.opened('a');
    vi.advanceTimersByTime(60_000);
    expect(failed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fires immediately on failed before open, and only once', () => {
    const { watch, failed } = rig();
    watch.start('a');
    watch.failed('a');
    expect(failed).toEqual(['a']);
    watch.failed('a');
    vi.advanceTimersByTime(60_000);
    expect(failed).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fire on failed after the link opened (that is the normal peer-left path)', () => {
    const { watch, failed } = rig();
    watch.start('a');
    watch.opened('a');
    watch.failed('a');
    expect(failed).toEqual([]);
  });

  it('stop clears every timer', () => {
    const { watch, failed } = rig();
    watch.start('a');
    watch.start('b');
    expect(vi.getTimerCount()).toBe(2);
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(failed).toEqual([]);
    watch.start('c');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a link watched twice fires once', () => {
    const { watch, failed } = rig();
    watch.start('a');
    watch.start('a');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(LINK_TIMEOUT_MS);
    watch.start('a');
    vi.advanceTimersByTime(LINK_TIMEOUT_MS);
    expect(failed).toEqual(['a']);
  });

  it('cancel forgets a link without reporting it', () => {
    const { watch, failed } = rig();
    watch.start('a');
    watch.cancel('a');
    vi.advanceTimersByTime(60_000);
    expect(failed).toEqual([]);
  });

  it('watches links independently', () => {
    const { watch, failed } = rig();
    watch.start('a');
    vi.advanceTimersByTime(10_000);
    watch.start('b');
    vi.advanceTimersByTime(10_000);
    expect(failed).toEqual(['a']);
    vi.advanceTimersByTime(10_000);
    expect(failed).toEqual(['a', 'b']);
  });
});
