import { describe, it, expect } from 'vitest';
import { createRng } from '../../src/core/rng';
import { correctIndex } from '../../src/core/modules/wires';
import type { Wire } from '../../src/core/modules/wires';
import { needsHold } from '../../src/core/modules/button';
import type { ButtonColor, ButtonLabel } from '../../src/core/modules/button';
import { MODULES, createSession, reduce } from '../../src/core/bomb';
import type { LevelDef, Session, SessionEvent } from '../../src/core/bomb';
import type { ModuleAction, ModuleKind, Role } from '../../src/core/types';

const ALL_KINDS: ModuleKind[] = ['wires', 'button', 'symbols', 'code'];

const def = (over: Partial<LevelDef> = {}): LevelDef => ({
  id: 7,
  stage: 1,
  seed: 1234,
  moduleKinds: ALL_KINDS,
  difficulty: 5,
  timeMs: 60_000,
  strikes: 3,
  setting: 'jungle',
  ...over,
});

const blindAct = (moduleId: string, action: ModuleAction): SessionEvent => ({
  type: 'act',
  role: 'blind',
  moduleId,
  action,
});

const tick = (dtMs: number): SessionEvent => ({ type: 'tick', dtMs });

const submitCode = (id: string): SessionEvent => blindAct(id, { kind: 'code', type: 'submit' });

/** A single code module: an empty submit is always a strike (the target is 4 digits). */
const codeOnly = (strikes: number): Session =>
  createSession(def({ moduleKinds: ['code'], strikes }));

/** Plays module `i`'s solve() sequence as blind. */
const solveModule = (s: Session, i: number): Session => {
  const m = s.modules[i];
  let cur = s;
  for (const action of MODULES[m.kind].solve(m)) cur = reduce(cur, blindAct(m.id, action));
  return cur;
};

const solveAll = (s: Session): Session => {
  let cur = s;
  for (let i = 0; i < s.modules.length; i++) cur = solveModule(cur, i);
  return cur;
};

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
};

describe('MODULES registry', () => {
  it('maps every kind to a module of that kind', () => {
    expect(Object.keys(MODULES).sort()).toEqual([...ALL_KINDS].sort());
    for (const k of ALL_KINDS) expect(MODULES[k].kind).toBe(k);
  });
});

