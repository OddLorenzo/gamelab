import type { ActResult, BombModule, ManualEntry, ModuleAction, ModuleState, Rng } from '../types';

/**
 * The manual's table: 6 columns of 7 glyphs, read top to bottom. Glyphs come from a fixed
 * set of 20 original names and repeat across columns. Design invariant: any two columns
 * share at most 3 glyphs, so any 4 distinct glyphs fit in at most one column. `init` only
 * ever shows 4 glyphs taken from a single column, so exactly ONE column contains all four
 * and the rule is never ambiguous. The manual scene renders this same table.
 */
export const SYMBOL_COLUMNS: readonly (readonly string[])[] = [
  ['flame', 'spiral', 'crab', 'hand', 'anchor', 'eye', 'crown'],
  ['moon', 'spiral', 'hand', 'key', 'cloud', 'flame', 'arrow'],
  ['arrow', 'hand', 'tree', 'shell', 'flame', 'leaf', 'anchor'],
  ['gear', 'spiral', 'moon', 'tree', 'key', 'bolt', 'drop'],
  ['arrow', 'crab', 'star', 'shell', 'bolt', 'key', 'bell'],
  ['hand', 'bolt', 'wave', 'star', 'gear', 'bell', 'eye'],
];

const SLOTS = 4;

/**
 * Pure rule helper, same logic as the manual. Finds the column holding all displayed
 * glyphs and returns the slot indices ordered by the glyph's position in that column,
 * top to bottom. Returns null if no column (or more than one) matches.
 */
export function tapOrder(symbols: readonly string[]): number[] | null {
  const matches = SYMBOL_COLUMNS.filter((col) => symbols.every((g) => col.includes(g)));
  if (matches.length !== 1) return null;
  const [col] = matches;
  return symbols
    .map((_, slot) => slot)
    .sort((a, b) => col.indexOf(symbols[a]) - col.indexOf(symbols[b]));
}

interface SymbolsData {
  symbols: string[];
  order: number[];
  next: number;
}

const dataOf = (state: ModuleState): SymbolsData => state.data as unknown as SymbolsData;

const isSlot = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < SLOTS;

// Roles: deaf sees the glyphs, mute reads the manual columns, blind taps slots 0-3 in the
// column order. A wrong tap strikes and restarts the sequence; the 4th right tap solves.
export const symbolsModule: BombModule = {
  kind: 'symbols',

  // Difficulty has no effect on symbols.
  init(id: string, rng: Rng): ModuleState {
    const column = rng.pick(SYMBOL_COLUMNS);
    // Partial Fisher-Yates over the column's 7 positions: the first 4 are distinct.
    const positions = column.map((_, i) => i);
    for (let i = 0; i < SLOTS; i++) {
      const j = i + rng.int(positions.length - i);
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    const picked = positions.slice(0, SLOTS); // display order, already shuffled
    const symbols = picked.map((p) => column[p]);
    const order = picked
      .map((_, slot) => slot)
      .sort((a, b) => picked[a] - picked[b]);
    const data: SymbolsData = { symbols, order, next: 0 };
    return { kind: 'symbols', id, solved: false, data: { ...data } };
  },

  act(state: ModuleState, action: ModuleAction): ActResult {
    const unchanged: ActResult = { state, outcome: 'progress' };
    if (state.solved || action.kind !== 'symbols' || action.type !== 'tap') return unchanged;
    const slot = action.payload?.['slot'];
    if (!isSlot(slot)) return unchanged;
    const { order, next } = dataOf(state);
    if (slot !== order[next]) {
      return { state: { ...state, data: { ...state.data, next: 0 } }, outcome: 'strike' };
    }
    const done = next + 1;
    if (done === SLOTS) {
      return { state: { ...state, solved: true, data: { ...state.data, next: done } }, outcome: 'solved' };
    }
    return { state: { ...state, data: { ...state.data, next: done } }, outcome: 'progress' };
  },

  manual(): ManualEntry {
    return {
      kind: 'symbols',
      titleKey: 'manual.symbols.title',
      rules: [1, 2, 3, 4].map((n) => `manual.symbols.rule.${n}`),
    };
  },

  solve(state: ModuleState): ModuleAction[] {
    return dataOf(state).order.map((slot) => ({
      kind: 'symbols' as const,
      type: 'tap',
      payload: { slot },
    }));
  },
};
