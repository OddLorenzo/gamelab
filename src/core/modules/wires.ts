import type { ActResult, BombModule, ManualEntry, ModuleAction, ModuleState, Rng } from '../types';

export type WireColor = 'red' | 'blue' | 'yellow' | 'green' | 'white';

export interface Wire {
  color: WireColor;
  cut: boolean;
}

const COLORS: readonly WireColor[] = ['red', 'blue', 'yellow', 'green', 'white'];

const count = (wires: readonly Wire[], color: WireColor): number =>
  wires.filter((w) => w.color === color).length;

const lastIndexOf = (wires: readonly Wire[], color: WireColor): number => {
  for (let i = wires.length - 1; i >= 0; i--) {
    if (wires[i].color === color) return i;
  }
  return -1;
};

/**
 * Pure rule table, same order as the manual. Depends on colors only (never the cut flag),
 * so exactly one index is correct for any 3..6 wire layout. First matching rule wins.
 */
export function correctIndex(wires: readonly Wire[]): number {
  const last = wires.length - 1;
  const lastColor = wires[last].color;
  switch (wires.length) {
    case 3:
      if (count(wires, 'red') === 0) return 1;
      if (lastColor === 'white') return 0;
      if (count(wires, 'blue') > 1) return lastIndexOf(wires, 'blue');
      return last;
    case 4:
      if (count(wires, 'red') > 1) return lastIndexOf(wires, 'red');
      if (lastColor === 'yellow' && count(wires, 'red') === 0) return 0;
      if (count(wires, 'blue') === 1) return lastIndexOf(wires, 'blue');
      if (count(wires, 'yellow') > 1) return last;
      return 1;
    case 5:
      if (lastColor === 'green') return 3;
      if (count(wires, 'red') === 1 && count(wires, 'yellow') > 1) return 0;
      if (count(wires, 'green') === 0) return 1;
      return 0;
    case 6:
      if (count(wires, 'yellow') === 0) return 2;
      if (count(wires, 'yellow') === 1 && count(wires, 'white') > 1) {
        return lastIndexOf(wires, 'white');
      }
      if (count(wires, 'white') === 0) return last;
      return 3;
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
