import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/core/bomb';
import { buildLevel } from '../../src/core/levels';
import type { ModuleKind } from '../../src/core/types';
import { projectView } from '../../src/core/views';
import type { BlindView, DeafView } from '../../src/core/views';
import { hitTest } from '../../src/ui/input';
import { computeLayout, HUD_H, minSlotSizePx, slotCount, specsFromBlind, specsFromDeaf } from '../../src/ui/layout';
import type { ModuleSpec, Rect } from '../../src/ui/layout';

const EPS = 1e-9;
const SIZES = [
  { w: 375, h: 667 },
  { w: 1280, h: 720 },
];
const ASPECTS = [375 / 667, 1, 1280 / 720];

const spec = (kind: ModuleKind, slots: number, id = `m-${kind}-${slots}`): ModuleSpec => ({ moduleId: id, kind, slots });
const WIRES = (n: number, id?: string): ModuleSpec => spec('wires', n, id);
const KEYS = (id?: string): ModuleSpec => spec('code', 12, id);

const inside = (r: Rect, outer: Rect): boolean =>
  r.x >= outer.x - EPS && r.y >= outer.y - EPS && r.x + r.w <= outer.x + outer.w + EPS && r.y + r.h <= outer.y + outer.h + EPS;
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

describe('slotCount', () => {
  it('gives the slots of each kind', () => {
    expect(slotCount('button')).toBe(1);
    expect(slotCount('symbols')).toBe(4);
    expect(slotCount('code')).toBe(12);
  });

  it('wires: the wire count from a number, an array or a module data object', () => {
    expect(slotCount('wires', 5)).toBe(5);
    expect(slotCount('wires', [1, 2, 3])).toBe(3);
    expect(slotCount('wires', { wires: [{}, {}, {}, {}] })).toBe(4);
  });
});

describe('wires geometry', () => {
  it.each([3, 4, 5, 6])('%i wires: wire 0 is the TOP bar, strictly increasing y, same x range', (n) => {
    for (const aspect of ASPECTS) {
      const [m] = computeLayout([WIRES(n)], aspect);
      expect(m.slots).toHaveLength(n);
      for (let i = 1; i < n; i++) {
        expect(m.slots[i].y).toBeGreaterThan(m.slots[i - 1].y);
        expect(m.slots[i].y).toBeGreaterThanOrEqual(m.slots[i - 1].y + m.slots[i - 1].h - EPS);
        expect(m.slots[i].x).toBeCloseTo(m.slots[0].x, 9);
        expect(m.slots[i].w).toBeCloseTo(m.slots[0].w, 9);
      }
    }
  });
});

describe('symbols geometry', () => {
  it('2x2 in reading order: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right', () => {
    for (const aspect of ASPECTS) {
      const [{ slots: s }] = computeLayout([spec('symbols', 4)], aspect);
      expect(s).toHaveLength(4);
      expect(s[0].x).toBeLessThan(s[1].x);
      expect(s[0].y).toBeCloseTo(s[1].y, 9);
      expect(s[2].x).toBeCloseTo(s[0].x, 9);
      expect(s[3].x).toBeCloseTo(s[1].x, 9);
      expect(s[2].y).toBeCloseTo(s[3].y, 9);
      expect(s[2].y).toBeGreaterThanOrEqual(s[0].y + s[0].h - EPS);
    }
  });
});

describe('code keypad geometry', () => {
  it('phone layout [1 2 3] [4 5 6] [7 8 9] [clear 0 submit], digit d is slot d, clear 10, submit 11', () => {
    for (const aspect of ASPECTS) {
      const [{ slots: s }] = computeLayout([KEYS()], aspect);
      expect(s).toHaveLength(12);
      const cx = (i: number): number => s[i].x + s[i].w / 2;
      const cy = (i: number): number => s[i].y + s[i].h / 2;
      const rows = [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
        [10, 0, 11],
      ];
      rows.forEach((row, r) => {
        row.forEach((slot, c) => {
          expect(cy(slot)).toBeCloseTo(cy(rows[r][0]), 9);
          expect(cx(slot)).toBeCloseTo(cx(rows[0][c]), 9);
        });
        if (r > 0) expect(cy(row[0])).toBeGreaterThan(cy(rows[r - 1][0]));
      });
      expect(cx(1)).toBeLessThan(cx(2));
      expect(cx(2)).toBeLessThan(cx(3));
      // named corners
      expect(cx(3)).toBeGreaterThan(cx(1)); // 1 top-left, 3 top-right
      expect(cy(7)).toBeGreaterThan(cy(1)); // 7 bottom-left of the digit block
      expect(cx(7)).toBeCloseTo(cx(1), 9);
      expect(cy(0)).toBeGreaterThan(cy(8)); // 0 in the bottom row
      expect(cx(0)).toBeCloseTo(cx(2), 9); // centered
      expect(cx(10)).toBeLessThan(cx(0)); // clear bottom-left
      expect(cx(11)).toBeGreaterThan(cx(0)); // submit bottom-right
    }
  });
});

