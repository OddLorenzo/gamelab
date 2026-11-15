import { createSession, reduce } from '../core/bomb';
import type { LevelDef, Session } from '../core/bomb';
import { createRng } from '../core/rng';
import { projectView } from '../core/views';
import type { ModuleAction, Rng, Role } from '../core/types';
import { EMOTE_IDS, parseNetMsg } from './protocol';
import type { EmoteId, EndReason, EndStats, NetMsg, Participant, PeerId, RoleView } from './protocol';
import type { Transport } from './transport';

const TICK_MS = 250;
const HEARTBEAT_MS = 2000;
const ROLES: readonly Role[] = ['blind', 'deaf', 'mute'];

/** Random one-to-one assignment of the three roles to the three peers (Fisher-Yates). */
export function assignRoles(ids: readonly PeerId[], rng: Rng): Record<PeerId, Role> {
  const roles = [...ROLES];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  const assign: Record<PeerId, Role> = {};
  ids.forEach((id, i) => {
    assign[id] = roles[i];
  });
  return assign;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * 32 bits of real entropy for a host rng. Never the clock: guests see the role assignment, so a
 * clock-seeded rng could be enumerated to predict the session salt (and so the whole bomb).
 */
function entropySeed(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    return c.getRandomValues(new Uint32Array(1))[0];
  }
  // WEAKER fallback for a runtime without WebCrypto: a mix of clock, high resolution timer and Math.random.
  const perf = (globalThis as { performance?: Performance }).performance;
  const hr = perf === undefined ? 0 : Math.floor(perf.now() * 1000);
  return (Date.now() ^ hr ^ Math.floor(Math.random() * 4294967296)) >>> 0;
}

/**
 * Authoritative side of one level. The host owns the session and the clock, and is also a
 * player: it exposes the same participant API as GuestGame for its own role. Star topology:
 * guests only ever talk to the host, the host relays pointers and emotes between them.
 *
 * Register the participant callbacks (onView, onEnded, ...) BEFORE start(): nothing is replayed.
 */
export class HostGame implements Participant {
  private readonly rng: Rng;
  private readonly saltRng: Rng;
  private session: Session | null = null;
  private assign: Record<PeerId, Role> = {};
  private guests: PeerId[] = [];
  private localRole: Role | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private seq = 0;
  private started = false;
  private finished = false;
  private stopped = false;
  private lastJson = new Map<PeerId, string>();
  private viewCbs: ((v: RoleView, msLeft: number | null) => void)[] = [];
  private endedCbs: ((r: EndReason, stats?: EndStats) => void)[] = [];
  private pointerCbs: ((by: PeerId, x: number, y: number) => void)[] = [];
  private emoteCbs: ((by: PeerId, id: EmoteId) => void)[] = [];

  constructor(
    private readonly t: Transport,
    private readonly def: LevelDef,
    private readonly now: () => number,
    options?: { rng?: Rng },
  ) {
    // Roles are public to the guests, the session salt must not be derivable from them: by default
    // the salt comes from its own rng with its own fresh entropy. An injected rng (tests) feeds both.
    this.rng = options?.rng ?? createRng(entropySeed());
    this.saltRng = options?.rng ?? createRng(entropySeed());
  }

  /** The host's own role, once started. */
  get role(): Role | null {
    return this.localRole;
  }

  /** Who plays which role (public to the table), a copy; null before start(). */
  peerRoles(): Record<PeerId, Role> | null {
    return this.started ? { ...this.assign } : null;
  }

  /** Deep copy of the authoritative session (for tests and debugging), null before start(). */
  snapshot(): Session | null {
    return this.session === null ? null : (JSON.parse(JSON.stringify(this.session)) as Session);
  }

  onView(cb: (v: RoleView, msLeft: number | null) => void): void {
    this.viewCbs.push(cb);
  }
  onEnded(cb: (r: EndReason, stats?: EndStats) => void): void {
    this.endedCbs.push(cb);
  }
  onPointer(cb: (by: PeerId, x: number, y: number) => void): void {
    this.pointerCbs.push(cb);
  }
  onEmote(cb: (by: PeerId, id: EmoteId) => void): void {
    this.emoteCbs.push(cb);
  }

  /** The host clock, exactly: deaf host only, null for the other roles. */
  msLeft(): number | null {
    if (this.session === null || this.localRole !== 'deaf') return null;
    if (this.finished || this.stopped) return this.session.msLeft;
    return Math.max(0, this.session.msLeft - Math.max(0, this.now() - this.lastTickAt));
  }

