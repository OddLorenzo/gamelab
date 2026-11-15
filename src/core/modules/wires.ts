import type { ActResult, BombModule, ManualEntry, ModuleAction, ModuleState, Rng } from '../types';

export type WireColor = 'red' | 'blue' | 'yellow' | 'green' | 'white';

export interface Wire {
  color: WireColor;
  cut: boolean;
}

/** The colours a wire can have, in the order the 3-wire fallback ranks them. */
const COLORS: readonly WireColor[] = ['red', 'blue', 'yellow', 'green', 'white'];

const timesOf = (c: readonly WireColor[], color: WireColor): number => c.filter((x) => x === color).length;
const differentColors = (c: readonly WireColor[]): number => new Set(c).size;
const appearsOnce = (c: readonly WireColor[], i: number): boolean => timesOf(c, c[i]) === 1;
const highestOnce = (c: readonly WireColor[]): number => c.findIndex((_, i) => appearsOnce(c, i));
const lowestOnce = (c: readonly WireColor[]): number => {
  for (let i = c.length - 1; i >= 0; i--) if (appearsOnce(c, i)) return i;
  return -1;
};
/** Lower wire of the highest pair of neighbouring wires that share a colour, -1 when no such pair. */
const lowerOfHighestPair = (c: readonly WireColor[]): number => {
  for (let i = 1; i < c.length; i++) if (c[i] === c[i - 1]) return i;
  return -1;
};
/** First wire, from the top, whose colour differs from the top wire; -1 when all share one colour. */
const firstChange = (c: readonly WireColor[]): number => c.findIndex((x) => x !== c[0]);
/** Highest wire whose colour comes first in COLORS. */
const earliestInList = (c: readonly WireColor[]): number => {
  let best = 0;
  for (let i = 1; i < c.length; i++) if (COLORS.indexOf(c[i]) < COLORS.indexOf(c[best])) best = i;
  return best;
};
/** Lowest wire whose colour is one of the colours that appear the most times. */
const lowestOfMostCommon = (c: readonly WireColor[]): number => {
  const most = Math.max(...c.map((x) => timesOf(c, x)));
  for (let i = c.length - 1; i >= 0; i--) if (timesOf(c, c[i]) === most) return i;
  return -1;
};

/**
 * Pure rule table, same order as the manual. Depends on colors only (never the cut flag),
 * so exactly one index is correct for any 3..6 wire layout. First matching rule wins.
 * Index 0 is the top wire.
 */
export function correctIndex(wires: readonly Wire[]): number {
  const c = wires.map((w) => w.color);
  const bottom = c.length - 1;
  switch (c.length) {
    case 3:
      if (c[0] === c[2]) return 1; // manual line 1
      if (lowerOfHighestPair(c) !== -1) return highestOnce(c); // line 2
      return earliestInList(c); // line 3
    case 4:
      if (c[1] === c[2]) return bottom; // line 1
      if (c[0] === c[3]) return 2; // line 2
      if (differentColors(c) >= 3) return highestOnce(c); // line 3
      return firstChange(c); // line 4
    case 5:
      if (c[1] === c[3]) return 2; // line 1
      if (differentColors(c) >= 3) return lowestOnce(c); // line 2
      if (c[0] === c[4]) return 0; // line 3
      return firstChange(c); // line 4
    case 6:
      if (lowerOfHighestPair(c) === -1) return lowestOfMostCommon(c); // line 1
      if (differentColors(c) % 2 === 1) return lowerOfHighestPair(c); // line 2
      if (lowestOnce(c) !== -1) return bottom - lowestOnce(c); // line 3: the mirrored wire
      return 2; // line 4
    default:
      throw new Error(`wires: unsupported wire count ${wires.length}`);
  }
}

const wiresOf = (state: ModuleState): Wire[] => state.data['wires'] as Wire[];

// Difficulty 1..5 spreads linearly over 3..6 wires: 3, 4, 5, 5, 6.
const wireCountFor = (difficulty: number): number => {
  const d = Number.isNaN(difficulty) ? 1 : Math.min(5, Math.max(1, difficulty));
  return Math.round(3 + ((d - 1) * 3) / 4);
};

// Roles: deaf sees colors and order, mute reads the manual, blind taps a position to cut.
export const wiresModule: BombModule = {
  kind: 'wires',

  init(id: string, rng: Rng, difficulty: number): ModuleState {
    const wires: Wire[] = Array.from({ length: wireCountFor(difficulty) }, () => ({
      color: rng.pick(COLORS),
      cut: false,
    }));
    return { kind: 'wires', id, solved: false, data: { wires } };
  },

  act(state: ModuleState, action: ModuleAction): ActResult {
    const unchanged: ActResult = { state, outcome: 'progress' };
    if (state.solved || action.kind !== 'wires' || action.type !== 'cut') return unchanged;
    const index = action.payload?.['index'];
    const wires = wiresOf(state);
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= wires.length) {
      return unchanged;
    }
    if (wires[index].cut) return unchanged;
    const nextWires = wires.map((w, i) => (i === index ? { ...w, cut: true } : w));
    const solved = index === correctIndex(wires);
    return {
      state: { ...state, solved, data: { ...state.data, wires: nextWires } },
      outcome: solved ? 'solved' : 'strike',
    };
  },

  manual(): ManualEntry {
    return {
      kind: 'wires',
      titleKey: 'manual.wires.title',
      rules: [3, 4, 5, 6].map((n) => `manual.wires.rule.${n}`),
    };
  },

  solve(state: ModuleState): ModuleAction[] {
    return [{ kind: 'wires', type: 'cut', payload: { index: correctIndex(wiresOf(state)) } }];
  },
};
