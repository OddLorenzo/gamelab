import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULES, createSession } from '../../src/core/bomb';
import type { LevelDef, Session } from '../../src/core/bomb';
import { createRng } from '../../src/core/rng';
import { buildLevel } from '../../src/core/levels';
import { needsHold } from '../../src/core/modules/button';
import { SYMBOL_COLUMNS } from '../../src/core/modules/symbols';
import { projectView } from '../../src/core/views';
import type { BlindView, DeafView, MuteView } from '../../src/core/views';
import type { ModuleAction, ModuleKind, Role } from '../../src/core/types';
import { HostGame, assignRoles } from '../../src/net/host';
import { GuestGame } from '../../src/net/guest';
import type { EmoteId, EndReason, EndStats, NetMsg, Participant, PeerId } from '../../src/net/protocol';
import { createMemoryNetwork } from './memory-transport';
import type { MemoryNetwork } from './memory-transport';

const IDS = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'];
const HOST = IDS[0];
const ALL_KINDS: ModuleKind[] = ['wires', 'button', 'symbols', 'code'];
const COLOR_NAMES = ['red', 'blue', 'yellow', 'green', 'white'];
const GLYPH_NAMES = [...new Set(SYMBOL_COLUMNS.flat())];
const T0 = 1_000_000;

const def = (over: Partial<LevelDef> = {}): LevelDef => ({
  id: 1,
  stage: 1,
  seed: 7,
  moduleKinds: ALL_KINDS,
  difficulty: 3,
  timeMs: 100_000,
  strikes: 3,
  setting: 'jungle',
  ...over,
});

type RoleView = BlindView | DeafView | MuteView;

interface Rec {
  views: { view: RoleView; msLeft: number | null }[];
  ended: { reason: EndReason; stats?: EndStats }[];
  pointers: { by: PeerId; x: number; y: number }[];
  emotes: { by: PeerId; id: EmoteId }[];
}
const newRec = (): Rec => ({ views: [], ended: [], pointers: [], emotes: [] });

interface Rig {
  net: MemoryNetwork;
  host: HostGame;
  guests: Record<PeerId, GuestGame>;
  assign: Record<PeerId, Role>;
  rec: Record<PeerId, Rec>; // by peer id, host included
  raw: Record<PeerId, NetMsg[]>; // everything each guest's transport received
  peerOf: (role: Role) => PeerId;
  /** The local player of any peer: the host game or a guest game. */
  player: (id: PeerId) => Participant;
  inject: (from: PeerId, to: PeerId, msg: unknown) => void;
  snap: () => Session;
  level: LevelDef;
}

/** First rng seed whose role assignment satisfies `pred`. */
const seedFor = (pred: (a: Record<PeerId, Role>) => boolean): number => {
  for (let s = 1; s < 1000; s++) if (pred(assignRoles(IDS, createRng(s)))) return s;
  throw new Error('no seed');
};
const HOST_IS_MUTE = seedFor((a) => a[HOST] === 'mute'); // blind and deaf are guests
const HOST_IS_BLIND = seedFor((a) => a[HOST] === 'blind');

const hostNowDefault = (): number => Date.now();

interface RigOptions {
  level?: LevelDef;
  rngSeed?: number;
  guestNow?: () => number;
  hostNow?: () => number;
  start?: boolean;
}

function makeRig(o: RigOptions = {}): Rig {
  const level = o.level ?? def();
  const net = createMemoryNetwork(IDS);
  const hostNow = o.hostNow ?? hostNowDefault;
  const guestNow = o.guestNow ?? hostNowDefault;
  const host = new HostGame(net[0], level, hostNow, { rng: createRng(o.rngSeed ?? HOST_IS_MUTE) });
  const rec: Record<PeerId, Rec> = { [HOST]: newRec() };
  const raw: Record<PeerId, NetMsg[]> = {};
  const guests: Record<PeerId, GuestGame> = {};
  host.onView((view, msLeft) => rec[HOST].views.push({ view, msLeft }));
  host.onEnded((reason, stats) => rec[HOST].ended.push({ reason, stats }));
  host.onPointer((by, x, y) => rec[HOST].pointers.push({ by, x, y }));
  host.onEmote((by, id) => rec[HOST].emotes.push({ by, id }));
  for (const t of net.slice(1)) {
    rec[t.id] = newRec();
    raw[t.id] = [];
    t.onMessage((_from, msg) => raw[t.id].push(msg));
    const g = new GuestGame(t, guestNow);
    g.onView((view, msLeft) => rec[t.id].views.push({ view, msLeft }));
    g.onEnded((reason, stats) => rec[t.id].ended.push({ reason, stats }));
    g.onPointer((by, x, y) => rec[t.id].pointers.push({ by, x, y }));
    g.onEmote((by, id) => rec[t.id].emotes.push({ by, id }));
    guests[t.id] = g;
  }
  if (o.start !== false) host.start();
  const assign = assignRoles(IDS, createRng(o.rngSeed ?? HOST_IS_MUTE));
  return {
    net,
    host,
    guests,
    assign,
    rec,
    raw,
    level,
    peerOf: (role) => IDS.find((id) => assign[id] === role)!,
    player: (id) => (id === HOST ? host : guests[id]),
    inject: (from, to, msg) => net[IDS.indexOf(from)].send(to, msg as NetMsg),
    snap: () => host.snapshot()!,
  };
}

/** Winning actions for the host's ACTUAL modules (its session seed is salted, so the level def cannot predict them). */
const solveAll = (src: Rig | Session): { moduleId: string; action: ModuleAction }[] =>
  ('snap' in src ? src.snap() : src).modules.flatMap((m) =>
    MODULES[m.kind].solve(m).map((action) => ({ moduleId: m.id, action })),
  );

const last = <T>(a: T[]): T => a[a.length - 1];
const json = (v: unknown): string => JSON.stringify(v);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('role assignment', () => {
  it('always gives three distinct roles covering blind/deaf/mute (500 rng seeds)', () => {
    for (let seed = 0; seed < 500; seed++) {
      const a = assignRoles(IDS, createRng(seed));
      expect(Object.keys(a).sort()).toEqual(IDS);
      expect(Object.values(a).sort()).toEqual(['blind', 'deaf', 'mute']);
    }
  });

  it('is random: every peer can get every role', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const a = assignRoles(IDS, createRng(seed));
      for (const id of IDS) seen.add(`${id}:${a[id]}`);
    }
    expect(seen.size).toBe(9);
  });

  it('start() sends each guest its own role and the host keeps the third', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rig = makeRig({ rngSeed: seed });
      for (const id of IDS.slice(1)) {
        expect(rig.guests[id].role).toBe(rig.assign[id]);
        const roles = rig.raw[id].filter((m) => m.t === 'roles');
        expect(roles).toHaveLength(1);
      }
      expect(rig.host.role).toBe(rig.assign[HOST]);
      expect(new Set([rig.host.role, rig.guests[IDS[1]].role, rig.guests[IDS[2]].role]).size).toBe(3);
      rig.host.stop();
      for (const g of Object.values(rig.guests)) g.stop();
    }
  });

  it('start() needs exactly 3 participants', () => {
    const two = createMemoryNetwork(IDS.slice(0, 2));
    expect(() => new HostGame(two[0], def(), Date.now).start()).toThrow();
    const four = createMemoryNetwork([...IDS, 'dddddddd']);
    expect(() => new HostGame(four[0], def(), Date.now).start()).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never ships the level seed to a guest (it would let a client rebuild the whole bomb)', () => {
    const rig = makeRig({ level: def({ seed: 424242 }) });
    for (const id of IDS.slice(1)) {
      const roles = rig.raw[id].find((m) => m.t === 'roles');
      expect(roles?.t === 'roles' && roles.level.seed).toBe(0);
      expect(json(rig.raw[id])).not.toContain('424242');
      expect(roles?.t === 'roles' && roles.level.setting).toBe('jungle');
    }
  });
});

