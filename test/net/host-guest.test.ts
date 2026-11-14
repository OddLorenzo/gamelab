import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULES, createSession } from '../../src/core/bomb';
import type { LevelDef, Session } from '../../src/core/bomb';
import { createRng } from '../../src/core/rng';
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

const solveAll = (level: LevelDef): { moduleId: string; action: ModuleAction }[] =>
  createSession(level).modules.flatMap((m) =>
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
      const secret = createSession(level);
      const serial = secret.modules[3].data['serial'] as string;
      const target = secret.modules[3].data['target'] as string;
      const rig = makeRig({ level, rngSeed: seed });
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
  const solveWires = (rig: Rig) => solveAll(rig.level)[0];

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
    const { moduleId, action } = solveAll(level)[0];
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
    rig.guests[rig.peerOf('blind')].sendAct('m0', solveAll(rig.level)[0].action);
    expect(rig.rec[a].ended.map((e) => e.reason)).toEqual(['won']);
    expect(last(rig.rec[a].views).view.status).toBe('won');
  });
});

describe('R1: the host owns the button timer digit', () => {
  const holdSeed = (() => {
    for (let seed = 1; seed < 500; seed++) {
      const m = createSession(def({ moduleKinds: ['button'], seed })).modules[0];
      if (needsHold(m.data['color'] as never, m.data['label'] as never)) return seed;
    }
    throw new Error('no hold seed');
  })();
  const level = def({ moduleKinds: ['button'], seed: holdSeed, timeMs: 100_000 });
  const digitOf = createSession(level).modules[0].data['digit'] as number;
  /** Advance so that the host timer shows `digit` as its seconds digit, plus half a second. */
  const advanceToDigit = (digit: number): void => {
    vi.advanceTimersByTime(100_000 - (60_000 + digit * 1000 + 500));
  };
  const hold: ModuleAction = { kind: 'button', type: 'hold' };
  const release = (payload?: Record<string, unknown>): ModuleAction =>
    payload === undefined ? { kind: 'button', type: 'release' } : { kind: 'button', type: 'release', payload };

  it('the deaf view carries the button digit the rules need', () => {
    const rig = makeRig({ level });
    const view = last(rig.rec[rig.peerOf('deaf')].views).view;
    expect(view.role === 'deaf' && view.modules[0].data['digit']).toBe(digitOf);
  });

  it('a bogus client digit is overwritten by the real host digit (solves when the host timer matches)', () => {
    const rig = makeRig({ level });
    const blind = rig.guests[rig.peerOf('blind')];
    advanceToDigit(digitOf);
    blind.sendAct('m0', hold);
    blind.sendAct('m0', release({ timerDigit: (digitOf + 1) % 10 }));
    expect(rig.snap().status).toBe('won');
    expect(rig.snap().strikesLeft).toBe(3);
  });

  it('a missing client digit is filled in by the host', () => {
    const rig = makeRig({ level });
    const blind = rig.guests[rig.peerOf('blind')];
    advanceToDigit(digitOf);
    blind.sendAct('m0', hold);
    blind.sendAct('m0', release());
    expect(rig.snap().status).toBe('won');
  });

  it('a correct client digit at the wrong host time does not solve (strike)', () => {
    const rig = makeRig({ level });
    const blind = rig.guests[rig.peerOf('blind')];
    advanceToDigit((digitOf + 3) % 10);
    blind.sendAct('m0', hold);
    blind.sendAct('m0', release({ timerDigit: digitOf }));
    expect(rig.snap().status).toBe('playing');
    expect(rig.snap().modules[0].solved).toBe(false);
    expect(rig.snap().strikesLeft).toBe(2);
  });

  it('uses the host clock at the moment of the act, not the last 250 ms tick', () => {
    const rig = makeRig({ level });
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
    const rig = makeRig({ level, rngSeed: HOST_IS_BLIND });
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
    const steps = solveAll(level);
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
    const correct = solveAll(level)[0].action.payload?.['index'] as number;
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
    const { moduleId, action } = solveAll(rig.level)[0];
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
    const steps = solveAll(level);
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
    const { moduleId, action } = solveAll(level)[0];
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
    notBlind.host.act('m0', solveAll(level)[0].action);
    expect(json(notBlind.snap())).toBe(before);
    notBlind.host.stop();
    for (const g of Object.values(notBlind.guests)) g.stop();

    const blind = makeRig({ level, rngSeed: HOST_IS_BLIND });
    blind.host.act('m0', solveAll(level)[0].action);
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
    rig.guests[rig.peerOf('blind')].sendAct('m0', solveAll(rig.level)[0].action);
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