describe('createSession', () => {
  it('starts playing with the level numbers and one module per kind, ids m0..mN in order', () => {
    const s = createSession(def({ id: 42, timeMs: 90_000, strikes: 2 }));
    expect(s.levelId).toBe(42);
    expect(s.status).toBe('playing');
    expect(s.strikesLeft).toBe(2);
    expect(s.msLeft).toBe(90_000);
    expect(s.modules.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(s.modules.map((m) => m.kind)).toEqual(ALL_KINDS);
    expect(s.modules.every((m) => !m.solved)).toBe(true);
  });

  it('uses ONE rng created once per session, consumed in module order', () => {
    const d = def({ seed: 99, moduleKinds: ['wires', 'code', 'wires', 'button'], difficulty: 3 });
    const rng = createRng(99);
    const expected = d.moduleKinds.map((k, i) => MODULES[k].init(`m${i}`, rng, 3));
    expect(createSession(d).modules).toEqual(expected);
  });

  it('is deterministic per seed and differs across seeds', () => {
    expect(createSession(def({ seed: 5 }))).toEqual(createSession(def({ seed: 5 })));
    const serials = new Set<unknown>();
    for (let seed = 0; seed < 20; seed++) {
      serials.add(createSession(def({ seed })).modules[3].data['serial']);
    }
    expect(serials.size).toBeGreaterThan(10);
  });

  it('passes the level difficulty to the modules (wire count)', () => {
    const wires = (difficulty: number): number =>
      (createSession(def({ moduleKinds: ['wires'], difficulty })).modules[0].data['wires'] as unknown[])
        .length;
    expect(wires(1)).toBe(3);
    expect(wires(5)).toBe(6);
  });
});

describe('reduce: strikes', () => {
  it('a wrong wire cut strikes: strikesLeft goes down by exactly 1, status stays playing', () => {
    const s = createSession(def({ moduleKinds: ['wires'], difficulty: 3, strikes: 3 }));
    const wires = s.modules[0].data['wires'] as Wire[];
    const right = correctIndex(wires);
    const wrong = right === 0 ? 1 : 0;
    const next = reduce(s, blindAct('m0', { kind: 'wires', type: 'cut', payload: { index: wrong } }));
    expect(next.strikesLeft).toBe(2);
    expect(next.status).toBe('playing');
    expect(next.modules[0].solved).toBe(false);
    expect((next.modules[0].data['wires'] as Wire[])[wrong].cut).toBe(true);
  });

  it('counts strikes exactly and loses at 0 (3 -> 2 -> 1 -> 0 lost)', () => {
    let s = codeOnly(3);
    s = reduce(s, submitCode('m0'));
    expect([s.strikesLeft, s.status]).toEqual([2, 'playing']);
    s = reduce(s, submitCode('m0'));
    expect([s.strikesLeft, s.status]).toEqual([1, 'playing']);
    s = reduce(s, submitCode('m0'));
    expect([s.strikesLeft, s.status]).toEqual([0, 'lost']);
  });

  it('one strike allowed: the first strike loses', () => {
    const s = reduce(codeOnly(1), submitCode('m0'));
    expect(s.strikesLeft).toBe(0);
    expect(s.status).toBe('lost');
  });

  it('strikesLeft never goes negative after losing', () => {
    let s = reduce(codeOnly(1), submitCode('m0'));
    s = reduce(s, submitCode('m0'));
    expect(s.strikesLeft).toBe(0);
  });

  it('a non-strike action does not touch strikesLeft and updates only that module', () => {
    const s = createSession(def());
    const next = reduce(s, blindAct('m3', { kind: 'code', type: 'digit', payload: { d: 4 } }));
    expect(next.strikesLeft).toBe(3);
    expect(next.status).toBe('playing');
    expect(next.modules[3].data['entered']).toBe('4');
    expect(next.modules[0]).toBe(s.modules[0]);
    expect(next.modules[1]).toBe(s.modules[1]);
    expect(next.modules[2]).toBe(s.modules[2]);
    expect(next.msLeft).toBe(s.msLeft);
  });

  it('a strike on one module does not leak into the other modules', () => {
    const s = createSession(def());
    const next = reduce(s, submitCode('m3'));
    expect(next.strikesLeft).toBe(2);
    expect(next.modules.slice(0, 3)).toEqual(s.modules.slice(0, 3));
  });

  it('a strike does not change msLeft', () => {
    const s = reduce(codeOnly(2), submitCode('m0'));
    expect(s.msLeft).toBe(60_000);
  });

  it('two strikes in a row on different modules cost exactly 2 strikes', () => {
    let s = createSession(def({ seed: 41, strikes: 3 }));
    const order = s.modules[2].data['order'] as number[];
    const wrongSlot = [0, 1, 2, 3].find((x) => x !== order[0]) as number;
    s = reduce(s, blindAct('m2', { kind: 'symbols', type: 'tap', payload: { slot: wrongSlot } }));
    expect(s.strikesLeft).toBe(2);
    s = reduce(s, submitCode('m3'));
    expect(s.strikesLeft).toBe(1);
    expect(s.status).toBe('playing');
    s = reduce(s, submitCode('m3'));
    expect(s.strikesLeft).toBe(0);
    expect(s.status).toBe('lost');
  });
});

describe('reduce: winning', () => {
  it('solving every module via solve() gives won, only on the last module', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const difficulty of [1, 3, 5]) {
        let s = createSession(def({ seed, difficulty }));
        const total = s.modules.length;
        for (let i = 0; i < total; i++) {
          s = solveModule(s, i);
          expect(s.modules[i].solved).toBe(true);
          expect(s.status).toBe(i === total - 1 ? 'won' : 'playing');
        }
        expect(s.strikesLeft).toBe(3);
      }
    }
  });

  it('solves in any module order', () => {
    let s = createSession(def({ seed: 8 }));
    for (const i of [2, 0, 3, 1]) s = solveModule(s, i);
    expect(s.status).toBe('won');
  });

  it('3 of 4 solved is still playing', () => {
    let s = createSession(def({ seed: 3 }));
    for (const i of [0, 1, 2]) s = solveModule(s, i);
    expect(s.status).toBe('playing');
    expect(s.modules.map((m) => m.solved)).toEqual([true, true, true, false]);
  });

  it('winning keeps msLeft', () => {
    const s = solveAll(createSession(def({ seed: 11 })));
    expect(s.status).toBe('won');
    expect(s.msLeft).toBe(60_000);
  });

  it('a hold-button is solved with the timerDigit from the payload (reduce does not inject one)', () => {
    let found: Session | undefined;
    for (let seed = 0; seed < 200 && !found; seed++) {
      const s = createSession(def({ seed, moduleKinds: ['button'] }));
      const d = s.modules[0].data;
      if (needsHold(d['color'] as ButtonColor, d['label'] as ButtonLabel)) found = s;
    }
    expect(found).toBeDefined();
    const s = found as Session;
    const digit = s.modules[0].data['digit'] as number;
    const held = reduce(s, blindAct('m0', { kind: 'button', type: 'hold' }));
    const bad = reduce(
      held,
      blindAct('m0', { kind: 'button', type: 'release', payload: { timerDigit: (digit + 1) % 10 } }),
    );
    expect(bad.strikesLeft).toBe(2);
    expect(bad.status).toBe('playing');
    const good = reduce(
      held,
      blindAct('m0', { kind: 'button', type: 'release', payload: { timerDigit: digit } }),
    );
    expect(good.status).toBe('won');
    expect(good.strikesLeft).toBe(3);
  });
});