describe('no cross-role leaks', () => {
  it('each guest only receives its own role view, with no other role data (20 levels)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const level = def({ seed: seed * 101 });
      const rig = makeRig({ level, rngSeed: seed });
      const secret = rig.snap();
      const serial = secret.modules[3].data['serial'] as string;
      const target = secret.modules[3].data['target'] as string;
      vi.advanceTimersByTime(2000);
      for (const id of IDS.slice(1)) {
        const role = rig.assign[id];
        const views = rig.raw[id].filter((m) => m.t === 'view');
        expect(views.length).toBeGreaterThan(0);
        for (const m of views) expect(m.t === 'view' && m.view.role).toBe(role);
        const text = json(views);
        if (role === 'blind') {
          for (const c of COLOR_NAMES) expect(text).not.toContain(c);
          for (const g of GLYPH_NAMES) expect(text).not.toContain(g);
          expect(text).not.toContain(serial);
          expect(text).not.toContain(target);
          for (const key of ['data', 'timerDigit', 'digit', 'target', 'order', 'msLeft', 'manual', 'wires']) {
            expect(text).not.toContain(`"${key}":`);
          }
        } else if (role === 'mute') {
          for (const key of ['data', 'msLeft', 'modules', 'serial', 'target', 'order', 'digit']) {
            expect(text).not.toContain(`"${key}":`);
          }
          expect(text).not.toContain(serial);
          expect(text).toContain('"manual":');
        } else {
          for (const key of ['target', 'order', 'rules', 'manual', 'targets']) {
            expect(text).not.toContain(`"${key}":`);
          }
          expect(text).toContain('"msLeft":');
        }
      }
      expect(last(rig.rec[HOST].views).view.role).toBe(rig.assign[HOST]);
      rig.host.stop();
      for (const g of Object.values(rig.guests)) g.stop();
    }
  });
});

describe('act handling', () => {
  const solveWires = (rig: Rig) => solveAll(rig)[0];

  it('an act from the deaf peer leaves the session unchanged; the same act from the blind peer applies', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires', 'code'] }) });
    const before = json(rig.snap());
    const { moduleId, action } = solveWires(rig);
    rig.player(rig.peerOf('deaf')).act(moduleId, action);
    expect(json(rig.snap())).toBe(before);
    rig.player(rig.peerOf('mute')).act(moduleId, action);
    expect(json(rig.snap())).toBe(before);
    rig.guests[rig.peerOf('blind')].sendAct(moduleId, action);
    expect(json(rig.snap())).not.toBe(before);
    expect(rig.snap().modules[0].solved).toBe(true);
  });

  it('a forged role field (top level or inside the action) changes nothing', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires', 'code'] }) });
    const before = json(rig.snap());
    const { moduleId, action } = solveWires(rig);
    const deaf = rig.peerOf('deaf');
    rig.inject(deaf, HOST, { t: 'act', role: 'blind', moduleId, action });
    rig.inject(deaf, HOST, { t: 'act', moduleId, action: { ...action, role: 'blind' } });
    rig.inject(deaf, HOST, { t: 'act', moduleId, action, from: rig.peerOf('blind') });
    expect(json(rig.snap())).toBe(before);
  });

  it('GuestGame.act is an alias of sendAct', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'] }) });
    const { moduleId, action } = solveWires(rig);
    rig.guests[rig.peerOf('blind')].act(moduleId, action);
    expect(rig.snap().status).toBe('won');
  });

  it('wrong acts from the blind peer still cost a strike (the host reduces them)', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'] }) });
    const { moduleId, action } = solveWires(rig);
    const wrong = ((action.payload?.['index'] as number) + 1) % 3;
    rig.guests[rig.peerOf('blind')].sendAct(moduleId, { kind: 'wires', type: 'cut', payload: { index: wrong } });
    expect(rig.snap().strikesLeft).toBe(2);
  });
});

