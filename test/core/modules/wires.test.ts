import { describe, it, expect } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { wiresModule, correctIndex, type Wire, type WireColor } from '../../../src/core/modules/wires';
import type { ModuleState } from '../../../src/core/types';

const make = (colors: WireColor[]): Wire[] => colors.map((color) => ({ color, cut: false }));

const stateOf = (colors: WireColor[]): ModuleState => ({
  kind: 'wires',
  id: 'w1',
  solved: false,
  data: { wires: make(colors) },
});

const wiresOf = (s: ModuleState): Wire[] => s.data['wires'] as Wire[];

const cut = (index: number) => ({ kind: 'wires' as const, type: 'cut', payload: { index } });

describe('wires module: init', () => {
  it('difficulty maps to wire count 3..6 and clamps', () => {
    const counts = [1, 2, 3, 4, 5].map(
      (d) => wiresOf(wiresModule.init('w', createRng(7), d)).length,
    );
    expect(counts).toEqual([3, 4, 5, 5, 6]);
    expect(wiresOf(wiresModule.init('w', createRng(7), 0)).length).toBe(3);
    expect(wiresOf(wiresModule.init('w', createRng(7), 99)).length).toBe(6);
    expect(wiresOf(wiresModule.init('w', createRng(7), NaN)).length).toBe(3);
    expect(wiresOf(wiresModule.init('w', createRng(7), Infinity)).length).toBe(6);
    expect(wiresOf(wiresModule.init('w', createRng(7), -Infinity)).length).toBe(3);
  });

  it('seed 7 difficulty 1 gives 3 wires, difficulty 5 gives 6 wires', () => {
    expect(wiresOf(wiresModule.init('w', createRng(7), 1))).toHaveLength(3);
    expect(wiresOf(wiresModule.init('w', createRng(7), 5))).toHaveLength(6);
  });

  it('is deterministic for a given seed and differs across seeds', () => {
    const a = wiresModule.init('w', createRng(7), 5);
    const b = wiresModule.init('w', createRng(7), 5);
    expect(a).toEqual(b);
    const variants = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      variants.add(JSON.stringify(wiresModule.init('w', createRng(seed), 5).data));
    }
    expect(variants.size).toBeGreaterThan(5);
  });

  it('starts unsolved, nothing cut, kind and id set', () => {
    const s = wiresModule.init('abc', createRng(3), 3);
    expect(s.kind).toBe('wires');
    expect(s.id).toBe('abc');
    expect(s.solved).toBe(false);
    expect(wiresOf(s).every((w) => w.cut === false)).toBe(true);
  });
});

const ci = (colors: WireColor[]): number => correctIndex(make(colors));

const COLORS: WireColor[] = ['red', 'blue', 'yellow', 'green', 'white'];
const layouts = (n: number): WireColor[][] => {
  let acc: WireColor[][] = [[]];
  for (let i = 0; i < n; i++) acc = acc.flatMap((p) => COLORS.map((c) => [...p, c]));
  return acc;
};

