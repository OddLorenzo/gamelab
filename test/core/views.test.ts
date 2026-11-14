import { describe, it, expect } from 'vitest';
import { MODULES, createSession, reduce } from '../../src/core/bomb';
import type { LevelDef, Session } from '../../src/core/bomb';
import { projectView } from '../../src/core/views';
import type { BlindView, DeafView, MuteView } from '../../src/core/views';
import { SYMBOL_COLUMNS } from '../../src/core/modules/symbols';
import type { ModuleKind } from '../../src/core/types';

const ALL_KINDS: ModuleKind[] = ['wires', 'button', 'symbols', 'code'];
const COLOR_NAMES = ['red', 'blue', 'yellow', 'green', 'white'];
const GLYPH_NAMES = [...new Set(SYMBOL_COLUMNS.flat())];
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 3);

const def = (seed: number, over: Partial<LevelDef> = {}): LevelDef => ({
  id: 1,
  stage: 1,
  seed,
  moduleKinds: ALL_KINDS,
  difficulty: 5,
  timeMs: 45_000,
  strikes: 3,
  setting: 'jungle',
  ...over,
});

const keysOf = (v: object): string[] => Object.keys(v).sort();

const blindOf = (s: Session): BlindView => {
  const v = projectView(s, 'blind');
  if (v.role !== 'blind') throw new Error('expected a blind view');
  return v;
};
const deafOf = (s: Session): DeafView => {
  const v = projectView(s, 'deaf');
  if (v.role !== 'deaf') throw new Error('expected a deaf view');
  return v;
};
const muteOf = (s: Session): MuteView => {
  const v = projectView(s, 'mute');
  if (v.role !== 'mute') throw new Error('expected a mute view');
  return v;
};

const submit = (s: Session): Session =>
  reduce(s, { type: 'act', role: 'blind', moduleId: 'm0', action: { kind: 'code', type: 'submit' } });

describe('blind view', () => {
  it('has exactly the specified keys and the right slots per kind', () => {
    for (const seed of SEEDS) {
      const s = createSession(def(seed, { difficulty: 1 + (seed % 5) }));
      const v = blindOf(s);
      expect(keysOf(v)).toEqual(['msLeftBucket', 'role', 'status', 'strikesLeft', 'targets']);
      expect(v.msLeftBucket).toBeNull();
      expect(v.strikesLeft).toBe(3);
      expect(v.status).toBe('playing');
      expect(v.targets.map((t) => t.moduleId)).toEqual(['m0', 'm1', 'm2', 'm3']);
      expect(v.targets.map((t) => t.kind)).toEqual(ALL_KINDS);
      for (const t of v.targets) expect(keysOf(t)).toEqual(['kind', 'moduleId', 'slots']);
      const wireCount = (s.modules[0].data['wires'] as unknown[]).length;
      expect(v.targets.map((t) => t.slots)).toEqual([wireCount, 1, 4, 12]);
    }
  });

  it('wire slots follow the wire count (3..6)', () => {
    const counts = new Set<number>();
    for (const difficulty of [1, 2, 3, 4, 5]) {
      const s = createSession(def(1, { moduleKinds: ['wires'], difficulty }));
      const v = blindOf(s);
      expect(v.targets[0].slots).toBe((s.modules[0].data['wires'] as unknown[]).length);
      counts.add(v.targets[0].slots);
    }
    expect([...counts].sort()).toEqual([3, 4, 5, 6]);
  });

  it('leaks nothing: no color name, glyph name, serial, code, digit or module data (60 seeds)', () => {
    for (const seed of SEEDS) {
      const s = createSession(def(seed));
      const json = JSON.stringify(blindOf(s));
      for (const c of COLOR_NAMES) expect(json).not.toContain(c);
      for (const g of GLYPH_NAMES) expect(json).not.toContain(g);
      const serial = s.modules[3].data['serial'] as string;
      expect(serial.length).toBe(6);
      expect(json).not.toContain(serial);
      expect(json).not.toContain(s.modules[3].data['target'] as string);
      for (const label of ['HOLD', 'PRESS', 'ABORT']) expect(json).not.toContain(label);
      for (const key of [
        'serial', 'timerDigit', 'digit', 'target', 'order', 'data', 'wires', 'symbols', 'msLeft', 'rules', 'manual',
      ]) {
        expect(json).not.toContain(`"${key}":`);
      }
    }
  });

  it('shows no time left, even late in the game', () => {
    const s = reduce(createSession(def(5)), { type: 'tick', dtMs: 44_000 });
    const v = blindOf(s);
    expect(v.msLeftBucket).toBeNull();
    expect(JSON.stringify(v)).not.toContain('1000');
  });

  it('follows strikes and status', () => {
    let s = createSession(def(5, { moduleKinds: ['code'], strikes: 2 }));
    s = submit(s);
    let v = blindOf(s);
    expect([v.strikesLeft, v.status]).toEqual([1, 'playing']);
    s = submit(s);
    v = blindOf(s);
    expect([v.strikesLeft, v.status]).toEqual([0, 'lost']);
  });
});

