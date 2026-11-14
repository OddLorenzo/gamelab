import { describe, it, expect } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { symbolsModule, SYMBOL_COLUMNS, tapOrder } from '../../../src/core/modules/symbols';
import type { ActResult, ModuleAction, ModuleState } from '../../../src/core/types';

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const symbolsOf = (s: ModuleState): string[] => s.data['symbols'] as string[];
const orderOf = (s: ModuleState): number[] => s.data['order'] as number[];
const nextOf = (s: ModuleState): number => s.data['next'] as number;

const tap = (slot: unknown): ModuleAction => ({
  kind: 'symbols',
  type: 'tap',
  payload: { slot },
});

const stateOf = (symbols: string[], order: number[], next = 0): ModuleState => ({
  kind: 'symbols',
  id: 's1',
  solved: false,
  data: { symbols, order, next },
});

const freshState = (seed: number): ModuleState => symbolsModule.init('s1', createRng(seed), 1);

// Reference written independently of the module: columns holding all the given glyphs.
const columnsHolding = (glyphs: string[]): number[] =>
  SYMBOL_COLUMNS.flatMap((col, i) => (glyphs.every((g) => col.includes(g)) ? [i] : []));

// Reference tap order: slots sorted by the glyph's position in the one matching column.
const referenceOrder = (glyphs: string[]): number[] => {
  const [c] = columnsHolding(glyphs);
  return [0, 1, 2, 3].sort(
    (a, b) => SYMBOL_COLUMNS[c].indexOf(glyphs[a]) - SYMBOL_COLUMNS[c].indexOf(glyphs[b]),
  );
};

