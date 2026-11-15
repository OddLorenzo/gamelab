/**
 * RoomMesh bookkeeping against a FAKE RTCPeerConnection.
 *
 * This checks OUR logic (which links stay, when the watchdog fires, which events reach callers).
 * It does NOT verify the real WebRTC glue (offer/answer, ICE, data channel behaviour), which
 * cannot run under jsdom and stays UNVERIFIED until a real-device test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_TIMEOUT_MS, RoomMesh, RoomSignaling } from '../../src/net/signaling';
import type { WebSocketLike } from '../../src/net/signaling';

class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  send(): void {}
  close(): void {}
  server(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number, reason: string): void {
    this.onclose?.({ code, reason });
  }
}

class FakeChannel {
  readyState = 'connecting';
  label = 'game';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(): void {}
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakePC {
  static all: FakePC[] = [];
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  channels: FakeChannel[] = [];
  closeCalls = 0;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() {
    FakePC.all.push(this);
  }
  addTrack(): void {}
  addTransceiver(): void {}
  createDataChannel(): FakeChannel {
    const ch = new FakeChannel();
    this.channels.push(ch);
    return ch;
  }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'v=0' };
  }
  async setLocalDescription(d: { type: string; sdp: string }): Promise<void> {
    this.localDescription = d;
  }
  close(): void {
    this.closeCalls += 1;
  }
  state(s: string): void {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

/** I am 'bbb': I offer to 'ccc' (higher id) and wait for 'aaa' to offer to me. */
const rig = async () => {
  const sig = new RoomSignaling('wss://w.example/rooms/ABCD/ws', FakeWebSocket);
  const ws = FakeWebSocket.last;
  ws.server({ type: 'hello', id: 'bbb' });
  ws.server({ type: 'peers', ids: ['aaa', 'bbb', 'ccc'] });
  const mesh = new RoomMesh(sig, [], null);
  await vi.advanceTimersByTimeAsync(0);
  const pcFor = (i: number): FakePC => FakePC.all[i];
  return { sig, ws, mesh, pcFor };
};

beforeEach(() => {
  FakePC.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', FakePC);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RoomMesh with fake peer connections', () => {
  it('creates one link per other peer and offers only to the higher id', async () => {
    const { pcFor } = await rig();
    expect(FakePC.all).toHaveLength(2); // aaa and ccc
    const offered = FakePC.all.filter((pc) => pc.channels.length === 1);
    expect(offered).toHaveLength(1);
    expect(pcFor(0).channels.length + pcFor(1).channels.length).toBe(1);
  });

  it('a peers update without an OPEN link leaves it open: no close, still in peers(), no peer-left', async () => {
    const { ws, mesh } = await rig();
    const left: string[] = [];
    mesh.onPeerLeft((id) => left.push(id));
    const offered = FakePC.all.find((pc) => pc.channels.length === 1)!;
    offered.channels[0].open(); // the link to ccc opens
    expect(mesh.peers()).toEqual(['ccc']);

    ws.server({ type: 'peers', ids: ['bbb'] }); // my signaling view lost everyone (e.g. a blip)
    expect(mesh.peers()).toEqual(['ccc']);
    expect(offered.closeCalls).toBe(0);
    expect(offered.channels[0].readyState).toBe('open');
    expect(left).toEqual([]);

    // the link ends when its own data channel says so
    offered.channels[0].close();
    expect(left).toEqual(['ccc']);
    expect(mesh.peers()).toEqual([]);
  });

  it('a link that never opened and left the list is dropped', async () => {
    const { ws } = await rig();
    ws.server({ type: 'peers', ids: ['bbb'] });
    for (const pc of FakePC.all) expect(pc.closeCalls).toBe(1);
  });

  it('onLinkFailed fires once, 20 s after a link that never opened, and tears it down', async () => {
    const { mesh } = await rig();
    const failed: string[] = [];
    mesh.onLinkFailed((id) => failed.push(id));
    vi.advanceTimersByTime(LINK_TIMEOUT_MS - 1);
    expect(failed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failed.sort()).toEqual(['aaa', 'ccc']);
    for (const pc of FakePC.all) expect(pc.closeCalls).toBe(1);
    vi.advanceTimersByTime(LINK_TIMEOUT_MS * 3);
    expect(failed).toHaveLength(2);
    expect(mesh.peers()).toEqual([]);
  });

  it('a link that opens in time never fails, and is not reported when the 20 s pass', async () => {
    const { mesh } = await rig();
    const failed: string[] = [];
    mesh.onLinkFailed((id) => failed.push(id));
    const offered = FakePC.all.find((pc) => pc.channels.length === 1)!;
    vi.advanceTimersByTime(19_000);
    offered.channels[0].open();
    vi.advanceTimersByTime(LINK_TIMEOUT_MS);
    expect(failed).not.toContain('ccc');
    expect(offered.closeCalls).toBe(0);
    expect(mesh.peers()).toEqual(['ccc']);
  });

  it('connectionState failed before the link ever opened fires onLinkFailed at once', async () => {
    const { mesh } = await rig();
    const failed: string[] = [];
    mesh.onLinkFailed((id) => failed.push(id));
    const offered = FakePC.all.find((pc) => pc.channels.length === 1)!;
    offered.state('failed');
    expect(failed).toEqual(['ccc']);
    expect(offered.closeCalls).toBe(1);
  });

  it('connectionState failed after the link opened is a peer-left, not a link failure', async () => {
    const { mesh } = await rig();
    const failed: string[] = [];
    const left: string[] = [];
    mesh.onLinkFailed((id) => failed.push(id));
    mesh.onPeerLeft((id) => left.push(id));
    const offered = FakePC.all.find((pc) => pc.channels.length === 1)!;
    offered.channels[0].open();
    offered.state('failed');
    expect(failed).toEqual([]);
    expect(left).toEqual(['ccc']);
  });

  it('onSignalingClosed fires once with code and reason; open links stay open', async () => {
    const { ws, mesh } = await rig();
    const closes: [number, string][] = [];
    mesh.onSignalingClosed((c, r) => closes.push([c, r]));
    const offered = FakePC.all.find((pc) => pc.channels.length === 1)!;
    offered.channels[0].open();
    ws.serverClose(1006, 'dropped');
    expect(closes).toEqual([[1006, 'dropped']]);
    expect(mesh.peers()).toEqual(['ccc']);
    expect(offered.closeCalls).toBe(0);
  });

  it('onSignalingClosed does not fire after our own close(), which also clears every timer', async () => {
    const { ws, mesh } = await rig();
    const closes: unknown[] = [];
    mesh.onSignalingClosed((c, r) => closes.push([c, r]));
    mesh.close();
    ws.serverClose(1000, '');
    expect(closes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
