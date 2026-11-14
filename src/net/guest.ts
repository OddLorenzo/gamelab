import type { LevelDef } from '../core/bomb';
import type { ModuleAction, Role } from '../core/types';
import { parseNetMsg } from './protocol';
import type { EmoteId, EndReason, EndStats, NetMsg, Participant, PeerId, RoleView } from './protocol';
import { hostIdOf } from './transport';
import type { Transport } from './transport';

const WATCHDOG_MS = 1000;
const HOST_SILENCE_MS = 10_000;

/**
 * A non-host player. Trusts only the host (the lowest PeerId), validates every frame, and
 * never reads the host clock: the timer is the last view's msLeft minus the time elapsed on
 * THIS device since that view arrived, so a backgrounded tab recovers on the next message.
 *
 * Construct it once the room is complete (the host id is read from the peers at that moment)
 * and register callbacks before the host starts: nothing is replayed.
 */
export class GuestGame implements Participant {
  private readonly hostId: PeerId;
  private lastSeq = 0;
  private lastLeft: number | null = null; // deaf msLeft of the last accepted view
  private lastViewAt = 0; // guest clock when that view arrived
  private lastHostMsgAt: number;
  private roleValue: Role | null = null;
  private levelValue: LevelDef | null = null;
  private ended = false;
  private stopped = false;
  private watchdog: ReturnType<typeof setInterval> | null;
  private rolesCbs: ((role: Role, level: LevelDef) => void)[] = [];
  private viewCbs: ((v: RoleView, msLeft: number | null) => void)[] = [];
  private endedCbs: ((r: EndReason, stats?: EndStats) => void)[] = [];
  private pointerCbs: ((by: PeerId, x: number, y: number) => void)[] = [];
  private emoteCbs: ((by: PeerId, id: EmoteId) => void)[] = [];

  constructor(
    private readonly t: Transport,
    private readonly now: () => number,
  ) {
    this.hostId = hostIdOf(t);
    this.lastHostMsgAt = now();
    t.onMessage((from, msg) => this.onMessage(from, msg));
    t.onPeerLeft((id) => {
      if (id === this.hostId) this.finish('host-left');
    });
    this.watchdog = globalThis.setInterval(() => {
      if (this.now() - this.lastHostMsgAt >= HOST_SILENCE_MS) this.finish('host-left');
    }, WATCHDOG_MS);
  }

  /** Assigned by the host's first `roles` message, null before that. */
  get role(): Role | null {
    return this.roleValue;
  }
  /** Level info from the host (its seed is blanked: guests never get it). */
  get level(): LevelDef | null {
    return this.levelValue;
  }

  onRoles(cb: (role: Role, level: LevelDef) => void): void {
    this.rolesCbs.push(cb);
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

  /** Deaf timer from the last view and the local clock, clamped at 0. Null for blind and mute. */
  msLeft(): number | null {
    if (this.lastLeft === null) return null;
    return Math.max(0, this.lastLeft - (this.now() - this.lastViewAt));
  }

  sendAct(moduleId: string, action: ModuleAction): void {
    this.toHost({ t: 'act', moduleId, action });
  }
  act(moduleId: string, action: ModuleAction): void {
    this.sendAct(moduleId, action);
  }
  sendPointer(x: number, y: number): void {
    this.toHost({ t: 'pointer', x, y });
  }
  sendEmote(id: EmoteId): void {
    this.toHost({ t: 'emote', id });
  }

  stop(): void {
    this.stopped = true;
    this.clearWatchdog();
  }

  private toHost(msg: NetMsg): void {
    if (this.ended || this.stopped) return;
    this.t.send(this.hostId, msg);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) globalThis.clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private finish(reason: EndReason, stats?: EndStats): void {
    if (this.ended || this.stopped) return;
    this.ended = true;
    this.clearWatchdog();
    for (const cb of [...this.endedCbs]) cb(reason, stats);
  }

  private onMessage(from: PeerId, raw: NetMsg): void {
    if (from !== this.hostId || this.ended || this.stopped) return;
    const msg = parseNetMsg(raw);
    if (msg === null) return;
    this.lastHostMsgAt = this.now(); // any valid host message proves the host is alive
    switch (msg.t) {
      case 'roles': {
        const role = msg.assign[this.t.id];
        if (this.roleValue !== null || role === undefined) return;
        this.roleValue = role;
        this.levelValue = msg.level;
        for (const cb of [...this.rolesCbs]) cb(role, msg.level);
        return;
      }
      case 'view': {
        if (msg.seq <= this.lastSeq) return; // duplicate or out of order
        if (this.roleValue !== null && msg.view.role !== this.roleValue) return;
        this.lastSeq = msg.seq;
        this.lastViewAt = this.now();
        this.lastLeft = msg.view.role === 'deaf' ? msg.view.msLeft : null;
        for (const cb of [...this.viewCbs]) cb(msg.view, this.lastLeft);
        return;
      }
      case 'pointer':
        if (msg.by !== undefined) for (const cb of [...this.pointerCbs]) cb(msg.by, msg.x, msg.y);
        return;
      case 'emote':
        if (msg.by !== undefined) for (const cb of [...this.emoteCbs]) cb(msg.by, msg.id);
        return;
      case 'ended':
        this.finish(msg.reason, msg.stats);
        return;
      default:
        return; // heartbeat: liveness only (hostTimeMs is never used for time)
    }
  }
}