describe('reduce: roles', () => {
  const roles: Role[] = ['deaf', 'mute'];

  it('ignores an act from deaf or mute, even a perfectly valid solving action (same reference)', () => {
    const s = createSession(def({ seed: 21 }));
    for (const m of s.modules) {
      for (const action of MODULES[m.kind].solve(m)) {
        for (const role of roles) {
          expect(reduce(s, { type: 'act', role, moduleId: m.id, action })).toBe(s);
        }
      }
    }
    for (const role of roles) {
      expect(
        reduce(s, { type: 'act', role, moduleId: 'm3', action: { kind: 'code', type: 'submit' } }),
      ).toBe(s);
    }
  });

  it('ignored role acts never cost a strike', () => {
    const s = createSession(def({ seed: 22, strikes: 1 }));
    const next = reduce(s, {
      type: 'act',
      role: 'deaf',
      moduleId: 'm3',
      action: { kind: 'code', type: 'submit' },
    });
    expect(next.strikesLeft).toBe(1);
    expect(next.status).toBe('playing');
  });

  it('blind act is accepted (control for the role checks)', () => {
    const s = createSession(def({ seed: 22 }));
    expect(reduce(s, submitCode('m3'))).not.toBe(s);
  });
});

describe('reduce: unknown targets', () => {
  it('ignores an act with an unknown moduleId (same reference)', () => {
    const s = createSession(def());
    expect(reduce(s, blindAct('m9', { kind: 'code', type: 'submit' }))).toBe(s);
    expect(reduce(s, blindAct('', { kind: 'code', type: 'submit' }))).toBe(s);
    expect(reduce(s, blindAct('wires', { kind: 'wires', type: 'cut', payload: { index: 0 } }))).toBe(s);
  });

  it("ignores an act whose action.kind differs from the module's kind (same reference)", () => {
    const s = createSession(def());
    // m3 is the code module; a wires action aimed at it must be dropped
    expect(reduce(s, blindAct('m3', { kind: 'wires', type: 'cut', payload: { index: 0 } }))).toBe(s);
    // m0 is wires; a code submit aimed at it must not strike
    expect(reduce(s, blindAct('m0', { kind: 'code', type: 'submit' }))).toBe(s);
  });
});

describe('reduce: finished sessions', () => {
  const events = (s: Session): SessionEvent[] => [
    submitCode('m3'),
    blindAct('m0', { kind: 'wires', type: 'cut', payload: { index: 0 } }),
    tick(1000),
    tick(0),
    { type: 'act', role: 'deaf', moduleId: 'm3', action: { kind: 'code', type: 'submit' } },
    blindAct('nope', { kind: 'code', type: 'submit' }),
    ...s.modules.map((m) => blindAct(m.id, MODULES[m.kind].solve(m)[0])),
  ];

  it('ignores every event after won (same reference)', () => {
    const won = solveAll(createSession(def({ seed: 31 })));
    expect(won.status).toBe('won');
    for (const ev of events(won)) expect(reduce(won, ev)).toBe(won);
  });

  it('ignores every event after lost by strikes (same reference)', () => {
    const s = createSession(def({ seed: 31, strikes: 1 }));
    const lost = reduce(s, submitCode('m3'));
    expect(lost.status).toBe('lost');
    for (const ev of events(lost)) expect(reduce(lost, ev)).toBe(lost);
  });

  it('ignores every event after lost by timeout (same reference)', () => {
    const lost = reduce(createSession(def({ seed: 32 })), tick(60_000));
    expect(lost.status).toBe('lost');
    for (const ev of events(lost)) expect(reduce(lost, ev)).toBe(lost);
  });

  it('a win is not overwritten by a later tick past msLeft', () => {
    const won = solveAll(createSession(def({ seed: 33, timeMs: 1000 })));
    expect(reduce(won, tick(5000))).toBe(won);
    expect(won.msLeft).toBe(1000);
  });
});