describe('untrusted input', () => {
  const malformed: [string, unknown][] = [
    ['null', null],
    ['a string', 'act'],
    ['a number', 42],
    ['an array', [{ t: 'act' }]],
    ['no t', { moduleId: 'm0' }],
    ['unknown t', { t: 'win', moduleId: 'm0' }],
    ['act without moduleId', { t: 'act', action: { kind: 'wires', type: 'cut', payload: { index: 0 } } }],
    ['act with null action', { t: 'act', moduleId: 'm0', action: null }],
    ['act with unknown kind', { t: 'act', moduleId: 'm0', action: { kind: 'lasers', type: 'cut' } }],
    ['act with string payload', { t: 'act', moduleId: 'm0', action: { kind: 'wires', type: 'cut', payload: 'index' } }],
    ['act with array payload', { t: 'act', moduleId: 'm0', action: { kind: 'wires', type: 'cut', payload: [0] } }],
    ['act with huge payload', { t: 'act', moduleId: 'm0', action: { kind: 'wires', type: 'cut', payload: { index: 0, junk: 'x'.repeat(5000) } } }],
    ['pointer with NaN', { t: 'pointer', x: NaN, y: 0.5 }],
    ['pointer with Infinity', { t: 'pointer', x: Infinity, y: 0.5 }],
    ['pointer with strings', { t: 'pointer', x: '0.5', y: '0.5' }],
    ['unknown emote', { t: 'emote', id: 'dance' }],
    ['view from a guest', { t: 'view', seq: 1, hostTimeMs: 1, view: { role: 'blind' } }],
    ['ended from a guest', { t: 'ended', reason: 'won' }],
    ['roles from a guest', { t: 'roles', assign: {}, level: def() }],
  ];

  it.each(malformed)('the host drops %s without throwing or changing anything', (_n, msg) => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'] }) });
    const before = json(rig.snap());
    const viewsBefore = rig.rec[HOST].views.length;
    for (const from of IDS.slice(1)) {
      expect(() => rig.inject(from, HOST, msg)).not.toThrow();
    }
    expect(json(rig.snap())).toBe(before);
    expect(rig.rec[HOST].views.length).toBe(viewsBefore);
    for (const id of IDS.slice(1)) {
      expect(rig.rec[id].pointers).toEqual([]);
      expect(rig.rec[id].emotes).toEqual([]);
      expect(rig.rec[id].ended).toEqual([]);
    }
    expect(rig.rec[HOST].pointers).toEqual([]);
    expect(rig.rec[HOST].emotes).toEqual([]);
    expect(rig.rec[HOST].ended).toEqual([]);
  });

  const hostCannotMeanThese = malformed.filter(([n]) => n !== 'ended from a guest');
  it.each(hostCannotMeanThese)('a guest drops %s from the host without throwing or reacting', (_n, msg) => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'] }) });
    const target = IDS[1];
    const viewsBefore = rig.rec[target].views.length;
    const roleBefore = rig.guests[target].role;
    const timerBefore = rig.guests[target].msLeft();
    expect(() => rig.inject(HOST, target, msg)).not.toThrow();
    expect(rig.rec[target].views.length).toBe(viewsBefore);
    expect(rig.rec[target].ended).toEqual([]);
    expect(rig.rec[target].pointers).toEqual([]);
    expect(rig.guests[target].role).toBe(roleBefore);
    expect(rig.guests[target].msLeft()).toBe(timerBefore);
  });

  it('ignores messages from a peer that is not one of the two guests', () => {
    const net = createMemoryNetwork([...IDS, 'dddddddd']);
    const level = def({ moduleKinds: ['wires'] });
    // the host only knows about two peers: a stranger can still reach it on the wire
    const hostT = { ...net[0], peers: () => [IDS[1], IDS[2]] };
    const host = new HostGame(hostT, level, Date.now, { rng: createRng(HOST_IS_MUTE) });
    const pointers: PeerId[] = [];
    host.onPointer((by) => pointers.push(by));
    host.start();
    const stranger = net[3];
    const before = json(host.snapshot());
    const { moduleId, action } = solveAll(host.snapshot()!)[0];
    const receivedByGuests: NetMsg[] = [];
    net[1].onMessage((_f, m) => receivedByGuests.push(m));
    net[2].onMessage((_f, m) => receivedByGuests.push(m));
    stranger.send(HOST, { t: 'act', moduleId, action });
    stranger.send(HOST, { t: 'pointer', x: 0.1, y: 0.1 });
    stranger.send(HOST, { t: 'emote', id: 'wave' });
    expect(json(host.snapshot())).toBe(before);
    expect(pointers).toEqual([]);
    expect(receivedByGuests.filter((m) => m.t === 'pointer' || m.t === 'emote')).toEqual([]);
    host.stop();
  });

  it('guests ignore anything not sent by the host: spoofed ended, view, pointer, roles', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'] }) });
    const [a, b] = IDS.slice(1);
    const viewsBefore = rig.rec[a].views.length;
    const roleBefore = rig.guests[a].role;
    rig.inject(b, a, { t: 'ended', reason: 'won' });
    rig.inject(b, a, { t: 'ended', reason: 'host-left' });
    rig.inject(b, a, { t: 'view', seq: 9999, hostTimeMs: 1, view: projectView(createSession(rig.level), rig.assign[a]) });
    rig.inject(b, a, { t: 'pointer', x: 0.2, y: 0.2, by: HOST });
    rig.inject(b, a, { t: 'emote', id: 'slap', by: HOST });
    rig.inject(b, a, { t: 'roles', assign: { [a]: 'mute' }, level: def() });
    expect(rig.rec[a].ended).toEqual([]);
    expect(rig.rec[a].views.length).toBe(viewsBefore);
    expect(rig.rec[a].pointers).toEqual([]);
    expect(rig.rec[a].emotes).toEqual([]);
    expect(rig.guests[a].role).toBe(roleBefore);
    // a spoofed seq must not poison the real host's later views
    rig.guests[rig.peerOf('blind')].sendAct('m0', solveAll(rig)[0].action);
    expect(rig.rec[a].ended.map((e) => e.reason)).toEqual(['won']);
    expect(last(rig.rec[a].views).view.status).toBe('won');
  });
});

describe('R1: the host owns the button timer digit', () => {
  const level = def({ moduleKinds: ['button'], timeMs: 100_000 });
  /** A rig whose (salted) host session holds a button that needs hold-and-release. */
  const holdRig = (hostBlind: boolean): { rig: Rig; digitOf: number } => {
    for (let seed = 1; seed < 3000; seed++) {
      if ((assignRoles(IDS, createRng(seed))[HOST] === 'blind') !== hostBlind) continue;
      const rig = makeRig({ level, rngSeed: seed });
      const m = rig.snap().modules[0];
      if (needsHold(m.data['color'] as never, m.data['label'] as never)) {
        return { rig, digitOf: m.data['digit'] as number };
      }
      rig.host.stop();
      for (const g of Object.values(rig.guests)) g.stop();
    }
    throw new Error('no hold rig');
  };
  /** Advance so that the host timer shows `digit` as its seconds digit, plus half a second. */
  const advanceToDigit = (digit: number): void => {
    vi.advanceTimersByTime(100_000 - (60_000 + digit * 1000 + 500));
  };
  const hold: ModuleAction = { kind: 'button', type: 'hold' };
  const release = (payload?: Record<string, unknown>): ModuleAction =>
    payload === undefined ? { kind: 'button', type: 'release' } : { kind: 'button', type: 'release', payload };

  it('the deaf view carries the button digit the rules need', () => {
    const { rig, digitOf } = holdRig(false);
    const view = last(rig.rec[rig.peerOf('deaf')].views).view;
    expect(view.role === 'deaf' && view.modules[0].data['digit']).toBe(digitOf);
  });

  it('a bogus client digit is overwritten by the real host digit (solves when the host timer matches)', () => {
    const { rig, digitOf } = holdRig(false);
    const blind = rig.guests[rig.peerOf('blind')];
    advanceToDigit(digitOf);
    blind.sendAct('m0', hold);
    blind.sendAct('m0', release({ timerDigit: (digitOf + 1) % 10 }));
    expect(rig.snap().status).toBe('won');
    expect(rig.snap().strikesLeft).toBe(3);
  });

  it('a missing client digit is filled in by the host', () => {
    const { rig, digitOf } = holdRig(false);
    const blind = rig.guests[rig.peerOf('blind')];
    advanceToDigit(digitOf);
    blind.sendAct('m0', hold);
    blind.sendAct('m0', release());
    expect(rig.snap().status).toBe('won');
  });

  it('a correct client digit at the wrong host time does not solve (strike)', () => {
    const { rig, digitOf } = holdRig(false);
    const blind = rig.guests[rig.peerOf('blind')];
    advanceToDigit((digitOf + 3) % 10);
    blind.sendAct('m0', hold);
    blind.sendAct('m0', release({ timerDigit: digitOf }));
    expect(rig.snap().status).toBe('playing');
    expect(rig.snap().modules[0].solved).toBe(false);
    expect(rig.snap().strikesLeft).toBe(2);
  });

  it('uses the host clock at the moment of the act, not the last 250 ms tick', () => {
    const { rig, digitOf } = holdRig(false);
    const blind = rig.guests[rig.peerOf('blind')];
    // land exactly on a tick boundary 250 ms into the digit, then let 400 ms pass without a tick
    vi.advanceTimersByTime(100_000 - (60_000 + digitOf * 1000 + 250));
    vi.setSystemTime(Date.now() + 400);
    blind.sendAct('m0', hold);
    blind.sendAct('m0', release({ timerDigit: digitOf }));
    // the real timer is now 150 ms into the PREVIOUS digit, so the release misses
    expect(rig.snap().modules[0].solved).toBe(false);
    expect(rig.snap().strikesLeft).toBe(2);
  });

  it('the host overwrites its own local release too', () => {
    const { rig, digitOf } = holdRig(true);
    advanceToDigit(digitOf);
    rig.host.act('m0', hold);
    rig.host.act('m0', release({ timerDigit: (digitOf + 5) % 10 }));
    expect(rig.snap().status).toBe('won');
  });
});

