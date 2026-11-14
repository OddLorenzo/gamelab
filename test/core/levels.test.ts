import { describe, it, expect, vi, afterEach } from 'vitest';
import { STAGE_SIZE, SETTINGS, buildLevel, isSolvable } from '../../src/core/levels';
import { MODULES } from '../../src/core/bomb';
import type { LevelDef } from '../../src/core/bomb';
import { correctIndex } from '../../src/core/modules/wires';
import type { Wire } from '../../src/core/modules/wires';
import type { ModuleKind } from '../../src/core/types';

const KINDS: ModuleKind[] = ['wires', 'button', 'symbols', 'code'];
const ids = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('constants', () => {
  it('has stage size 10 and one distinct i18n setting key per stage', () => {
    expect(STAGE_SIZE).toBe(10);
    expect(SETTINGS).toHaveLength(10);
    expect(new Set(SETTINGS).size).toBe(10);
    for (const key of SETTINGS) expect(key).toMatch(/^setting\.[a-z0-9]+$/i);
  });

  it('assigns each level the setting of its stage', () => {
    for (const id of ids(1, 100)) {
      const def = buildLevel(id);
      expect(def.setting).toBe(SETTINGS[def.stage - 1]);
    }
  });
});

describe('buildLevel: exact values', () => {
  it('level 1 is the single-wire tutorial', () => {
    expect(buildLevel(1)).toEqual({
      id: 1,
      stage: 1,
      seed: 7932,
      moduleKinds: ['wires'],
      difficulty: 1,
      timeMs: 180_000,
      strikes: 3,
      setting: SETTINGS[0],
    });
  });

  it('level 2 raises only difficulty', () => {
    expect(buildLevel(2)).toEqual({
      id: 2,
      stage: 1,
      seed: 15851,
      moduleKinds: ['wires'],
      difficulty: 2,
      timeMs: 175_000,
      strikes: 3,
      setting: SETTINGS[0],
    });
  });

  it('level 3 adds the button', () => {
    const def = buildLevel(3);
    expect(def.moduleKinds).toEqual(['wires', 'button']);
    expect(def.difficulty).toBe(2);
    expect(def.timeMs).toBe(170_000);
  });

  it('level 10 uses all four kinds', () => {
    expect(buildLevel(10)).toEqual({
      id: 10,
      stage: 1,
      seed: 79203,
      moduleKinds: ['wires', 'button', 'symbols', 'code'],
      difficulty: 4,
      timeMs: 135_000,
      strikes: 3,
      setting: SETTINGS[0],
    });
  });

  it('level 11 opens stage 2 at the difficulty cap', () => {
    expect(buildLevel(11)).toEqual({
      id: 11,
      stage: 2,
      seed: 87122,
      moduleKinds: ['wires', 'button', 'symbols', 'code'],
      difficulty: 5,
      timeMs: 134_000,
      strikes: 3,
      setting: SETTINGS[1],
    });
  });

  it('level 100 is the hardest: capped time, one strike', () => {
    expect(buildLevel(100)).toEqual({
      id: 100,
      stage: 10,
      seed: 791913,
      moduleKinds: ['wires', 'button', 'symbols', 'code'],
      difficulty: 5,
      timeMs: 60_000,
      strikes: 1,
      setting: SETTINGS[9],
    });
  });

  it('strikes drop by stage: 3 (1-3), 2 (4-6), 1 (7-10)', () => {
    const lastOfStage = (stage: number) => buildLevel(stage * STAGE_SIZE).strikes;
    expect(ids(1, 10).map(lastOfStage)).toEqual([3, 3, 3, 2, 2, 2, 1, 1, 1, 1]);
    expect(buildLevel(30).strikes).toBe(3);
    expect(buildLevel(31).strikes).toBe(2);
    expect(buildLevel(60).strikes).toBe(2);
    expect(buildLevel(61).strikes).toBe(1);
  });

  it('time shrinks by 1 s per level after level 10 and is floored at 60 s', () => {
    expect(buildLevel(50).timeMs).toBe(95_000);
    expect(buildLevel(84).timeMs).toBe(61_000);
    expect(buildLevel(85).timeMs).toBe(60_000);
    expect(buildLevel(86).timeMs).toBe(60_000);
  });
});

describe('buildLevel: seed, stage, determinism', () => {
  it('uses seed id * 7919 + 13 for every level', () => {
    for (const id of ids(1, 100)) expect(buildLevel(id).seed).toBe(id * 7919 + 13);
  });

  it('computes stage with ceil(id / 10)', () => {
    expect(buildLevel(1).stage).toBe(1);
    expect(buildLevel(10).stage).toBe(1);
    expect(buildLevel(11).stage).toBe(2);
    expect(buildLevel(37).stage).toBe(4);
    expect(buildLevel(40).stage).toBe(4);
    expect(buildLevel(100).stage).toBe(10);
  });

  it('is deterministic and returns fresh objects', () => {
    const a = buildLevel(5);
    const b = buildLevel(5);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.moduleKinds).not.toBe(b.moduleKinds);
    a.moduleKinds.push('code');
    expect(buildLevel(5).moduleKinds).not.toContain('code');
  });

  it.each([0, 101, 1.5, NaN, -1, Infinity, 'x' as unknown as number, undefined as unknown as number])(
    'throws RangeError for %s',
    (bad) => {
      expect(() => buildLevel(bad)).toThrow(RangeError);
    },
  );
});

