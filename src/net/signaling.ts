import { parseNetMsg } from './protocol';
import type { NetMsg, PeerId } from './protocol';
import type { RoomConnection } from './transport';

/* ------------------------------------------------------------------ */
/* Pure helpers (unit tested)                                          */
/* ------------------------------------------------------------------ */

export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['stun:stun.l.google.com:19302'] },
];

const CLOSE_FULL = 4001;

/** HTTP status of a failed join to the error callers see. */
export function joinStatusError(status: number): Error {
  return new Error(status === 404 ? 'no-room' : 'network');
}

/** WebSocket close of the Worker to the error callers see. */
export function closeCodeError(code: number, _reason: string): Error {
  return new Error(code === CLOSE_FULL ? 'full' : 'network');
}

const base = (workerUrl: string): string => workerUrl.replace(/\/+$/, '');

export function roomWsUrl(workerUrl: string, code: string): string {
  return `${base(workerUrl).replace(/^http/i, 'ws')}/rooms/${encodeURIComponent(code)}/ws`;
}

/**
 * A browser WebSocket cannot read the HTTP status of a failed upgrade, so ask the same url
 * with a plain GET first: the Worker answers 404 for an unknown room. Best effort: only a
 * 404 stops the join, anything else (including an unreachable fetch) lets the socket decide.
 */
export async function preflightRoom(workerUrl: string, code: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const url = `${base(workerUrl)}/rooms/${encodeURIComponent(code)}/ws`;
  let status: number;
  try {
    status = (await fetchFn(url, { method: 'GET' })).status;
  } catch {
    return;
  }
  if (status === 404) throw joinStatusError(status);
}

const isIceServer = (v: unknown): v is RTCIceServer => {
  if (typeof v !== 'object' || v === null) return false;
  const urls = (v as { urls?: unknown }).urls;
  return typeof urls === 'string' || (Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === 'string'));
};

/** `GET /turn`, falling back to public STUN when anything goes wrong. */
export async function loadIceServers(workerUrl: string, fetchFn: typeof fetch = fetch): Promise<RTCIceServer[]> {
  try {
    const res = await fetchFn(`${base(workerUrl)}/turn`);
    if (!res.ok) return FALLBACK_ICE_SERVERS;
    const body = (await res.json()) as { iceServers?: unknown } | null;
    const list = body?.iceServers;
    if (!Array.isArray(list) || list.length === 0 || !list.every(isIceServer)) return FALLBACK_ICE_SERVERS;
    return list;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
}

/** `POST /rooms`: a fresh room code. */
export async function createRoom(workerUrl: string, fetchFn: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(`${base(workerUrl)}/rooms`, { method: 'POST' });
  } catch {
    throw new Error('network');
  }
  if (res.status !== 201) throw new Error('network');
  try {
    const body = (await res.json()) as { code?: unknown } | null;
    if (typeof body?.code === 'string' && body.code.length > 0) return body.code;
  } catch {
    // falls through
  }
  throw new Error('network');
}

/* ------------------------------------------------------------------ */
/* Signaling socket (unit tested with a fake WebSocket)                */
/* ------------------------------------------------------------------ */

export interface WebSocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The Worker side of a room. Server messages (`hello`, `peers`) never carry `from`; every
 * relayed client message does, set by the server. So `from`-less hello/peers are the only
 * ones that change state: a peer that relays `{type:'peers', ...}` cannot spoof the list.
 */
export class RoomSignaling {
  id: PeerId | null = null;
  peers: PeerId[] = [];
  /** Resolves after hello and the first peers list; rejects with Error('full' | 'network'). */
  readonly ready: Promise<void>;

  private readonly ws: WebSocketLike;
  private isReady = false;
  private gotPeers = false;
  private closed = false;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private peersCbs: ((ids: PeerId[]) => void)[] = [];
  private messageCbs: ((from: PeerId, msg: unknown) => void)[] = [];
  private closeCbs: ((code: number, reason: string) => void)[] = [];