describe('general geometry', () => {
  const COMBOS: ModuleSpec[][] = [
    [WIRES(6, 'a')],
    [KEYS('a')],
    [WIRES(6, 'a'), KEYS('b')],
    [WIRES(6, 'a'), spec('button', 1, 'b'), KEYS('c')],
    [WIRES(6, 'a'), spec('button', 1, 'b'), spec('symbols', 4, 'c'), KEYS('d')],
    [WIRES(6, 'a'), KEYS('b'), WIRES(6, 'c'), KEYS('d')],
  ];

  it('every slot lies inside its frame and inside 0..1; frames and slots never overlap; frames stay under the HUD band', () => {
    for (const specs of COMBOS) {
      for (const aspect of ASPECTS) {
        const layout = computeLayout(specs, aspect);
        expect(layout.map((m) => m.moduleId)).toEqual(specs.map((s) => s.moduleId));
        layout.forEach((m, i) => {
          expect(m.kind).toBe(specs[i].kind);
          expect(m.slots).toHaveLength(specs[i].slots);
          expect(inside(m.frame, { x: 0, y: 0, w: 1, h: 1 })).toBe(true);
          expect(m.frame.y).toBeGreaterThanOrEqual(HUD_H - EPS);
          for (const s of m.slots) {
            expect(s.w).toBeGreaterThan(0);
            expect(s.h).toBeGreaterThan(0);
            expect(inside(s, m.frame)).toBe(true);
          }
          m.slots.forEach((a, x) => m.slots.forEach((b, y) => x < y && expect(overlaps(a, b)).toBe(false)));
          if (m.display) {
            const display = m.display;
            expect(inside(display, m.frame)).toBe(true);
            m.slots.forEach((s) => expect(overlaps(display, s)).toBe(false));
          }
        });
        layout.forEach((a, x) => layout.forEach((b, y) => x < y && expect(overlaps(a.frame, b.frame)).toBe(false)));
      }
    }
  });

  it('only the symbols and code modules have a display band', () => {
    const layout = computeLayout([WIRES(4, 'a'), spec('button', 1, 'b'), spec('symbols', 4, 'c'), KEYS('d')], 1);
    expect(layout.map((m) => m.display !== null)).toEqual([false, false, true, true]);
  });

  it('2 modules: stacked (first above second, same x range) on every aspect, landscape included', () => {
    for (const aspect of [9 / 16, 1, 16 / 9, 2.4]) {
      const [a, b] = computeLayout([WIRES(4, 'a'), KEYS('b')], aspect);
      expect(a.frame.x).toBeCloseTo(b.frame.x, 9);
      expect(a.frame.w).toBeCloseTo(b.frame.w, 9);
      expect(a.frame.y + a.frame.h).toBeLessThanOrEqual(b.frame.y + EPS);
    }
  });

  it('3 and 4 modules form a 2x2 grid in reading order', () => {
    const four = computeLayout([WIRES(3, 'a'), WIRES(3, 'b'), WIRES(3, 'c'), WIRES(3, 'd')], 9 / 16);
    expect(four[0].frame.x).toBeLessThan(four[1].frame.x);
    expect(four[0].frame.y).toBeCloseTo(four[1].frame.y, 9);
    expect(four[2].frame.y).toBeGreaterThan(four[0].frame.y);
    expect(four[2].frame.x).toBeCloseTo(four[0].frame.x, 9);
    expect(four[3].frame.x).toBeCloseTo(four[1].frame.x, 9);
  });

  it('an empty module list gives an empty layout; a bad aspect still lays out', () => {
    expect(computeLayout([], 1)).toEqual([]);
    expect(computeLayout([WIRES(3)], Number.NaN)).toHaveLength(1);
    expect(computeLayout([WIRES(3)], 0)).toHaveLength(1);
  });

  it('does not mutate its specs', () => {
    const specs = Object.freeze([Object.freeze(WIRES(5))]);
    expect(() => computeLayout(specs as ModuleSpec[], 1)).not.toThrow();
  });
});