describe('buildLevel: difficulty curve', () => {
  it('stage 1 never goes down and every level 2..10 grows by at most one step on one axis', () => {
    for (const id of ids(2, 10)) {
      const prev = buildLevel(id - 1);
      const cur = buildLevel(id);
      expect(cur.moduleKinds.length).toBeGreaterThanOrEqual(prev.moduleKinds.length);
      expect(cur.difficulty).toBeGreaterThanOrEqual(prev.difficulty);
      const kindsAdded = cur.moduleKinds.length - prev.moduleKinds.length;
      const diffAdded = cur.difficulty - prev.difficulty;
      expect(kindsAdded + diffAdded).toBeLessThanOrEqual(1);
      expect(cur.timeMs).toBeLessThan(prev.timeMs);
      expect(cur.strikes).toBe(prev.strikes);
      // kinds are only ever added, never swapped out
      expect(cur.moduleKinds.slice(0, prev.moduleKinds.length)).toEqual(prev.moduleKinds);
    }
  });

  it('introduces kinds in the order wires, button, symbols, code', () => {
    const counts = ids(1, 10).map((id) => buildLevel(id).moduleKinds.length);
    expect(counts).toEqual([1, 1, 2, 2, 2, 3, 3, 3, 4, 4]);
    expect(buildLevel(9).moduleKinds).toEqual(KINDS);
  });

  it('stage 1 difficulty values are exact', () => {
    expect(ids(1, 10).map((id) => buildLevel(id).difficulty)).toEqual([1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  });

  it('no level ever loses ground across all 100 levels', () => {
    for (const id of ids(2, 100)) {
      const prev = buildLevel(id - 1);
      const cur = buildLevel(id);
      expect(cur.moduleKinds.length).toBeGreaterThanOrEqual(prev.moduleKinds.length);
      expect(cur.difficulty).toBeGreaterThanOrEqual(prev.difficulty);
      expect(cur.timeMs).toBeLessThanOrEqual(prev.timeMs);
      expect(cur.strikes).toBeLessThanOrEqual(prev.strikes);
    }
  });

  it('keeps every field in range for all 100 levels', () => {
    for (const id of ids(1, 100)) {
      const def = buildLevel(id);
      expect(def.id).toBe(id);
      expect(Number.isInteger(def.seed)).toBe(true);
      expect(Number.isInteger(def.difficulty)).toBe(true);
      expect(Number.isInteger(def.timeMs)).toBe(true);
      expect(Number.isInteger(def.strikes)).toBe(true);
      expect(def.difficulty).toBeGreaterThanOrEqual(1);
      expect(def.difficulty).toBeLessThanOrEqual(5);
      expect(def.timeMs).toBeGreaterThanOrEqual(60_000);
      expect(def.timeMs).toBeLessThanOrEqual(180_000);
      expect(def.strikes).toBeGreaterThanOrEqual(1);
      expect(def.strikes).toBeLessThanOrEqual(3);
      expect(def.moduleKinds.length).toBeGreaterThanOrEqual(1);
      expect(def.moduleKinds.length).toBeLessThanOrEqual(4);
      expect(new Set(def.moduleKinds).size).toBe(def.moduleKinds.length);
    }
  });

  it('levels 11..100 always use all four kinds', () => {
    for (const id of ids(11, 100)) expect(buildLevel(id).moduleKinds).toEqual(KINDS);
  });
});

describe('isSolvable', () => {
  const base = (): LevelDef => buildLevel(10);

  it('is true for levels 1..10', () => {
    for (const id of ids(1, 10)) expect(isSolvable(buildLevel(id)), `level ${id}`).toBe(true);
  });

  it('is true for all 100 levels', () => {
    for (const id of ids(1, 100)) expect(isSolvable(buildLevel(id)), `level ${id}`).toBe(true);
  });

  it('does not mutate the def', () => {
    const def = buildLevel(10);
    const copy = structuredClone(def);
    isSolvable(def);
    expect(def).toEqual(copy);
  });

  it('is false for an empty module list (nothing to solve is not a win)', () => {
    expect(isSolvable({ ...base(), moduleKinds: [] })).toBe(false);
  });

  it('is false for an unknown module kind', () => {
    expect(isSolvable({ ...base(), moduleKinds: ['bogus' as unknown as ModuleKind] })).toBe(false);
    expect(
      isSolvable({ ...base(), moduleKinds: [...base().moduleKinds, 'nope' as unknown as ModuleKind] }),
    ).toBe(false);
  });

  it('is false when there is no time', () => {
    expect(isSolvable({ ...base(), timeMs: 0 })).toBe(false);
  });

  it('is false when there are no strikes to spare', () => {
    expect(isSolvable({ ...base(), strikes: 0 })).toBe(false);
  });

  it('is true for hand-built defs that are valid but not generated', () => {
    expect(isSolvable({ ...base(), seed: 1 })).toBe(true);
    expect(isSolvable({ ...base(), moduleKinds: ['wires', 'wires'] })).toBe(true);
  });

  describe('with a sabotaged solve()', () => {
    afterEach(() => vi.restoreAllMocks());

    const realSolve = MODULES.wires.solve;

    it('is false when solve() plays nothing, so the module stays unsolved', () => {
      vi.spyOn(MODULES.wires, 'solve').mockReturnValue([]);
      expect(isSolvable(buildLevel(1))).toBe(false);
    });

    it('is false when a win costs a strike, even though the session is won', () => {
      vi.spyOn(MODULES.wires, 'solve').mockImplementation((state) => {
        const wires = state.data['wires'] as Wire[];
        const wrong = wires.findIndex((_, i) => i !== correctIndex(wires));
        return [{ kind: 'wires', type: 'cut', payload: { index: wrong } }, ...realSolve(state)];
      });
      expect(isSolvable(buildLevel(1))).toBe(false);
    });

    it('is true again once the real solve() is restored', () => {
      vi.restoreAllMocks();
      expect(isSolvable(buildLevel(1))).toBe(true);
    });
  });
});
