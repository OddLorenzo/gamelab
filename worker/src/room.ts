import { DurableObject } from 'cloudflare:workers';

export const PING = 'ping';
export const PONG = 'pong';

export const MAX_SOCKETS = 3;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const ROOM_TTL_MS = 10 * 60 * 1000;
export const CLOSE_FULL = 4001;
/** Join counter: 3 base-36 digits, so ids sort in join order for up to 36^3 = 46,656 joins per room (the code expires long before). */
export const JOIN_DIGITS = 3;
export const MAX_JOINS = 36 ** JOIN_DIGITS; // 46,656 ids: counter 0 ('000') to 46,655 ('zzz')
const JOINS_KEY = 'joins';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

type Attachment = { id: string } | { rejected: true };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * `joinNumber` as zero-padded base-36 (0-9 sort before a-z in ASCII, so string order is numeric
 * order), then 5 random characters. The prefix alone makes ids unique within a room; the
 * random tail keeps a peer from guessing another's id.
 */
export function makeId(joinNumber: number): string {
  let id = joinNumber.toString(36).padStart(JOIN_DIGITS, '0');
  while (id.length < JOIN_DIGITS + 5) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    // 252 = 36 * 7: reject the top bytes so every character is equally likely
    if (b < 252) id += ID_ALPHABET[b % ID_ALPHABET.length];
  }
  return id;
}

function idOf(ws: WebSocket): string | null {
  const att = ws.deserializeAttachment() as Attachment | null;
  return att && 'id' in att ? att.id : null;
}

export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Keepalive: clients send the text frame `ping` now and then; the runtime answers `pong`
    // without waking a hibernated Room, so idle phones keep their carrier NAT mapping open.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/init' && request.method === 'POST') return this.init();
    if (pathname === '/ws') return this.join(request);
    return json({ error: 'not-found' }, 404);
  }

  /** Called by POST /rooms. 409 means the code is already in use. */
  private async init(): Promise<Response> {
    if (await this.ctx.storage.get('created')) return json({ error: 'taken' }, 409);
    await this.ctx.storage.put('created', Date.now());
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return json({ ok: true }, 201);
  }

  private async join(request: Request): Promise<Response> {
    if (!(await this.ctx.storage.get('created'))) return json({ error: 'no-room' }, 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const reject = (): Response => {
      server.serializeAttachment({ rejected: true } satisfies Attachment);
      server.close(CLOSE_FULL, 'full');
      return new Response(null, { status: 101, webSocket: client });
    };

    // Capacity check, counter and attachment happen as one step: two sockets arriving together
    // can neither both take the last slot nor read the same counter value.
    const id = await this.ctx.blockConcurrencyWhile(async (): Promise<string | null> => {
      if (this.members().length >= MAX_SOCKETS) return null;
      // Ids come in JOIN ORDER (the first joiner, the room creator, is the lowest id and so the
      // host). The counter lives in durable storage so it survives hibernation; only accepted
      // sockets reach it, so a rejected 4th socket never consumes a value.
      const joins = (await this.ctx.storage.get<number>(JOINS_KEY)) ?? 0;
      if (joins >= MAX_JOINS) return null;
      await this.ctx.storage.put(JOINS_KEY, joins + 1);
      const fresh = makeId(joins);
      server.serializeAttachment({ id: fresh } satisfies Attachment);
      return fresh;
    });
    if (id === null) return reject();
    await this.ctx.storage.deleteAlarm();
    server.send(JSON.stringify({ type: 'hello', id }));
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const from = idOf(ws);
    if (from === null || typeof message !== 'string') return;
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const out = JSON.stringify({ ...(parsed as Record<string, unknown>), from });
    for (const peer of this.members(ws)) peer.send(out);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000, reason);
    } catch {
      // already closed
    }
    await this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  async alarm(): Promise<void> {
    if (this.members().length === 0) await this.ctx.storage.deleteAll();
  }

  private async left(ws: WebSocket): Promise<void> {
    if (idOf(ws) === null) return; // rejected socket: it never joined
    const rest = this.members(ws);
    if (rest.length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    } else {
      this.broadcastPeers(rest);
    }
  }

  /** Joined, still-open sockets, optionally excluding one. */
  private members(exclude?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((s) => s !== exclude && s.readyState === WebSocket.OPEN && idOf(s) !== null);
  }

  private broadcastPeers(sockets: WebSocket[] = this.members()): void {
    const msg = JSON.stringify({ type: 'peers', ids: sockets.map((s) => idOf(s)) });
    for (const s of sockets) s.send(msg);
  }
}