describe('the same bomb is laid out the same way on every screen shape', () => {
  // The shared pointer travels as 0..1 canvas coordinates, so a point must mean the same module on a
  // portrait phone and on a desktop. Slot x/w shrink with the aspect (round and square parts are
  // sized in height units), so rects are not strictly equal: the ARRANGEMENT must be.
  const SHAPES = [375 / 667, 1, 1280 / 720];
  const COUNTS: ModuleSpec[][] = [
    [WIRES(5, 'a')],
    [WIRES(5, 'a'), KEYS('b')],
    [WIRES(5, 'a'), spec('button', 1, 'b'), KEYS('c')],
    [WIRES(5, 'a'), spec('button', 1, 'b'), spec('symbols', 4, 'c'), KEYS('d')],
  ];
  const levelSpecs = (id: number): ModuleSpec[] =>
    specsFromDeaf(projectView(createSession(buildLevel(id)), 'deaf') as DeafView);
  const cases: [string, ModuleSpec[]][] = [
    ...COUNTS.map((c, i): [string, ModuleSpec[]] => [`${String(i + 1)} module(s)`, c]),
    ...Array.from({ length: 10 }, (_, i): [string, ModuleSpec[]] => [`level ${String(i + 1)}`, levelSpecs(i + 1)]),
  ];
  const sign = (n: number): number => (Math.abs(n) < 1e-6 ? 0 : Math.sign(n));
  const half = (c: number): number => sign(c - 0.5);

  it.each(cases)('%s: frame order, adjacency and halves agree at every aspect', (_name, specs) => {
    const layouts = SHAPES.map((a) => computeLayout(specs, a));
    const ref = layouts[0];
    for (const layout of layouts) {
      for (let i = 0; i < ref.length; i++) {
        const ci = { x: layout[i].frame.x + layout[i].frame.w / 2, y: layout[i].frame.y + layout[i].frame.h / 2 };
        const ri = { x: ref[i].frame.x + ref[i].frame.w / 2, y: ref[i].frame.y + ref[i].frame.h / 2 };
        expect(half(ci.x)).toBe(half(ri.x));
        expect(half(ci.y)).toBe(half(ri.y));
        // the centre of this frame is inside the same frame on the other screen shape
        expect(inside({ x: ci.x, y: ci.y, w: 0, h: 0 }, ref[i].frame)).toBe(true);
        for (let j = 0; j < ref.length; j++) {
          if (i === j) continue;
          const cj = layout[j].frame;
          const rj = ref[j].frame;
          expect(sign(layout[i].frame.y - cj.y)).toBe(sign(ref[i].frame.y - rj.y)); // above / same row / below
          expect(sign(layout[i].frame.x - cj.x)).toBe(sign(ref[i].frame.x - rj.x)); // left / same column / right
        }
      }
    }
  });

  it.each(cases)('%s: frames share the same vertical placement at every aspect (height-based geometry)', (_name, specs) => {
    const [first, ...rest] = SHAPES.map((a) => computeLayout(specs, a));
    for (const layout of rest) {
      layout.forEach((m, i) => {
        expect(m.frame.y).toBeCloseTo(first[i].frame.y, 9);
        expect(m.frame.h).toBeCloseTo(first[i].frame.h, 9);
      });
    }
  });

  it('two modules (levels 3 to 5 shape): a point on the first module lands on the first module on every screen', () => {
    const specs = [WIRES(5, 'wires'), spec('button', 1, 'button')];
    for (const aspect of SHAPES) {
      const [w, b] = computeLayout(specs, aspect);
      const top = { x: 0.5, y: w.frame.y + w.frame.h / 2 };
      const bottom = { x: 0.5, y: b.frame.y + b.frame.h / 2 };
      expect(inside({ ...top, w: 0, h: 0 }, w.frame)).toBe(true);
      expect(inside({ ...bottom, w: 0, h: 0 }, b.frame)).toBe(true);
    }
  });
});