describe('R2: end stats', () => {
  it('won: stats carry the strikes left and the time ratio', () => {
    const level = def({ moduleKinds: ['wires', 'symbols', 'code'], timeMs: 100_000 });
    const rig = makeRig({ level });
    vi.advanceTimersByTime(5000);
    const blind = rig.guests[rig.peerOf('blind')];
    const steps = solveAll(rig);
    // one deliberate strike first
    blind.sendAct('m0', { kind: 'wires', type: 'cut', payload: { index: ((steps[0].action.payload?.['index'] as number) + 1) % 3 } });
    expect(rig.snap().strikesLeft).toBe(2);
    // the wrong cut may have been the only wire left uncut; solve everything that is still open
    for (const s of steps) blind.sendAct(s.moduleId, s.action);
    expect(rig.snap().status).toBe('won');
    for (const id of IDS) {
      expect(rig.rec[id].ended).toHaveLength(1);
      expect(rig.rec[id].ended[0].reason).toBe('won');
      const stats = rig.rec[id].ended[0].stats!;
      expect(stats.strikesLeft).toBe(2);
      expect(stats.msLeftRatio).toBeCloseTo(0.95, 5);
    }
  });

  it('lost by timeout: ratio 0, strikes untouched', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'], timeMs: 20_000 }) });
    vi.advanceTimersByTime(21_000);
    for (const id of IDS) {
      expect(rig.rec[id].ended).toHaveLength(1);
      expect(rig.rec[id].ended[0].reason).toBe('lost');
      expect(rig.rec[id].ended[0].stats).toEqual({ strikesLeft: 3, msLeftRatio: 0 });
    }
    expect(rig.snap().status).toBe('lost');
  });

  it('lost by strikes: strikesLeft 0, ratio still above 0', () => {
    const level = def({ moduleKinds: ['wires'], strikes: 1, timeMs: 100_000 });
    const rig = makeRig({ level });
    vi.advanceTimersByTime(10_000);
    const correct = solveAll(rig)[0].action.payload?.['index'] as number;
    rig.guests[rig.peerOf('blind')].sendAct('m0', {
      kind: 'wires',
      type: 'cut',
      payload: { index: (correct + 1) % 3 },
    });
    expect(rig.snap().status).toBe('lost');
    for (const id of IDS) {
      expect(rig.rec[id].ended).toHaveLength(1);
      expect(rig.rec[id].ended[0].reason).toBe('lost');
      expect(rig.rec[id].ended[0].stats?.strikesLeft).toBe(0);
      expect(rig.rec[id].ended[0].stats?.msLeftRatio).toBeCloseTo(0.9, 5);
    }
  });

  it('a finished level stops all timers and ignores later input', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'] }) });
    const { moduleId, action } = solveAll(rig)[0];
    rig.guests[rig.peerOf('blind')].sendAct(moduleId, action);
    expect(vi.getTimerCount()).toBe(0);
    const viewsBefore = rig.raw[IDS[1]].length;
    vi.advanceTimersByTime(30_000);
    expect(rig.raw[IDS[1]].length).toBe(viewsBefore);
    rig.guests[rig.peerOf('blind')].sendAct(moduleId, action);
    rig.player(rig.peerOf('mute')).sendEmote('wave');
    expect(rig.rec[HOST].ended).toHaveLength(1);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended).toHaveLength(1);
  });
});

describe('won propagation through real solve actions', () => {
  it('a whole multi-module level played by the blind guest ends won for everyone', () => {
    const level = def({ moduleKinds: ['wires', 'symbols', 'code'], seed: 31337 });
    const rig = makeRig({ level });
    const blind = rig.guests[rig.peerOf('blind')];
    const steps = solveAll(rig);
    expect(steps.length).toBeGreaterThan(3);
    steps.forEach((s, i) => {
      expect(rig.snap().status).toBe('playing');
      expect(rig.rec[HOST].ended).toEqual([]);
      blind.sendAct(s.moduleId, s.action);
      if (i < steps.length - 1) vi.advanceTimersByTime(300);
    });
    expect(rig.snap().status).toBe('won');
    expect(rig.snap().modules.every((m) => m.solved)).toBe(true);
    for (const id of IDS) expect(rig.rec[id].ended.map((e) => e.reason)).toEqual(['won']);
    for (const id of IDS.slice(1)) expect(last(rig.rec[id].views).view.status).toBe('won');
  });

  it('a one-module level, host plays blind itself through its local act', () => {
    const level = def({ moduleKinds: ['wires'], seed: 99 });
    const rig = makeRig({ level, rngSeed: HOST_IS_BLIND });
    expect(rig.host.role).toBe('blind');
    const { moduleId, action } = solveAll(rig)[0];
    rig.host.act(moduleId, action);
    expect(rig.snap().status).toBe('won');
    for (const id of IDS) expect(rig.rec[id].ended.map((e) => e.reason)).toEqual(['won']);
  });
});

