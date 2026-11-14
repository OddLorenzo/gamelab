import type { ActResult, BombModule, ManualEntry, ModuleAction, ModuleState, Rng } from '../types';

export type ButtonColor = 'red' | 'blue' | 'yellow' | 'white';
export type ButtonLabel = 'HOLD' | 'PRESS' | 'ABORT';

const COLORS: readonly ButtonColor[] = ['red', 'blue', 'yellow', 'white'];
const LABELS: readonly ButtonLabel[] = ['HOLD', 'PRESS', 'ABORT'];

/**
 * Pure rule table, same order as the manual. First matching rule wins, otherwise tap.
 * Defined for every color/label pair, so `act`, `solve` and the manual always agree.
 * true = hold and release when the timer's seconds digit equals the button's digit;
 * false = tap (press and release immediately, any timer digit).
 */
export function needsHold(color: ButtonColor, label: ButtonLabel): boolean {
  if (color === 'white' && label === 'ABORT') return false; // manual rule 1
  if (color === 'blue') return true; // manual rule 2
  if (label === 'ABORT') return true; // manual rule 3
  if (color === 'yellow' && label === 'PRESS') return true; // manual rule 4
  return false; // manual rule 5
}

interface ButtonData {
  color: ButtonColor;
  label: ButtonLabel;
  held: boolean;
  digit: number;
}

const dataOf = (state: ModuleState): ButtonData => state.data as unknown as ButtonData;

const isDigit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 9;

const strike = (state: ModuleState): ActResult => ({
  state: { ...state, data: { ...state.data, held: false } },
  outcome: 'strike',
});

const solvedResult = (state: ModuleState): ActResult => ({
  state: { ...state, solved: true, data: { ...state.data, held: false } },
  outcome: 'solved',
});

// Roles: deaf reads color, label and the bomb timer, mute reads the manual,
// blind presses, holds and releases. The module never reads a clock: `timerDigit`
// (last digit of the timer's seconds) always arrives in the action payload. The host
// overwrites any client-supplied value with the real one, so the module trusts its payload.
export const buttonModule: BombModule = {
  kind: 'button',

  // Difficulty has no effect on the button.
  init(id: string, rng: Rng): ModuleState {
    const data: ButtonData = {
      color: rng.pick(COLORS),
      label: rng.pick(LABELS),
      held: false,
      digit: rng.int(10),
    };
    return { kind: 'button', id, solved: false, data: { ...data } };
  },

  act(state: ModuleState, action: ModuleAction): ActResult {
    const unchanged: ActResult = { state, outcome: 'progress' };
    if (state.solved || action.kind !== 'button') return unchanged;
    const { color, label, held, digit } = dataOf(state);
    const hold = needsHold(color, label);
    switch (action.type) {
      case 'press':
        if (held) return unchanged;
        return hold ? strike(state) : solvedResult(state);
      case 'hold':
        if (held) return unchanged;
        return { state: { ...state, data: { ...state.data, held: true } }, outcome: 'progress' };
      case 'release': {
        if (!held) return unchanged;
        const timerDigit = action.payload?.['timerDigit'];
        if (!isDigit(timerDigit)) return unchanged;
        return hold && timerDigit === digit ? solvedResult(state) : strike(state);
      }
      default:
        return unchanged;
    }
  },

  manual(): ManualEntry {
    return {
      kind: 'button',
      titleKey: 'manual.button.title',
      rules: [1, 2, 3, 4, 5, 6].map((n) => `manual.button.rule.${n}`),
    };
  },

  solve(state: ModuleState): ModuleAction[] {
    const { color, label, digit } = dataOf(state);
    if (!needsHold(color, label)) return [{ kind: 'button', type: 'press' }];
    return [
      { kind: 'button', type: 'hold' },
      { kind: 'button', type: 'release', payload: { timerDigit: digit } },
    ];
  },
};
