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

describe('correctIndex rules', () => {
  it('3 wires: no red cuts the second', () => {
    expect(correctIndex(make(['blue', 'yellow', 'green']))).toBe(1);
  });
  it('3 wires: has red, last white cuts the last', () => {
    expect(correctIndex(make(['red', 'green', 'white']))).toBe(2);
  });
  it('3 wires: has red, last not white, two blues cuts the last blue', () => {
    expect(correctIndex(make(['blue', 'blue', 'red']))).toBe(1);
    expect(correctIndex(make(['blue', 'red', 'blue']))).toBe(2);
  });
  it('3 wires: otherwise cuts the last', () => {
    expect(correctIndex(make(['red', 'yellow', 'green']))).toBe(2);
  });

  it('4 wires: more than one red cuts the last red', () => {
    expect(correctIndex(make(['red', 'red', 'green', 'yellow']))).toBe(1);
  });
  it('4 wires: last yellow with no red cuts the first', () => {
    expect(correctIndex(make(['green', 'white', 'blue', 'yellow']))).toBe(0);
  });
  it('4 wires: exactly one blue cuts the first', () => {
    expect(correctIndex(make(['white', 'blue', 'green', 'red']))).toBe(0);
  });
  it('4 wires: more than one yellow cuts the last', () => {
    expect(correctIndex(make(['yellow', 'red', 'white', 'yellow']))).toBe(3);
  });
  it('4 wires: otherwise cuts the second', () => {
    expect(correctIndex(make(['green', 'green', 'white', 'red']))).toBe(1);
  });

  it('5 wires: last green cuts the fourth', () => {
    expect(correctIndex(make(['red', 'blue', 'white', 'yellow', 'green']))).toBe(3);
  });
  it('5 wires: one red and more than one yellow cuts the first', () => {
    expect(correctIndex(make(['white', 'red', 'yellow', 'yellow', 'blue']))).toBe(0);
  });
  it('5 wires: no green cuts the second', () => {
    expect(correctIndex(make(['white', 'red', 'red', 'blue', 'blue']))).toBe(1);
  });
  it('5 wires: otherwise cuts the first', () => {
    expect(correctIndex(make(['green', 'red', 'red', 'blue', 'white']))).toBe(0);
  });

  it('6 wires: no yellow cuts the third', () => {
    expect(correctIndex(make(['red', 'blue', 'green', 'white', 'white', 'red']))).toBe(2);
  });
  it('6 wires: one yellow and more than one white cuts the fourth', () => {
    expect(correctIndex(make(['yellow', 'blue', 'green', 'white', 'white', 'red']))).toBe(3);
  });
  it('6 wires: no white cuts the last', () => {
    expect(correctIndex(make(['yellow', 'yellow', 'green', 'blue', 'red', 'red']))).toBe(5);
  });
  it('6 wires: otherwise cuts the fourth', () => {
    expect(correctIndex(make(['yellow', 'yellow', 'white', 'blue', 'red', 'red']))).toBe(3);
  });

  it('ignores the cut flag', () => {
    const w = make(['blue', 'yellow', 'green']);
    w[1] = { color: 'yellow', cut: true };
    expect(correctIndex(w)).toBe(1);
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
    const init = stateOf(['blue', 'yellow', 'green']); // correct = 1
    const snapshot = JSON.stringify(init);
    const r = wiresModule.act(init, cut(0));
    expect(r.outcome).toBe('strike');
    expect(wiresOf(r.state)[0].cut).toBe(true);
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
    const init = stateOf(['blue', 'yellow', 'green']);
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