  constructor(url: string, WS: WebSocketCtor) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined); // callers that never await it must not trigger an unhandled rejection
    this.ws = new WS(url);
    this.ws.onmessage = (ev) => this.onFrame(ev.data);
    this.ws.onerror = () => {
      if (!this.isReady) this.rejectReady(new Error('network'));
    };
    this.ws.onclose = (ev) => {
      this.closed = true;
      if (!this.isReady) this.rejectReady(closeCodeError(ev.code, ev.reason));
      for (const cb of [...this.closeCbs]) cb(ev.code, ev.reason);
    };
  }

  onPeers(cb: (ids: PeerId[]) => void): void {
    this.peersCbs.push(cb);
  }
  onMessage(cb: (from: PeerId, msg: unknown) => void): void {
    this.messageCbs.push(cb);
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCbs.push(cb);
  }

  send(msg: object): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }

  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    const { from, ...rest } = parsed;
    if (from === undefined) {
      this.onServerMessage(rest);
      return;
    }
    if (typeof from !== 'string') return;
    const type = rest['type'];
    if (type === 'hello' || type === 'peers') return; // spoof guard: those are server-only
    for (const cb of [...this.messageCbs]) cb(from, rest);
  }

  private onServerMessage(msg: Record<string, unknown>): void {
    if (msg['type'] === 'hello') {
      const id = msg['id'];
      if (this.id === null && typeof id === 'string' && id.length > 0) this.id = id;
    } else if (msg['type'] === 'peers') {
      const ids = msg['ids'];
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) return;
      this.peers = [...(ids as string[])];
      this.gotPeers = true;
      for (const cb of [...this.peersCbs]) cb([...this.peers]);
    } else {
      return;
    }
    if (!this.isReady && this.id !== null && this.gotPeers) {
      this.isReady = true;
      this.resolveReady();
    }
  }
}

/* ------------------------------------------------------------------ */
/* WebRTC mesh: UNVERIFIED glue (cannot run under jsdom)               */
/* ------------------------------------------------------------------ */

interface Link {
  id: PeerId;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
  wasOpen: boolean;
  left: boolean;
}

interface SignalMsg {
  kind: 'offer' | 'answer' | 'ice';
  to: PeerId;
  data: unknown;
}

const asSignal = (m: unknown): SignalMsg | null => {
  if (!isPlainObject(m)) return null;
  const { kind, to, data } = m;
  if ((kind !== 'offer' && kind !== 'answer' && kind !== 'ice') || typeof to !== 'string') return null;
  return { kind, to, data };
};

/** One RTCPeerConnection per other peer; the LOWER id offers. Implements the game Transport. */
class RoomMesh implements RoomConnection {
  private readonly links = new Map<PeerId, Link>();
  private messageCbs: ((from: PeerId, msg: NetMsg) => void)[] = [];
  private leftCbs: ((id: PeerId) => void)[] = [];
  private audioCbs: ((id: PeerId, stream: MediaStream) => void)[] = [];

  constructor(
    private readonly sig: RoomSignaling,
    private readonly iceServers: RTCIceServer[],
    private readonly localAudio: MediaStreamTrack | null,
  ) {
    sig.onPeers((ids) => this.syncPeers(ids));
    sig.onMessage((from, msg) => {
      void this.onSignal(from, msg);
    });
    this.syncPeers(sig.peers);
  }

  get id(): PeerId {
    return this.sig.id ?? '';
  }

  peers(): PeerId[] {
    return [...this.links.values()].filter((l) => l.channel?.readyState === 'open').map((l) => l.id);
  }

  send(to: PeerId, msg: NetMsg): void {
    const ch = this.links.get(to)?.channel;
    if (ch?.readyState !== 'open') return;
    try {
      ch.send(JSON.stringify(msg));
    } catch {
      // RTCDataChannel.send throws when its queue is full: drop the frame, never abort the caller
    }
  }

  onMessage(cb: (from: PeerId, msg: NetMsg) => void): void {
    this.messageCbs.push(cb);
  }
  onPeerLeft(cb: (id: PeerId) => void): void {
    this.leftCbs.push(cb);
  }
  onRemoteAudio(cb: (id: PeerId, stream: MediaStream) => void): void {
    this.audioCbs.push(cb);
  }

  close(): void {
    for (const link of this.links.values()) {
      link.left = true; // closing on purpose is not a peer leaving
      link.pc.close();
    }
    this.links.clear();
    this.sig.close();
  }

  private syncPeers(ids: PeerId[]): void {
    const me = this.sig.id;
    if (me === null) return;
    for (const id of ids) {
      if (id === me || this.links.has(id)) continue;
      const link = this.createLink(id);
      if (me < id) void this.offer(link);
    }
    for (const link of [...this.links.values()]) {
      if (!ids.includes(link.id)) this.drop(link);
    }
  }