describe('R10: the host is also a player', () => {
  it('local onView receives the host own role view, as a deep clone', () => {
    for (const role of ['blind', 'deaf', 'mute'] as Role[]) {
      const seed = seedFor((a) => a[HOST] === role);
      const rig = makeRig({ level: def(), rngSeed: seed });
      expect(rig.host.role).toBe(role);
      vi.advanceTimersByTime(1000);
      const got = last(rig.rec[HOST].views);
      expect(got.view.role).toBe(role);
      expect(json(got.view)).toBe(json(projectView(rig.snap(), role)));
      expect(got.msLeft).toBe(role === 'deaf' ? rig.snap().msLeft : null);
      // mutating what the UI got must not touch the session
      const before = json(rig.snap());
      (got.view as unknown as Record<string, unknown>)['strikesLeft'] = -5;
      if (got.view.role === 'deaf') got.view.modules[0].data['wires'] = 'tampered';
      expect(json(rig.snap())).toBe(before);
      expect(json(rig.snap())).not.toContain('tampered');
      rig.host.stop();
      for (const g of Object.values(rig.guests)) g.stop();
    }
  });

  it('a local act as the blind host works; as another role it is ignored', () => {
    const level = def({ moduleKinds: ['wires'] });
    const notBlind = makeRig({ level, rngSeed: HOST_IS_MUTE });
    const before = json(notBlind.snap());
    notBlind.host.act('m0', solveAll(notBlind)[0].action);
    expect(json(notBlind.snap())).toBe(before);
    notBlind.host.stop();
    for (const g of Object.values(notBlind.guests)) g.stop();

    const blind = makeRig({ level, rngSeed: HOST_IS_BLIND });
    blind.host.act('m0', solveAll(blind)[0].action);
    expect(blind.snap().status).toBe('won');
  });

  it('host msLeft() follows the host clock for the deaf host and is null otherwise', () => {
    const deafSeed = seedFor((a) => a[HOST] === 'deaf');
    const rig = makeRig({ rngSeed: deafSeed });
    expect(rig.host.msLeft()).toBe(100_000);
    vi.advanceTimersByTime(4000);
    expect(rig.host.msLeft()).toBe(96_000);
    const other = makeRig({ rngSeed: HOST_IS_BLIND });
    expect(other.host.msLeft()).toBeNull();
  });
});

describe('pointer and emote relay', () => {
  it('a guest pointer reaches the other guest and the host listeners with the right `by`', () => {
    const rig = makeRig();
    const [a, b] = IDS.slice(1);
    rig.guests[a].sendPointer(0.25, 0.75);
    expect(rig.rec[b].pointers).toEqual([{ by: a, x: 0.25, y: 0.75 }]);
    expect(rig.rec[HOST].pointers).toEqual([{ by: a, x: 0.25, y: 0.75 }]);
    expect(rig.rec[a].pointers).toEqual([]);
    rig.guests[b].sendPointer(0.5, 0.5);
    expect(rig.rec[a].pointers).toEqual([{ by: b, x: 0.5, y: 0.5 }]);
    expect(rig.rec[HOST].pointers.map((p) => p.by)).toEqual([a, b]);
  });

  it('a guest cannot choose `by`', () => {
    const rig = makeRig();
    const [a, b] = IDS.slice(1);
    rig.inject(a, HOST, { t: 'pointer', x: 0.1, y: 0.2, by: HOST });
    rig.inject(a, HOST, { t: 'emote', id: 'yes', by: b });
    expect(rig.rec[b].pointers).toEqual([{ by: a, x: 0.1, y: 0.2 }]);
    expect(rig.rec[b].emotes).toEqual([{ by: a, id: 'yes' }]);
    expect(rig.rec[HOST].pointers[0].by).toBe(a);
    expect(rig.rec[HOST].emotes[0].by).toBe(a);
  });

  it('the host clamps pointer coordinates to 0..1', () => {
    const rig = makeRig();
    const [a, b] = IDS.slice(1);
    rig.guests[a].sendPointer(7, -3);
    expect(rig.rec[b].pointers).toEqual([{ by: a, x: 1, y: 0 }]);
  });

  it('a guest emote reaches the other guest and the host', () => {
    const rig = makeRig();
    const [a, b] = IDS.slice(1);
    rig.guests[a].sendEmote('panic');
    expect(rig.rec[b].emotes).toEqual([{ by: a, id: 'panic' }]);
    expect(rig.rec[HOST].emotes).toEqual([{ by: a, id: 'panic' }]);
    expect(rig.rec[a].emotes).toEqual([]);
  });

  it('the host own pointer and emote go to both guests with by = host id', () => {
    const rig = makeRig();
    rig.host.sendPointer(0.3, 0.4);
    rig.host.sendEmote('slap');
    for (const id of IDS.slice(1)) {
      expect(rig.rec[id].pointers).toEqual([{ by: HOST, x: 0.3, y: 0.4 }]);
      expect(rig.rec[id].emotes).toEqual([{ by: HOST, id: 'slap' }]);
    }
    expect(rig.rec[HOST].pointers).toEqual([]);
  });
});

describe('R11: a guest leaving mid-level', () => {
  it('ends the level with player-left for the host and the other guest and stops every timer', () => {
    const rig = makeRig();
    vi.advanceTimersByTime(3000);
    const leaver = IDS[1];
    const stayer = IDS[2];
    rig.net.disconnect(leaver);
    rig.guests[leaver].stop();
    expect(rig.rec[HOST].ended.map((e) => e.reason)).toEqual(['player-left']);
    expect(rig.rec[stayer].ended.map((e) => e.reason)).toEqual(['player-left']);
    expect(rig.rec[HOST].ended[0].stats).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const seen = rig.raw[stayer].length;
    vi.advanceTimersByTime(60_000);
    expect(rig.raw[stayer].length).toBe(seen);
    expect(rig.rec[stayer].ended).toHaveLength(1);
    expect(rig.rec[HOST].ended).toHaveLength(1);
  });

  it('the host leaving ends it as host-left immediately for both guests, once', () => {
    const rig = makeRig();
    vi.advanceTimersByTime(3000);
    rig.net.disconnect(HOST);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended.map((e) => e.reason)).toEqual(['host-left']);
    vi.advanceTimersByTime(60_000);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended).toHaveLength(1);
    rig.host.stop();
  });
});

describe('host heartbeat watchdog (Review Focus 1)', () => {
  it('fires host-left once, at 10 s of silence and not at 9 s', () => {
    const rig = makeRig();
    rig.host.stop(); // the host goes silent right after its last message
    const [a, b] = IDS.slice(1);
    vi.advanceTimersByTime(9000);
    expect(rig.rec[a].ended).toEqual([]);
    expect(rig.rec[b].ended).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(rig.rec[a].ended.map((e) => e.reason)).toEqual(['host-left']);
    expect(rig.rec[b].ended.map((e) => e.reason)).toEqual(['host-left']);
    vi.advanceTimersByTime(60_000);
    expect(rig.rec[a].ended).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a live host keeps the guests quiet through a long level (heartbeats count)', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'], timeMs: 100_000 }) });
    vi.advanceTimersByTime(60_000);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended).toEqual([]);
    expect(rig.raw[IDS[1]].some((m) => m.t === 'heartbeat')).toBe(true);
  });

  it('heartbeats arrive every 2 s even when the blind and mute views do not change', () => {
    const rig = makeRig({ rngSeed: HOST_IS_MUTE });
    const blind = rig.peerOf('blind');
    const before = rig.raw[blind].filter((m) => m.t === 'heartbeat').length;
    vi.advanceTimersByTime(10_000);
    expect(rig.raw[blind].filter((m) => m.t === 'heartbeat').length - before).toBe(5);
  });

  it('every host message resets the silence window', () => {
    const rig = makeRig({ rngSeed: HOST_IS_MUTE });
    rig.host.stop();
    const guest = IDS[1];
    vi.advanceTimersByTime(8000);
    rig.inject(HOST, guest, { t: 'heartbeat', hostTimeMs: 1 });
    vi.advanceTimersByTime(8000);
    expect(rig.rec[guest].ended).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(rig.rec[guest].ended.map((e) => e.reason)).toEqual(['host-left']);
  });
});