// Each case names the rule that must win and, in the comment, what the rule just after it
// (or the fallback) would answer instead, so swapping two neighbouring rules fails a case.
describe('correctIndex rules (first match wins, wire 0 is the top)', () => {
  it('3 wires, line 1: top and bottom share a color: cut the middle wire', () => {
    expect(ci(['red', 'blue', 'red'])).toBe(1);
    expect(ci(['green', 'green', 'green'])).toBe(1); // line 2 has no lone color here, line 3 would say 0
  });
  it('3 wires, line 2: two neighbours share a color: cut the wire whose color is there once', () => {
    expect(ci(['red', 'red', 'blue'])).toBe(2); // line 3 would say 0 (red first in the list)
    expect(ci(['white', 'blue', 'blue'])).toBe(0); // line 3 would say 1
  });
  it('3 wires, line 3: all different: cut the wire whose color comes first in red, blue, yellow, green, white', () => {
    expect(ci(['white', 'yellow', 'blue'])).toBe(2);
    expect(ci(['green', 'red', 'white'])).toBe(1);
    expect(ci(['yellow', 'green', 'white'])).toBe(0);
  });

  it('4 wires, line 1: second and third share a color: cut the bottom wire', () => {
    expect(ci(['red', 'blue', 'blue', 'red'])).toBe(3); // line 2 would say 2
    expect(ci(['green', 'white', 'white', 'yellow'])).toBe(3);
  });
  it('4 wires, line 2: top and bottom share a color: cut the third wire', () => {
    expect(ci(['green', 'red', 'white', 'green'])).toBe(2); // line 3 would say 1
  });
  it('4 wires, line 3: 3 or more colors: cut the wire nearest the top whose color is there once', () => {
    expect(ci(['red', 'yellow', 'green', 'green'])).toBe(0); // line 4 would say 1
    expect(ci(['blue', 'red', 'blue', 'green'])).toBe(1);
    expect(ci(['white', 'green', 'yellow', 'red'])).toBe(0);
  });
  it('4 wires, line 4: otherwise the first wire from the top whose color differs from the top wire', () => {
    expect(ci(['red', 'red', 'blue', 'blue'])).toBe(2);
    expect(ci(['blue', 'green', 'blue', 'green'])).toBe(1);
    expect(ci(['white', 'white', 'yellow', 'yellow'])).toBe(2);
  });

  it('5 wires, line 1: second and fourth share a color: cut the middle wire', () => {
    expect(ci(['red', 'blue', 'red', 'blue', 'yellow'])).toBe(2); // line 2 would say 4
  });
  it('5 wires, line 2: 3 or more colors: cut the wire nearest the bottom whose color is there once', () => {
    expect(ci(['red', 'red', 'blue', 'yellow', 'red'])).toBe(3); // line 3 would say 0
    expect(ci(['green', 'white', 'blue', 'red', 'yellow'])).toBe(4);
  });
  it('5 wires, line 3: top and bottom share a color: cut the top wire', () => {
    expect(ci(['red', 'red', 'red', 'blue', 'red'])).toBe(0); // line 4 would say 3
  });
  it('5 wires, line 4: otherwise the first wire from the top whose color differs from the top wire', () => {
    expect(ci(['red', 'red', 'red', 'blue', 'blue'])).toBe(3);
    expect(ci(['white', 'green', 'green', 'white', 'green'])).toBe(1);
  });

  it('6 wires, line 1: no neighbours share a color: cut the lowest wire of a most common color', () => {
    expect(ci(['red', 'blue', 'red', 'blue', 'red', 'yellow'])).toBe(4); // red is there 3 times
    expect(ci(['red', 'blue', 'green', 'yellow', 'white', 'red'])).toBe(5);
    expect(ci(['blue', 'red', 'blue', 'red', 'green', 'white'])).toBe(3); // blue and red tie: the lowest of both
  });
  it('6 wires, line 2: odd number of colors: cut the lower wire of the highest same-color neighbour pair', () => {
    expect(ci(['red', 'red', 'red', 'red', 'blue', 'yellow'])).toBe(1); // line 3 would say 0
    expect(ci(['blue', 'green', 'white', 'white', 'green', 'green'])).toBe(3);
  });
  it('6 wires, line 3: a color is there once: cut the mirror of the lowest such wire', () => {
    expect(ci(['red', 'red', 'red', 'red', 'red', 'blue'])).toBe(0); // line 4 would say 2
    expect(ci(['red', 'red', 'green', 'blue', 'white', 'red'])).toBe(1); // lowest lone color is wire 4
  });
  it('6 wires, line 4: otherwise cut the third wire', () => {
    expect(ci(['red', 'red', 'blue', 'blue', 'blue', 'red'])).toBe(2);
    expect(ci(['green', 'green', 'white', 'white', 'green', 'green'])).toBe(2);
  });

  it('ignores the cut flag', () => {
    const w = make(['red', 'red', 'blue']);
    w[2] = { color: 'blue', cut: true };
    expect(correctIndex(w)).toBe(2);
  });

  it.each([3, 4, 5, 6])('%d wires: every layout gets one valid index, and no index is the answer for more than 45 percent of layouts', (n) => {
    const tally = new Array<number>(n).fill(0);
    for (const layout of layouts(n)) {
      const i = ci(layout);
      expect(Number.isInteger(i) && i >= 0 && i < n, layout.join(',')).toBe(true);
      tally[i]++;
    }
    for (const t of tally) expect(t / 5 ** n).toBeLessThanOrEqual(0.45);
  });
});