  private drop(link: Link): void {
    this.links.delete(link.id);
    link.pc.close();
    this.markLeft(link);
  }

  private markLeft(link: Link): void {
    if (link.left) return;
    link.left = true;
    if (link.wasOpen) for (const cb of [...this.leftCbs]) cb(link.id);
  }

  private createLink(id: PeerId): Link {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const link: Link = { id, pc, channel: null, remoteSet: false, pendingIce: [], wasOpen: false, left: false };
    this.links.set(id, link);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sig.send({ kind: 'ice', to: id, data: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      for (const cb of [...this.audioCbs]) cb(id, stream);
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'game') this.attach(link, ev.channel);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.markLeft(link);
    };
    if (this.localAudio !== null) pc.addTrack(this.localAudio, new MediaStream([this.localAudio]));
    return link;
  }

  private attach(link: Link, channel: RTCDataChannel): void {
    link.channel = channel;
    if (channel.readyState === 'open') link.wasOpen = true;
    channel.onopen = () => {
      link.wasOpen = true;
    };
    channel.onclose = () => this.markLeft(link);
    channel.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const msg = parseNetMsg(raw);
      if (msg === null) return;
      for (const cb of [...this.messageCbs]) cb(link.id, msg);
    };
  }

  private async offer(link: Link): Promise<void> {
    try {
      if (this.localAudio === null) link.pc.addTransceiver('audio', { direction: 'recvonly' });
      this.attach(link, link.pc.createDataChannel('game', { ordered: true }));
      await link.pc.setLocalDescription(await link.pc.createOffer());
      const d = link.pc.localDescription;
      if (d) this.sig.send({ kind: 'offer', to: link.id, data: { type: d.type, sdp: d.sdp } });
    } catch {
      this.markLeft(link);
    }
  }

  private async onSignal(from: PeerId, raw: unknown): Promise<void> {
    const msg = asSignal(raw);
    if (msg === null || msg.to !== this.sig.id) return;
    try {
      let link = this.links.get(from);
      if (link === undefined) {
        if (!this.sig.peers.includes(from)) return;
        link = this.createLink(from);
      }
      if (msg.kind === 'ice') {
        const cand = msg.data as RTCIceCandidateInit;
        if (link.remoteSet) await link.pc.addIceCandidate(cand);
        else link.pendingIce.push(cand);
        return;
      }
      const d = msg.data as { type?: unknown; sdp?: unknown } | null;
      if (d === null || typeof d !== 'object' || typeof d.sdp !== 'string') return;
      if (msg.kind === 'offer') {
        await link.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        link.remoteSet = true;
        await this.flushIce(link);
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        const a = link.pc.localDescription;
        if (a) this.sig.send({ kind: 'answer', to: from, data: { type: a.type, sdp: a.sdp } });
      } else {
        await link.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        link.remoteSet = true;
        await this.flushIce(link);
      }
    } catch {
      // a bad signal from one peer must not take the room down
    }
  }

  private async flushIce(link: Link): Promise<void> {
    const pending = link.pendingIce.splice(0);
    for (const cand of pending) await link.pc.addIceCandidate(cand);
  }
}

/**
 * Join room `code` of the Worker: signaling socket, ICE servers, then a WebRTC data-channel
 * mesh (channel `game`, JSON NetMsg frames). Resolves once the socket has said hello and
 * listed the peers; data channels open afterwards, so wait until `peers()` lists the other
 * two players before building a HostGame or GuestGame. Rejects with Error('no-room' | 'full' |
 * 'network'). `localAudio` is added to every peer connection when it is created.
 */
export async function connectToRoom(
  workerUrl: string,
  code: string,
  localAudio: MediaStreamTrack | null = null,
): Promise<RoomConnection> {
  await preflightRoom(workerUrl, code);
  const iceServers = await loadIceServers(workerUrl);
  let sig: RoomSignaling;
  try {
    sig = new RoomSignaling(roomWsUrl(workerUrl, code), WebSocket as unknown as WebSocketCtor); // the DOM event types are wider than WebSocketLike
  } catch {
    throw new Error('network');
  }
  await sig.ready;
  return new RoomMesh(sig, iceServers, localAudio);
}