describe('hitTest over computeLayout', () => {
  it('returns the right {moduleId, slot} at each slot center, for every kind and combination', () => {
    const combos: ModuleSpec[][] = [
      [WIRES(3, 'a')],
      [WIRES(6, 'a')],
      [spec('button', 1, 'a')],
      [spec('symbols', 4, 'a')],
      [KEYS('a')],
      [WIRES(5, 'a'), spec('button', 1, 'b')],
      [WIRES(5, 'a'), spec('button', 1, 'b'), spec('symbols', 4, 'c')],
      [WIRES(4, 'a'), spec('button', 1, 'b'), spec('symbols', 4, 'c'), KEYS('d')],
    ];
    for (const specs of combos) {
      for (const aspect of ASPECTS) {
        const layout = computeLayout(specs, aspect);
        for (const m of layout) {
          m.slots.forEach((s, slot) => {
            const p = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
            expect(hitTest(layout, p)).toEqual({ moduleId: m.moduleId, slot });
          });
        }
      }
    }
  });

  it('a point in the HUD band hits nothing', () => {
    const layout = computeLayout([WIRES(4, 'a'), KEYS('b')], 1);
    expect(hitTest(layout, { x: 0.5, y: HUD_H / 2 })).toBeNull();
  });
});

describe('specs from the blind and deaf views', () => {
  it('are deep-equal for the same bomb (all four kinds, many seeds)', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const session = createSession({ ...buildLevel(9), seed });
      const blind = specsFromBlind(projectView(session, 'blind') as BlindView);
      const deaf = specsFromDeaf(projectView(session, 'deaf') as DeafView);
      expect(deaf).toEqual(blind);
      expect(blind.map((s) => s.kind)).toEqual(['wires', 'button', 'symbols', 'code']);
      expect(blind[0].slots).toBe(5);
      expect(blind[3].slots).toBe(12);
    }
  });

  it('are identical for every level 1..10', () => {
    for (let id = 1; id <= 10; id++) {
      const session = createSession(buildLevel(id));
      expect(specsFromDeaf(projectView(session, 'deaf') as DeafView)).toEqual(
        specsFromBlind(projectView(session, 'blind') as BlindView),
      );
    }
  });
});

describe('touch size', () => {
  it('slots are at least 44 px on every level 1..10 at 375x667 and 1280x720', () => {
    for (const { w, h } of SIZES) {
      for (let id = 1; id <= 10; id++) {
        const session = createSession(buildLevel(id));
        const specs = specsFromDeaf(projectView(session, 'deaf') as DeafView);
        const min = minSlotSizePx(computeLayout(specs, w / h), w, h);
        expect(min, `level ${id} at ${w}x${h}`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  it('slots are at least 44 px for 1..4 modules of the largest kinds (6 wires, keypad)', () => {
    const combos: ModuleSpec[][] = [
      [WIRES(6, 'a')],
      [KEYS('a')],
      [WIRES(6, 'a'), KEYS('b')],
      [KEYS('a'), WIRES(6, 'b')],
      [WIRES(6, 'a'), KEYS('b'), WIRES(6, 'c')],
      [KEYS('a'), KEYS('b'), KEYS('c')],
      [WIRES(6, 'a'), KEYS('b'), WIRES(6, 'c'), KEYS('d')],
      [KEYS('a'), KEYS('b'), KEYS('c'), KEYS('d')],
      [WIRES(6, 'a'), WIRES(6, 'b'), WIRES(6, 'c'), WIRES(6, 'd')],
    ];
    for (const { w, h } of SIZES) {
      for (const specs of combos) {
        const min = minSlotSizePx(computeLayout(specs, w / h), w, h);
        expect(min, `${specs.map((s) => s.kind).join()} at ${w}x${h}`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  it('minSlotSizePx is the smallest slot side in pixels', () => {
    const layout = [
      {
        moduleId: 'a',
        kind: 'wires' as const,
        frame: { x: 0, y: 0, w: 1, h: 1 },
        display: null,
        slots: [
          { x: 0, y: 0, w: 0.5, h: 0.1 },
          { x: 0, y: 0.2, w: 0.2, h: 0.5 },
        ],
      },
    ];
    expect(minSlotSizePx(layout, 100, 200)).toBeCloseTo(20, 9);
  });
});