  start(): void {
    if (this.started) throw new Error('HostGame already started');
    const guests = [...this.t.peers()].sort();
    if (guests.length !== 2) throw new Error(`HostGame needs exactly 3 players, got ${guests.length + 1}`);
    this.started = true;
    this.guests = guests;
    this.assign = assignRoles([this.t.id, ...guests], this.rng);
    this.localRole = this.assign[this.t.id];
    // The level id (sent to guests) determines buildLevel(id).seed, so a guest could rebuild the
    // bomb from it. The host therefore salts the session seed from its private rng.
    this.session = createSession({ ...this.def, seed: this.saltRng.int(2 ** 31) });
    this.lastTickAt = this.now();

    this.t.onMessage((from, msg) => this.onMessage(from, msg));
    this.t.onPeerLeft((id) => this.onPeerLeft(id));

    // The real seed never goes on the wire (and the session seed is salted anyway, see above).
    this.sendRoles();
    this.publish();

    this.tickTimer = globalThis.setInterval(() => this.step(), TICK_MS);
    this.heartbeatTimer = globalThis.setInterval(() => this.heartbeat(), HEARTBEAT_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  /** The local player acts: same path as a guest act, role = the host's own role. */
  act(moduleId: string, action: ModuleAction): void {
    if (!this.running() || this.localRole === null) return;
    const msg = parseNetMsg({ t: 'act', moduleId, action });
    if (msg === null || msg.t !== 'act') return;
    this.handleAct(this.localRole, msg.moduleId, msg.action);
  }

  sendPointer(x: number, y: number): void {
    if (!this.running() || !Number.isFinite(x) || !Number.isFinite(y)) return;
    for (const g of this.guests) this.send(g, { t: 'pointer', x: clamp01(x), y: clamp01(y), by: this.t.id });
  }

  sendEmote(id: EmoteId): void {
    if (!this.running() || !EMOTE_IDS.includes(id)) return;
    for (const g of this.guests) this.send(g, { t: 'emote', id, by: this.t.id });
  }

  private running(): boolean {
    return this.started && !this.finished && !this.stopped;
  }

  private send(to: PeerId, msg: NetMsg): void {
    try {
      this.t.send(to, msg);
    } catch {
      // one failed send (a full channel queue) must not abort the other sends or the callbacks
    }
  }

  private clearTimers(): void {
    if (this.tickTimer !== null) globalThis.clearInterval(this.tickTimer);
    if (this.heartbeatTimer !== null) globalThis.clearInterval(this.heartbeatTimer);
    this.tickTimer = null;
    this.heartbeatTimer = null;
  }

  /** Advance the session by the host clock delta since the last advance. */
  private advance(): void {
    const at = this.now();
    const dtMs = at - this.lastTickAt;
    if (dtMs > 0) this.lastTickAt = at; // a clock that stepped back must not refund time later
    if (this.session !== null) this.session = reduce(this.session, { type: 'tick', dtMs });
  }

  private step(): void {
    if (!this.running()) return;
    this.advance();
    this.publish();
  }

  private sendRoles(): void {
    const level: LevelDef = { ...this.def, seed: 0 };
    for (const g of this.guests) this.send(g, { t: 'roles', assign: this.assign, level });
  }

  /**
   * Frames sent before a data channel is open are dropped, and views are only sent on change.
   * So every heartbeat also repeats `roles` (a guest ignores repeats) and forgets what each
   * guest was sent, which re-sends its current full view.
   */
  private heartbeat(): void {
    if (!this.running()) return;
    this.sendRoles();
    for (const g of this.guests) {
      this.send(g, { t: 'heartbeat', hostTimeMs: this.now() });
      this.lastJson.delete(g);
    }
    this.publish();
  }

  private onMessage(from: PeerId, raw: NetMsg): void {
    if (!this.running() || !this.guests.includes(from)) return;
    const msg = parseNetMsg(raw);
    if (msg === null) return;
    switch (msg.t) {
      case 'act':
        // the role comes from who sent it, never from the message
        this.handleAct(this.assign[from], msg.moduleId, msg.action);
        break;
      case 'pointer': {
        const x = clamp01(msg.x);
        const y = clamp01(msg.y);
        for (const g of this.guests) if (g !== from) this.send(g, { t: 'pointer', x, y, by: from });
        for (const cb of [...this.pointerCbs]) cb(from, x, y);
        break;
      }
      case 'emote':
        for (const g of this.guests) if (g !== from) this.send(g, { t: 'emote', id: msg.id, by: from });
        for (const cb of [...this.emoteCbs]) cb(from, msg.id);
        break;
      default:
        break; // roles, view, heartbeat and ended only ever travel from the host
    }
  }

  private handleAct(role: Role, moduleId: string, action: ModuleAction): void {
    if (this.session === null) return;
    this.advance(); // the digit below must come from the clock at this very moment
    let real = action;
    if (action.kind === 'button' && action.type === 'release') {
      const timerDigit = Math.floor(this.session.msLeft / 1000) % 10;
      real = { ...action, payload: { ...action.payload, timerDigit } };
    }
    this.session = reduce(this.session, { type: 'act', role, moduleId, action: real });
    this.publish();
  }

  private onPeerLeft(id: PeerId): void {
    if (!this.running() || !this.guests.includes(id)) return;
    this.finish('player-left', id);
  }

  /** Send every participant its own view, only when it changed, then end the level if over. */
  private publish(): void {
    const s = this.session;
    if (s === null) return;
    for (const g of this.guests) {
      const view = projectView(s, this.assign[g]);
      const text = JSON.stringify(view);
      if (this.lastJson.get(g) === text) continue;
      this.lastJson.set(g, text);
      this.send(g, { t: 'view', seq: ++this.seq, hostTimeMs: this.now(), view });
    }
    if (this.localRole !== null) {
      const view = projectView(s, this.localRole);
      const text = JSON.stringify(view);
      if (this.lastJson.get(this.t.id) !== text) {
        this.lastJson.set(this.t.id, text);
        for (const cb of [...this.viewCbs]) {
          const copy = JSON.parse(text) as RoleView; // the UI never gets the session's own objects
          cb(copy, copy.role === 'deaf' ? copy.msLeft : null);
        }
      }
    }
    if (s.status !== 'playing') this.finish(s.status);
  }

  private finish(reason: EndReason, left?: PeerId): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    let stats: EndStats | undefined;
    if ((reason === 'won' || reason === 'lost') && this.session !== null) {
      stats = {
        strikesLeft: this.session.strikesLeft,
        msLeftRatio: this.def.timeMs > 0 ? clamp01(this.session.msLeft / this.def.timeMs) : 0,
      };
    }
    const msg: NetMsg = stats === undefined ? { t: 'ended', reason } : { t: 'ended', reason, stats };
    for (const g of this.guests) if (g !== left) this.send(g, msg);
    for (const cb of [...this.endedCbs]) cb(reason, stats);
  }
}