describe('wires module: act and solve', () => {
  it('cutting the correct wire solves; every other wire strikes and stays unsolved', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (let difficulty = 1; difficulty <= 5; difficulty++) {
        const init = wiresModule.init('w', createRng(seed), difficulty);
        const good = correctIndex(wiresOf(init));
        wiresOf(init).forEach((_, i) => {
          const r = wiresModule.act(init, cut(i));
          if (i === good) {
            expect(r.outcome).toBe('solved');
            expect(r.state.solved).toBe(true);
          } else {
            expect(r.outcome).toBe('strike');
            expect(r.state.solved).toBe(false);
          }
        });
      }
    }
  });

  it('a strike marks that wire cut but never mutates the input state', () => {
    const init = stateOf(['yellow', 'blue', 'green']); // correct = 1 (blue first in the list)
    const snapshot = JSON.stringify(init);
    const r = wiresModule.act(init, cut(0));
    expect(r.outcome).toBe('strike');
    expect(wiresOf(r.state)[0].cut).toBe(true);
    expect(wiresOf(r.state).slice(1)).toEqual(wiresOf(init).slice(1));
    expect(wiresOf(r.state).map((w) => w.color)).toEqual(['yellow', 'blue', 'green']);
    expect(JSON.stringify(init)).toBe(snapshot);
  });

  it('solve returns exactly one cut action with the correct index, and applying it solves', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (let difficulty = 1; difficulty <= 5; difficulty++) {
        const init = wiresModule.init('w', createRng(seed), difficulty);
        const actions = wiresModule.solve(init);
        expect(actions).toHaveLength(1);
        expect(actions[0]).toEqual(cut(correctIndex(wiresOf(init))));
        const r = wiresModule.act(init, actions[0]);
        expect(r.outcome).toBe('solved');
        expect(r.state.solved).toBe(true);
      }
    }
  });

  it('act on an already solved module returns progress with unchanged state', () => {
    const init = wiresModule.init('w', createRng(7), 1);
    const solved = wiresModule.act(init, wiresModule.solve(init)[0]).state;
    for (let i = 0; i < 3; i++) {
      const r = wiresModule.act(solved, cut(i));
      expect(r.outcome).toBe('progress');
      expect(r.state).toEqual(solved);
    }
  });

  it('cutting an already cut wire, an out-of-range index, or a bad action is progress and changes nothing', () => {
    const init = stateOf(['yellow', 'blue', 'green']);
    const struck = wiresModule.act(init, cut(0)).state;
    const again = wiresModule.act(struck, cut(0));
    expect(again.outcome).toBe('progress');
    expect(again.state).toEqual(struck);
    for (const bad of [cut(-1), cut(3), cut(1.5), { kind: 'wires' as const, type: 'cut' }, { kind: 'wires' as const, type: 'zap', payload: { index: 0 } }]) {
      const r = wiresModule.act(init, bad);
      expect(r.outcome).toBe('progress');
      expect(r.state).toEqual(init);
    }
  });
});

describe('wires module: manual', () => {
  it('has one i18n key per wire count 3..6 in order, no display text', () => {
    const m = wiresModule.manual();
    expect(m.kind).toBe('wires');
    expect(m.titleKey).toBe('manual.wires.title');
    expect(m.rules).toEqual([3, 4, 5, 6].map((n) => `manual.wires.rule.${n}`));
  });
});