describe('SYMBOL_COLUMNS', () => {
  it('has 6 columns of 7 distinct glyphs', () => {
    expect(SYMBOL_COLUMNS).toHaveLength(6);
    for (const col of SYMBOL_COLUMNS) {
      expect(col).toHaveLength(7);
      expect(new Set(col).size).toBe(7);
    }
  });

  it('draws on exactly 20 distinct glyph names', () => {
    expect(new Set(SYMBOL_COLUMNS.flat()).size).toBe(20);
  });

  it('lets any two columns share at most 3 glyphs, so any 4 glyphs fit one column at most', () => {
    for (let a = 0; a < SYMBOL_COLUMNS.length; a++) {
      for (let b = a + 1; b < SYMBOL_COLUMNS.length; b++) {
        const shared = SYMBOL_COLUMNS[a].filter((g) => SYMBOL_COLUMNS[b].includes(g));
        expect(shared.length).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('symbolsModule.init', () => {
  it('builds a fresh unsolved state', () => {
    const s = freshState(1);
    expect(s.kind).toBe('symbols');
    expect(s.id).toBe('s1');
    expect(s.solved).toBe(false);
    expect(nextOf(s)).toBe(0);
  });

  it('shows 4 distinct glyphs that exactly ONE manual column contains, for every seed', () => {
    for (const seed of SEEDS) {
      const symbols = symbolsOf(freshState(seed));
      expect(symbols).toHaveLength(4);
      expect(new Set(symbols).size).toBe(4);
      expect(columnsHolding(symbols)).toHaveLength(1);
    }
  });

  it('stores an order that really is the column order, top to bottom', () => {
    for (const seed of SEEDS) {
      const s = freshState(seed);
      const order = orderOf(s);
      expect([...order].sort()).toEqual([0, 1, 2, 3]);
      expect(order).toEqual(referenceOrder(symbolsOf(s)));
    }
  });

  it('agrees with the pure tapOrder rule helper, which rejects glyph sets no column holds', () => {
    for (const seed of SEEDS) {
      const s = freshState(seed);
      expect(tapOrder(symbolsOf(s))).toEqual(orderOf(s));
    }
    expect(tapOrder(['moon', 'key', 'eye', 'crown'])).toBeNull();
  });

  it('is deterministic per seed', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      expect(freshState(seed)).toEqual(freshState(seed));
    }
  });

  it('varies: uses every column and shuffles display order away from column order', () => {
    const columnsUsed = new Set<number>();
    let shuffled = 0;
    let identity = 0;
    for (const seed of SEEDS) {
      const s = freshState(seed);
      columnsUsed.add(columnsHolding(symbolsOf(s))[0]);
      if (orderOf(s).join() === '0,1,2,3') identity++;
      else shuffled++;
    }
    expect(columnsUsed.size).toBe(SYMBOL_COLUMNS.length);
    expect(shuffled).toBeGreaterThan(identity);
  });
});

describe('symbolsModule.act', () => {
  it('only the right slot progresses on the first tap; the other three strike', () => {
    const state = stateOf(['a', 'b', 'c', 'd'], [2, 0, 3, 1]);
    for (let slot = 0; slot < 4; slot++) {
      const r = symbolsModule.act(state, tap(slot));
      if (slot === 2) {
        expect(r.outcome).toBe('progress');
        expect(nextOf(r.state)).toBe(1);
      } else {
        expect(r.outcome).toBe('strike');
        expect(nextOf(r.state)).toBe(0);
      }
      expect(r.state.solved).toBe(false);
    }
  });

  it('at every step only order[next] progresses, every other slot strikes and resets', () => {
    const order = [1, 3, 0, 2];
    for (let next = 0; next < 4; next++) {
      const state = stateOf(['a', 'b', 'c', 'd'], order, next);
      for (let slot = 0; slot < 4; slot++) {
        const r = symbolsModule.act(state, tap(slot));
        if (slot === order[next]) {
          expect(r.outcome).toBe(next === 3 ? 'solved' : 'progress');
          expect(nextOf(r.state)).toBe(next + 1);
        } else {
          expect(r.outcome).toBe('strike');
          expect(nextOf(r.state)).toBe(0);
          expect(r.state.solved).toBe(false);
        }
      }
    }
  });

  it('four correct taps in order: progress x3 then solved on the last', () => {
    let state = freshState(7);
    const outcomes: string[] = [];
    for (const slot of orderOf(state)) {
      const r: ActResult = symbolsModule.act(state, tap(slot));
      outcomes.push(r.outcome);
      state = r.state;
    }
    expect(outcomes).toEqual(['progress', 'progress', 'progress', 'solved']);
    expect(state.solved).toBe(true);
    expect(nextOf(state)).toBe(4);
  });

  it('a wrong tap midway strikes, resets progress to 0, and the sequence must restart', () => {
    let state = stateOf(['a', 'b', 'c', 'd'], [0, 1, 2, 3]);
    state = symbolsModule.act(state, tap(0)).state;
    state = symbolsModule.act(state, tap(1)).state;
    expect(nextOf(state)).toBe(2);
    const wrong = symbolsModule.act(state, tap(3));
    expect(wrong.outcome).toBe('strike');
    expect(nextOf(wrong.state)).toBe(0);
    // Slot 2 was right before the strike; after it slot 0 is needed again.
    expect(symbolsModule.act(wrong.state, tap(2)).outcome).toBe('strike');
    expect(symbolsModule.act(wrong.state, tap(0)).outcome).toBe('progress');
  });

  it('re-tapping an already-correct slot counts as wrong', () => {
    const state = stateOf(['a', 'b', 'c', 'd'], [0, 1, 2, 3], 1);
    const r = symbolsModule.act(state, tap(0));
    expect(r.outcome).toBe('strike');
    expect(nextOf(r.state)).toBe(0);
  });

  it('does not mutate the incoming state', () => {
    const state = stateOf(['a', 'b', 'c', 'd'], [0, 1, 2, 3], 1);
    const snapshot = JSON.parse(JSON.stringify(state));
    symbolsModule.act(state, tap(1));
    symbolsModule.act(state, tap(3));
    expect(state).toEqual(snapshot);
  });

  it('keeps symbols and order untouched across progress, strike and solve', () => {
    const state = stateOf(['a', 'b', 'c', 'd'], [3, 1, 0, 2], 3);
    for (const slot of [0, 1, 2, 3]) {
      const r = symbolsModule.act(state, tap(slot));
      expect(symbolsOf(r.state)).toEqual(['a', 'b', 'c', 'd']);
      expect(orderOf(r.state)).toEqual([3, 1, 0, 2]);
    }
  });

  it('ignores bad input: same state, outcome progress, no strike', () => {
    const state = stateOf(['a', 'b', 'c', 'd'], [0, 1, 2, 3], 1);
    const bad: ModuleAction[] = [
      tap(4),
      tap(-1),
      tap(1.5),
      tap('1'),
      tap(undefined),
      tap(NaN),
      { kind: 'symbols', type: 'tap' },
      { kind: 'symbols', type: 'tap', payload: {} },
      { kind: 'symbols', type: 'press', payload: { slot: 1 } },
      { kind: 'wires', type: 'tap', payload: { slot: 1 } },
    ];
    for (const action of bad) {
      const r = symbolsModule.act(state, action);
      expect(r.state).toBe(state);
      expect(r.outcome).toBe('progress');
    }
  });

  it('ignores taps on an already solved module', () => {
    const state: ModuleState = { ...stateOf(['a', 'b', 'c', 'd'], [0, 1, 2, 3], 4), solved: true };
    for (let slot = 0; slot < 4; slot++) {
      const r = symbolsModule.act(state, tap(slot));
      expect(r.state).toBe(state);
      expect(r.outcome).toBe('progress');
    }
  });
});

describe('symbolsModule.solve', () => {
  it('returns four tap actions in the reference column order, for every seed', () => {
    for (const seed of SEEDS) {
      const s = freshState(seed);
      const actions = symbolsModule.solve(s);
      expect(actions).toHaveLength(4);
      expect(actions.every((a) => a.kind === 'symbols' && a.type === 'tap')).toBe(true);
      expect(actions.map((a) => a.payload?.['slot'])).toEqual(referenceOrder(symbolsOf(s)));
    }
  });

  it('solving sequence solves the module, with progress before the last tap', () => {
    for (const seed of SEEDS) {
      let state = freshState(seed);
      const outcomes: string[] = [];
      for (const action of symbolsModule.solve(state)) {
        const r = symbolsModule.act(state, action);
        outcomes.push(r.outcome);
        state = r.state;
      }
      expect(outcomes).toEqual(['progress', 'progress', 'progress', 'solved']);
      expect(state.solved).toBe(true);
    }
  });
});

describe('symbolsModule.manual', () => {
  it('uses i18n keys only and lists every rule key', () => {
    const m = symbolsModule.manual();
    expect(m.kind).toBe('symbols');
    expect(m.titleKey).toBe('manual.symbols.title');
    expect(m.rules).toEqual([1, 2, 3, 4].map((n) => `manual.symbols.rule.${n}`));
  });
});