describe('deaf view', () => {
  it('has exactly the specified keys and live msLeft/strikes/status', () => {
    const s = reduce(createSession(def(2)), { type: 'tick', dtMs: 1234 });
    const v = deafOf(s);
    expect(keysOf(v)).toEqual(['modules', 'msLeft', 'role', 'status', 'strikesLeft']);
    expect(v.msLeft).toBe(45_000 - 1234);
    expect(v.strikesLeft).toBe(3);
    expect(v.status).toBe('playing');
    expect(v.modules.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('contains no manual rules (60 seeds)', () => {
    for (const seed of SEEDS) {
      const json = JSON.stringify(projectView(createSession(def(seed)), 'deaf'));
      expect(json).not.toContain('"rules"');
      expect(json).not.toContain('manual.');
      expect(json).not.toContain('"titleKey"');
    }
  });

  it('is REDACTED: no code target and no symbols order anywhere (60 seeds)', () => {
    for (const seed of SEEDS) {
      const s = createSession(def(seed));
      const v = deafOf(s);
      const json = JSON.stringify(v);
      expect(json).not.toContain('"target"');
      expect(json).not.toContain('"order"');
      expect('target' in v.modules[3].data).toBe(false);
      expect('order' in v.modules[2].data).toBe(false);
      // the target digits must not appear as a string value either
      expect(json).not.toContain(`"${s.modules[3].data['target'] as string}"`);
    }
  });

  it('keeps every visible field: serial, glyph list, wire colors, button color/label/digit', () => {
    for (const seed of SEEDS) {
      const s = createSession(def(seed));
      const v = deafOf(s);
      expect(v.modules[0].data['wires']).toEqual(s.modules[0].data['wires']);
      for (const f of ['color', 'label', 'digit', 'held']) {
        expect(v.modules[1].data[f]).toEqual(s.modules[1].data[f]);
      }
      expect(v.modules[1].data['color']).toBeDefined();
      expect(v.modules[2].data['symbols']).toEqual(s.modules[2].data['symbols']);
      expect((v.modules[2].data['symbols'] as string[]).length).toBe(4);
      expect(v.modules[2].data['next']).toBe(0);
      expect(v.modules[3].data['serial']).toEqual(s.modules[3].data['serial']);
      expect(v.modules[3].data['entered']).toBe('');
      for (let i = 0; i < 4; i++) {
        expect(v.modules[i].kind).toBe(s.modules[i].kind);
        expect(v.modules[i].solved).toBe(s.modules[i].solved);
      }
    }
  });

  it('leaves wires and button states as they are; only code and symbols lose a key', () => {
    const s = createSession(def(77));
    const v = deafOf(s);
    expect(v.modules[0]).toEqual(s.modules[0]);
    expect(v.modules[1]).toEqual(s.modules[1]);
    expect(Object.keys(v.modules[2].data).sort()).toEqual(['next', 'symbols']);
    expect(Object.keys(v.modules[3].data).sort()).toEqual(['entered', 'serial']);
  });

  it('never mutates the session, and the view shares no data objects with it', () => {
    const s = createSession(def(9));
    const before = JSON.stringify(s);
    const v = deafOf(s);
    expect(JSON.stringify(s)).toBe(before);
    expect('target' in s.modules[3].data).toBe(true);
    expect('order' in s.modules[2].data).toBe(true);
    expect(v.modules[3]).not.toBe(s.modules[3]);
    expect(v.modules[3].data).not.toBe(s.modules[3].data);
    expect(v.modules[2].data).not.toBe(s.modules[2].data);
    (v.modules[3].data as Record<string, unknown>)['entered'] = 'tampered';
    expect(s.modules[3].data['entered']).toBe('');
  });

  it('stays redacted after play progresses (digits entered, taps made)', () => {
    let s = createSession(def(12));
    s = reduce(s, {
      type: 'act', role: 'blind', moduleId: 'm3', action: { kind: 'code', type: 'digit', payload: { d: 5 } },
    });
    const order = s.modules[2].data['order'] as number[];
    s = reduce(s, {
      type: 'act', role: 'blind', moduleId: 'm2', action: { kind: 'symbols', type: 'tap', payload: { slot: order[0] } },
    });
    const v = deafOf(s);
    const json = JSON.stringify(v);
    expect(json).not.toContain('"target"');
    expect(json).not.toContain('"order"');
    expect(v.modules[3].data['entered']).toBe('5');
    expect(v.modules[2].data['next']).toBe(1);
  });

  it('works for sessions without code/symbols modules', () => {
    const s = createSession(def(3, { moduleKinds: ['wires', 'button'] }));
    expect(deafOf(s).modules).toEqual(s.modules);
  });
});

describe('mute view', () => {
  it('has exactly the specified keys', () => {
    const v = muteOf(createSession(def(4)));
    expect(keysOf(v)).toEqual(['manual', 'role', 'status', 'strikesLeft']);
    expect(v.strikesLeft).toBe(3);
    expect(v.status).toBe('playing');
  });

  it('contains no module data and no msLeft (60 seeds)', () => {
    for (const seed of SEEDS) {
      const s = createSession(def(seed));
      const json = JSON.stringify(muteOf(s));
      for (const key of [
        'data', 'msLeft', 'modules', 'serial', 'wires', 'symbols', 'target', 'order', 'digit', 'timerDigit', 'entered', 'held',
      ]) {
        expect(json).not.toContain(`"${key}":`);
      }
      for (const c of COLOR_NAMES) expect(json).not.toContain(c);
      for (const g of GLYPH_NAMES) expect(json).not.toContain(g);
      expect(json).not.toContain(s.modules[3].data['serial'] as string);
      expect(json).not.toContain(s.modules[3].data['target'] as string);
    }
  });

  it('has one manual entry per distinct kind, in module order, from each module manual()', () => {
    const v = muteOf(createSession(def(4)));
    expect(v.manual).toEqual(ALL_KINDS.map((k) => MODULES[k].manual()));
    expect(v.manual.every((e) => e.rules.length > 0)).toBe(true);
  });

  it('dedupes repeated kinds and keeps first-seen order', () => {
    const s = createSession(def(4, { moduleKinds: ['code', 'wires', 'code', 'wires', 'button'] }));
    const v = muteOf(s);
    expect(v.manual.map((e) => e.kind)).toEqual(['code', 'wires', 'button']);
    expect(v.manual[0]).toEqual(MODULES.code.manual());
  });

  it('only lists kinds present in the session', () => {
    const v = muteOf(createSession(def(4, { moduleKinds: ['symbols'] })));
    expect(v.manual.map((e) => e.kind)).toEqual(['symbols']);
  });

  it('follows strikes and status', () => {
    let s = createSession(def(4, { moduleKinds: ['code'], strikes: 1 }));
    s = submit(s);
    const v = muteOf(s);
    expect([v.strikesLeft, v.status]).toEqual([0, 'lost']);
  });
});