describe('guest timer (R13 / Review Focus 5)', () => {
  const setup = (): { rig: Rig; clock: { t: number }; deaf: PeerId } => {
    const clock = { t: 50_000 };
    const level = def({ moduleKinds: ['wires'], timeMs: 100_000 });
    // the host clock runs on a wildly different base: any use of it by a guest shows up
    const rig = makeRig({
      level,
      rngSeed: HOST_IS_MUTE,
      guestNow: () => clock.t,
      hostNow: () => Date.now() + 5_000_000,
    });
    return { rig, clock, deaf: rig.peerOf('deaf') };
  };

  it('is null for the blind and mute guests, live for the deaf guest', () => {
    for (const hostRole of ['blind', 'deaf', 'mute'] as Role[]) {
      const rig = makeRig({ rngSeed: seedFor((a) => a[HOST] === hostRole) });
      for (const id of IDS.slice(1)) {
        const expected = rig.assign[id] === 'deaf' ? 100_000 : null;
        expect(rig.guests[id].msLeft()).toBe(expected);
        expect(last(rig.rec[id].views).msLeft).toBe(expected);
      }
      rig.host.stop();
      for (const g of Object.values(rig.guests)) g.stop();
    }
  });

  it('counts down from the last received view with the guest own clock', () => {
    const { rig, clock, deaf } = setup();
    clock.t += 1500;
    expect(rig.guests[deaf].msLeft()).toBe(98_500);
    clock.t += 500_000;
    expect(rig.guests[deaf].msLeft()).toBe(0);
  });

  it('after a backgrounded tab: equals the LAST flushed view msLeft minus time since that delivery', () => {
    const { rig, clock, deaf } = setup();
    rig.net.hold(deaf);
    vi.advanceTimersByTime(30_000); // host runs 30 s, the guest tab hears nothing
    clock.t += 5000; // the throttled guest clock only moved 5 s: a local count would say 95 s
    expect(rig.net.queued(deaf)).toBeGreaterThan(50);
    expect(rig.guests[deaf].msLeft()).toBe(95_000); // stale, as expected before the flush
    rig.net.flush(deaf);
    const lastMsg = last(rig.raw[deaf].filter((m) => m.t === 'view'));
    const lastLeft = lastMsg.t === 'view' && lastMsg.view.role === 'deaf' ? lastMsg.view.msLeft : -1;
    expect(lastLeft).toBe(70_000);
    expect(rig.guests[deaf].msLeft()).toBe(70_000);
    expect(last(rig.rec[deaf].views).msLeft).toBe(70_000);
    clock.t += 1250;
    expect(rig.guests[deaf].msLeft()).toBe(68_750);
  });

  it('ignores a duplicate or out-of-order seq and re-bases on a newer one', () => {
    const { rig, clock, deaf } = setup();
    vi.advanceTimersByTime(10_000); // host at 90 s, guest received views up to that
    const lastMsg = last(rig.raw[deaf].filter((m) => m.t === 'view'));
    if (lastMsg.t !== 'view' || lastMsg.view.role !== 'deaf') throw new Error('expected a deaf view');
    expect(lastMsg.view.msLeft).toBe(90_000);
    const seq = lastMsg.seq;
    const viewsBefore = rig.rec[deaf].views.length;
    const withLeft = (msLeft: number) => ({ ...lastMsg.view, msLeft });
    // duplicate and older seq: ignored
    rig.inject(HOST, deaf, { t: 'view', seq, hostTimeMs: 1, view: withLeft(11) });
    rig.inject(HOST, deaf, { t: 'view', seq: 1, hostTimeMs: 1, view: withLeft(22) });
    rig.inject(HOST, deaf, { t: 'view', seq: seq - 1, hostTimeMs: 1, view: withLeft(33) });
    expect(rig.rec[deaf].views.length).toBe(viewsBefore);
    expect(rig.guests[deaf].msLeft()).toBe(90_000);
    // a newer seq re-bases the timer immediately
    clock.t += 3000;
    rig.inject(HOST, deaf, { t: 'view', seq: seq + 1000, hostTimeMs: 1, view: withLeft(40_000) });
    expect(rig.guests[deaf].msLeft()).toBe(40_000);
    clock.t += 1000;
    expect(rig.guests[deaf].msLeft()).toBe(39_000);
    // and an older seq afterwards is still ignored
    rig.inject(HOST, deaf, { t: 'view', seq: seq + 999, hostTimeMs: 1, view: withLeft(77_777) });
    expect(rig.guests[deaf].msLeft()).toBe(39_000);
  });

  it('a silent-then-flushed tab does not call the host dead: the flush is a host message', () => {
    const { rig, clock, deaf } = setup();
    rig.net.hold(deaf);
    vi.advanceTimersByTime(30_000);
    clock.t += 30_000;
    rig.net.flush(deaf);
    vi.advanceTimersByTime(1000);
    expect(rig.rec[deaf].ended).toEqual([]);
  });
});

describe('stop()', () => {
  it('host.stop() clears its intervals and ignores later messages', () => {
    const rig = makeRig({ level: def({ moduleKinds: ['wires'] }) });
    rig.host.stop();
    const before = json(rig.snap());
    rig.guests[rig.peerOf('blind')].sendAct('m0', solveAll(rig)[0].action);
    expect(json(rig.snap())).toBe(before);
    for (const g of Object.values(rig.guests)) g.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a guest after stop() fires nothing', () => {
    const rig = makeRig();
    const [a] = IDS.slice(1);
    rig.guests[a].stop();
    rig.host.stop();
    vi.advanceTimersByTime(60_000);
    expect(rig.rec[a].ended).toEqual([]);
  });
});

describe('GuestGame constructed before the host starts', () => {
  it('works: roles and views arrive after the guests are listening', () => {
    const rig = makeRig({ start: false });
    expect(rig.guests[IDS[1]].role).toBeNull();
    rig.host.start();
    expect(rig.guests[IDS[1]].role).not.toBeNull();
    expect(rig.rec[IDS[1]].views.length).toBeGreaterThan(0);
  });
});