describe('reduce: tick', () => {
  it('subtracts dtMs exactly and stays playing', () => {
    const s = reduce(createSession(def({ timeMs: 10_000 })), tick(250));
    expect(s.msLeft).toBe(9750);
    expect(s.status).toBe('playing');
  });

  it('1 ms short of the end is still playing with 1 ms left', () => {
    const s = reduce(createSession(def({ timeMs: 10_000 })), tick(9999));
    expect(s.msLeft).toBe(1);
    expect(s.status).toBe('playing');
  });

  it('landing exactly on 0 loses', () => {
    const s = reduce(createSession(def({ timeMs: 10_000 })), tick(10_000));
    expect(s.msLeft).toBe(0);
    expect(s.status).toBe('lost');
  });

  it('past msLeft loses and clamps msLeft at 0 (never negative)', () => {
    const s = reduce(createSession(def({ timeMs: 10_000 })), tick(10_001));
    expect(s.msLeft).toBe(0);
    expect(s.status).toBe('lost');
  });

  it('a huge dt (and Infinity) loses with msLeft 0', () => {
    for (const dt of [1e12, Number.MAX_SAFE_INTEGER, Infinity]) {
      const s = reduce(createSession(def()), tick(dt));
      expect(s.msLeft).toBe(0);
      expect(s.status).toBe('lost');
    }
  });

  it('dtMs 0 is a no-op (same reference)', () => {
    const s = createSession(def());
    expect(reduce(s, tick(0))).toBe(s);
  });

  it('negative and NaN dtMs are ignored: time never runs backwards (same reference)', () => {
    const s = createSession(def());
    expect(reduce(s, tick(-1))).toBe(s);
    expect(reduce(s, tick(-1e9))).toBe(s);
    expect(reduce(s, tick(NaN))).toBe(s);
    expect(reduce(s, tick(-Infinity))).toBe(s);
  });

  it('ticks accumulate and leave modules and strikes untouched', () => {
    let s = createSession(def({ timeMs: 1000 }));
    const before = s;
    s = reduce(s, tick(300));
    s = reduce(s, tick(300));
    expect(s.msLeft).toBe(400);
    expect(s.modules).toBe(before.modules);
    expect(s.strikesLeft).toBe(3);
    s = reduce(s, tick(400));
    expect(s.status).toBe('lost');
  });

  it('a timeout with strikes left still loses, and the strikes are kept', () => {
    const s = reduce(createSession(def({ strikes: 3 })), tick(60_000));
    expect(s.status).toBe('lost');
    expect(s.strikesLeft).toBe(3);
  });
});

describe('reduce: purity', () => {
  it('never mutates its input (deep-frozen session survives every event kind)', () => {
    for (let seed = 0; seed < 25; seed++) {
      const s = deepFreeze(createSession(def({ seed })));
      const snapshot = JSON.stringify(s);
      const evs: SessionEvent[] = [
        tick(500),
        tick(1e9),
        submitCode('m3'),
        blindAct('m3', { kind: 'code', type: 'digit', payload: { d: 1 } }),
        blindAct('m0', { kind: 'wires', type: 'cut', payload: { index: 0 } }),
        blindAct('m1', { kind: 'button', type: 'hold' }),
        blindAct('m2', { kind: 'symbols', type: 'tap', payload: { slot: 0 } }),
        { type: 'act', role: 'mute', moduleId: 'm3', action: { kind: 'code', type: 'submit' } },
      ];
      for (const ev of evs) reduce(s, ev);
      for (const m of s.modules) {
        for (const action of MODULES[m.kind].solve(m)) reduce(s, blindAct(m.id, action));
      }
      expect(JSON.stringify(s)).toBe(snapshot);
    }
  });

  it('returns a new session and modules array on change, leaving the old one intact', () => {
    const s = createSession(def());
    const next = reduce(s, submitCode('m3'));
    expect(next).not.toBe(s);
    expect(next.modules).not.toBe(s.modules);
    expect(s.modules[3].data['entered']).toBe('');
  });
});