describe('I1: the host salts the session seed', () => {
  it('a level rebuilt from anything a guest sees does not reproduce the host bomb (10 rng seeds)', () => {
    const level = buildLevel(9); // all four module kinds
    const bombs = new Set<string>();
    for (let rngSeed = 1; rngSeed <= 10; rngSeed++) {
      const rig = makeRig({ level, rngSeed });
      const real = json(rig.snap().modules);
      bombs.add(real);
      for (const id of IDS.slice(1)) {
        const roles = rig.raw[id].find((m) => m.t === 'roles');
        if (roles?.t !== 'roles') throw new Error('no roles');
        expect(roles.level.seed).toBe(0);
        expect(roles.level.id).toBe(level.id);
        expect(json(createSession(buildLevel(roles.level.id)).modules)).not.toBe(real);
        expect(json(createSession(roles.level).modules)).not.toBe(real);
      }
      expect(json(createSession(level).modules)).not.toBe(real);
      rig.host.stop();
      for (const g of Object.values(rig.guests)) g.stop();
    }
    expect(bombs.size).toBe(10); // each host rng gives its own bomb
  });

  it('is still fully playable: the real solve actions of the salted bomb win', () => {
    const rig = makeRig({ level: buildLevel(7), rngSeed: HOST_IS_MUTE });
    const blind = rig.guests[rig.peerOf('blind')];
    for (const s of solveAll(rig)) blind.sendAct(s.moduleId, s.action);
    expect(rig.snap().status).toBe('won');
    for (const id of IDS) expect(rig.rec[id].ended.map((e) => e.reason)).toEqual(['won']);
  });
});

describe('I2: the watchdog is armed by the first valid host message', () => {
  it('a long lobby wait before the host starts is not host-left', () => {
    const rig = makeRig({ start: false, rngSeed: HOST_IS_MUTE });
    vi.advanceTimersByTime(15_000);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // nothing armed yet
    rig.host.start();
    rig.host.stop(); // the host goes silent right after its first messages
    vi.advanceTimersByTime(9000);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended).toEqual([]);
    vi.advanceTimersByTime(1000);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended.map((e) => e.reason)).toEqual(['host-left']);
    vi.advanceTimersByTime(60_000);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended).toHaveLength(1);
  });

  it('malformed frames from the host do not arm it', () => {
    const rig = makeRig({ start: false, rngSeed: HOST_IS_MUTE });
    rig.inject(HOST, IDS[1], { t: 'nuke' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a host leaving during the lobby is host-left at once', () => {
    const rig = makeRig({ start: false, rngSeed: HOST_IS_MUTE });
    rig.net.disconnect(HOST);
    for (const id of IDS.slice(1)) expect(rig.rec[id].ended.map((e) => e.reason)).toEqual(['host-left']);
  });
});

describe('I3: frames lost before a channel opened are re-sent on the heartbeat', () => {
  it('a guest that lost its first roles and view gets its role and current view after one heartbeat', () => {
    for (const lost of [0, 1]) {
      const rig = makeRig({ start: false, rngSeed: HOST_IS_MUTE, level: def({ moduleKinds: ['wires', 'code'] }) });
      const id = IDS[1 + lost]; // one guest is blind, the other deaf
      rig.net.hold(id);
      rig.host.start();
      expect(rig.net.queued(id)).toBeGreaterThanOrEqual(2);
      rig.net.discard(id); // the channel was not open yet: roles and first view are gone
      expect(rig.guests[id].role).toBeNull();
      expect(rig.rec[id].views).toEqual([]);
      vi.advanceTimersByTime(2000);
      expect(rig.guests[id].role).toBe(rig.assign[id]);
      expect(rig.rec[id].views.length).toBeGreaterThan(0);
      expect(json(last(rig.rec[id].views).view)).toBe(json(projectView(rig.snap(), rig.assign[id])));
      rig.host.stop();
      for (const g of Object.values(rig.guests)) g.stop();
    }
  });

  it('a repeated roles message in the middle of play neither resets nor breaks the guest', () => {
    const rig = makeRig({ start: false, rngSeed: HOST_IS_MUTE, level: def({ moduleKinds: ['wires', 'code'] }) });
    const blindId = rig.peerOf('blind');
    let rolesFired = 0;
    rig.guests[blindId].onRoles(() => rolesFired++);
    rig.host.start();
    const step = solveAll(rig)[0];
    rig.guests[blindId].sendAct(step.moduleId, step.action); // wires solved, code still open
    expect(rig.snap().status).toBe('playing');
    vi.advanceTimersByTime(6100); // three heartbeats
    expect(rig.raw[blindId].filter((m) => m.t === 'roles').length).toBeGreaterThanOrEqual(4);
    expect(rolesFired).toBe(1);
    expect(rig.guests[blindId].role).toBe('blind');
    expect(rig.rec[blindId].ended).toEqual([]);
    expect(json(last(rig.rec[blindId].views).view)).toBe(json(projectView(rig.snap(), 'blind')));
    // and the game goes on
    for (const s of solveAll(rig).slice(1)) rig.guests[blindId].sendAct(s.moduleId, s.action);
  });

  it('a repeated roles message cannot change the role of a started guest', () => {
    const rig = makeRig({ rngSeed: HOST_IS_MUTE });
    const id = IDS[1];
    const role = rig.guests[id].role;
    rig.inject(HOST, id, { t: 'roles', assign: { [id]: role === 'blind' ? 'deaf' : 'blind' }, level: def() });
    expect(rig.guests[id].role).toBe(role);
  });
});

describe('I4: GuestGame needs the complete room', () => {
  it('throws with 0 or 1 peers, and on the host peer itself', () => {
    expect(() => new GuestGame(createMemoryNetwork(['bbbbbbbb'])[0], Date.now)).toThrow();
    expect(() => new GuestGame(createMemoryNetwork(IDS.slice(0, 2))[1], Date.now)).toThrow();
    expect(() => new GuestGame(createMemoryNetwork(IDS)[0], Date.now)).toThrow(); // lowest id is the host
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with two peers it takes the lowest id as host and talks only to it', () => {
    const net = createMemoryNetwork(IDS);
    const heard: Record<PeerId, NetMsg[]> = { [IDS[0]]: [], [IDS[1]]: [] };
    net[0].onMessage((_f, m) => heard[IDS[0]].push(m));
    net[1].onMessage((_f, m) => heard[IDS[1]].push(m));
    const guest = new GuestGame(net[2], Date.now);
    guest.sendAct('m0', { kind: 'wires', type: 'cut', payload: { index: 0 } });
    guest.sendPointer(0.5, 0.5);
    guest.sendEmote('yes');
    expect(heard[IDS[0]].map((m) => m.t)).toEqual(['act', 'pointer', 'emote']);
    expect(heard[IDS[1]]).toEqual([]);
    // a frame from the other guest is not the host's
    const got: unknown[] = [];
    guest.onEnded((r) => got.push(r));
    net[1].send(IDS[2], { t: 'ended', reason: 'won' });
    expect(got).toEqual([]);
    guest.stop();
  });
});

describe('I5: a woken-up tab is not declared host-left', () => {
  const rigWithClock = (): { rig: Rig; clock: { t: number }; guest: PeerId } => {
    const clock = { t: 50_000 };
    const rig = makeRig({ rngSeed: HOST_IS_MUTE, guestNow: () => clock.t });
    return { rig, clock, guest: rig.peerOf('blind') };
  };
  const second = (clock: { t: number }): void => {
    clock.t += 1000;
    vi.advanceTimersByTime(1000);
  };

  it('a 30 s jump of the guest clock followed by a host heartbeat is not host-left', () => {
    const { rig, clock, guest } = rigWithClock();
    clock.t += 30_000; // the tab was frozen: the overdue watchdog runs before the queued frames
    vi.advanceTimersByTime(1000);
    expect(rig.rec[guest].ended).toEqual([]);
    rig.inject(HOST, guest, { t: 'heartbeat', hostTimeMs: 1 });
    for (let i = 0; i < 5; i++) second(clock);
    expect(rig.rec[guest].ended).toEqual([]);
  });

  it('genuine silence still fires host-left exactly once, at 10 s (also after a wake-up)', () => {
    const { rig, clock, guest } = rigWithClock();
    clock.t += 30_000;
    vi.advanceTimersByTime(1000); // wake-up check: the window restarts
    rig.host.stop();
    for (let i = 0; i < 9; i++) second(clock);
    expect(rig.rec[guest].ended).toEqual([]);
    second(clock);
    expect(rig.rec[guest].ended.map((e) => e.reason)).toEqual(['host-left']);
    for (let i = 0; i < 20; i++) second(clock);
    expect(rig.rec[guest].ended).toHaveLength(1);
  });
});

describe('minor fixes', () => {
  it('a backwards host clock does not refund time', () => {
    const clock = { t: 10_000 };
    const rig = makeRig({ rngSeed: HOST_IS_MUTE, hostNow: () => clock.t, level: def({ timeMs: 100_000 }) });
    clock.t = 15_000;
    vi.advanceTimersByTime(250);
    expect(rig.snap().msLeft).toBe(95_000);
    clock.t = 12_000; // clock stepped back
    vi.advanceTimersByTime(250);
    expect(rig.snap().msLeft).toBe(95_000);
    clock.t = 16_000;
    vi.advanceTimersByTime(250);
    expect(rig.snap().msLeft).toBe(94_000); // 1 s since the last forward reading, not 4 s
  });

  it('msLeftRatio is never NaN, even for a level with no time at all', () => {
    const rig = makeRig({ rngSeed: HOST_IS_MUTE, level: def({ moduleKinds: ['wires'], timeMs: 0 }) });
    vi.advanceTimersByTime(250);
    for (const id of IDS) {
      expect(rig.rec[id].ended.map((e) => e.reason)).toEqual(['lost']);
      expect(rig.rec[id].ended[0].stats).toEqual({ strikesLeft: 3, msLeftRatio: 0 });
    }
  });

  it('a transport send that throws cannot abort the host (other guests, local callbacks, timers)', () => {
    const net = createMemoryNetwork(IDS);
    const bad = IDS[1];
    const t0 = {
      ...net[0],
      send: (to: PeerId, msg: NetMsg): void => {
        if (to === bad) throw new Error('queue full');
        net[0].send(to, msg);
      },
    };
    const host = new HostGame(t0, def({ moduleKinds: ['wires'] }), Date.now, { rng: createRng(HOST_IS_MUTE) });
    const localViews: unknown[] = [];
    host.onView((v) => localViews.push(v));
    const good = new GuestGame(net[2], Date.now);
    const goodViews: unknown[] = [];
    good.onView((v) => goodViews.push(v));
    expect(() => host.start()).not.toThrow();
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
    expect(good.role).not.toBeNull();
    expect(goodViews.length).toBeGreaterThan(0);
    expect(localViews.length).toBeGreaterThan(0);
    host.stop();
    good.stop();
  });

  it('a guest send that throws does not throw out of sendAct', () => {
    const net = createMemoryNetwork(IDS);
    const t2 = {
      ...net[2],
      send: (): void => {
        throw new Error('queue full');
      },
    };
    const guest = new GuestGame(t2, Date.now);
    expect(() => guest.sendAct('m0', { kind: 'wires', type: 'cut', payload: { index: 0 } })).not.toThrow();
    expect(() => guest.sendPointer(0.1, 0.1)).not.toThrow();
    guest.stop();
  });
});

describe('default host entropy (no injected rng)', () => {
  const level = buildLevel(9); // all four module kinds
  const FIXED_NOW = (): number => 5_000;

  /** A default-constructed host (no options) on a fresh 3-peer network; returns its started state. */
  const defaultHost = (): { assign: Record<PeerId, Role>; modules: string } => {
    const net = createMemoryNetwork(IDS);
    const roles: NetMsg[] = [];
    net[1].onMessage((_f, m) => roles.push(m));
    const host = new HostGame(net[0], level, FIXED_NOW);
    host.start();
    host.stop();
    const m = roles.find((x) => x.t === 'roles');
    if (m?.t !== 'roles') throw new Error('no roles');
    return { assign: m.assign, modules: json(host.snapshot()!.modules) };
  };

  /** Make crypto.getRandomValues hand out the given values, in order, then keep cycling. */
  const stubCrypto = (values: number[]): void => {
    let i = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint32Array) => {
        a[0] = values[i++ % values.length];
        return a;
      },
    });
  };

  it('the bomb comes from crypto entropy, not from the clock', () => {
    const bombs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      stubCrypto([1000 + i * 7919, 5000 + i * 104729]);
      bombs.add(defaultHost().modules);
    }
    expect(bombs.size).toBe(10); // different entropy, same now(): different bombs

    // same entropy, different wall clocks: the very same bomb and roles
    stubCrypto([111, 222]);
    vi.setSystemTime(1_000);
    const a = defaultHost();
    stubCrypto([111, 222]);
    vi.setSystemTime(9_999_999);
    const b = defaultHost();
    expect(b).toEqual(a);
  });

  it('the salt rng is a separate rng with its own fresh entropy, not the role rng continued', () => {
    stubCrypto([424242]); // both draws return the same seed: a shared rng would differ from two fresh ones
    const got = defaultHost();
    expect(got.assign).toEqual(assignRoles(IDS, createRng(424242)));
    const salt = createRng(424242).int(2 ** 31); // the FIRST output of a fresh rng, not the third
    expect(got.modules).toBe(json(createSession({ ...level, seed: salt }).modules));
  });

  it('with Date.now frozen, 50 default hosts still differ in roles and in bombs', () => {
    vi.setSystemTime(2_000_000);
    const assigns = new Set<string>();
    const bombs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const h = defaultHost();
      assigns.add(json(h.assign));
      bombs.add(h.modules);
    }
    expect(assigns.size).toBeGreaterThanOrEqual(2);
    expect(bombs.size).toBeGreaterThanOrEqual(2);
    expect(bombs.size).toBeGreaterThan(40); // 31-bit salt: practically all distinct
  });

  it('without WebCrypto it takes the weaker fallback path, still starts, and still varies', () => {
    vi.stubGlobal('crypto', undefined);
    vi.setSystemTime(3_000_000);
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0.123);
    const first = defaultHost();
    random.mockReturnValue(0.876);
    const second = defaultHost();
    expect(Object.values(first.assign).sort()).toEqual(['blind', 'deaf', 'mute']);
    expect(first.modules).not.toBe(second.modules);
  });
});
