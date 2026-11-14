import type { ActResult, BombModule, ManualEntry, ModuleAction, ModuleState, Rng } from '../types';

/** Readable serial alphabet: digits 2-9 and letters without I, L, O (no 0/1/O/I/L confusion). */
export const SERIAL_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const SERIAL_LENGTH = 6;
const CODE_LENGTH = 4;

/** Character value: a digit is its own value, a letter is its alphabet position (A=1 .. Z=26). */
const charValue = (ch: string): number => {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 64;
  return 0;
};

/**
 * Pure rule, same order as the manual. Total for every serial `init` can generate
 * (a serial with no digits is fine: letters count by alphabet position).
 * 1. Give each of the six serial characters a value: digit = itself, letter = alphabet position.
 * 2. S = sum of all six values.
 * 3. Code digit number i (i = 0 for the first, up to 3 for the fourth) is the last digit of
 *    S + (i+1) * value of serial character number i+1 + 3*i.
 */
export function computeTarget(serial: string): string {
  const values = Array.from(serial.toUpperCase(), charValue);
  const sum = values.reduce((a, b) => a + b, 0);
  let target = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    target += String((sum + (i + 1) * (values[i] ?? 0) + 3 * i) % 10);
  }
  return target;
}

interface CodeData {
  serial: string;
  target: string;
  entered: string;
}

const dataOf = (state: ModuleState): CodeData => state.data as unknown as CodeData;

const isDigit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 9;

// Roles: deaf reads the serial on the casing, mute reads the formula in the manual,
// blind enters the digits.
export const codeModule: BombModule = {
  kind: 'code',

  // Difficulty has no effect on the code.
  init(id: string, rng: Rng): ModuleState {
    let serial = '';
    for (let i = 0; i < SERIAL_LENGTH; i++) serial += SERIAL_CHARS[rng.int(SERIAL_CHARS.length)];
    const data: CodeData = { serial, target: computeTarget(serial), entered: '' };
    return { kind: 'code', id, solved: false, data: { ...data } };
  },

  act(state: ModuleState, action: ModuleAction): ActResult {
    const unchanged: ActResult = { state, outcome: 'progress' };
    if (state.solved || action.kind !== 'code') return unchanged;
    const { target, entered } = dataOf(state);
    switch (action.type) {
      case 'digit': {
        const d = action.payload?.['d'];
        if (!isDigit(d) || entered.length >= CODE_LENGTH) return unchanged;
        return {
          state: { ...state, data: { ...state.data, entered: entered + String(d) } },
          outcome: 'progress',
        };
      }
      case 'clear':
        return { state: { ...state, data: { ...state.data, entered: '' } }, outcome: 'progress' };
      case 'submit':
        if (entered === target) {
          return { state: { ...state, solved: true }, outcome: 'solved' };
        }
        return { state: { ...state, data: { ...state.data, entered: '' } }, outcome: 'strike' };
      default:
        return unchanged;
    }
  },

  manual(): ManualEntry {
    return {
      kind: 'code',
      titleKey: 'manual.code.title',
      rules: [1, 2, 3, 4, 5].map((n) => `manual.code.rule.${n}`),
    };
  },

  // Winning sequence; a clear comes first only when digits were already entered.
  solve(state: ModuleState): ModuleAction[] {
    const { target, entered } = dataOf(state);
    const actions: ModuleAction[] = entered === '' ? [] : [{ kind: 'code', type: 'clear' }];
    for (const ch of target) {
      actions.push({ kind: 'code', type: 'digit', payload: { d: Number(ch) } });
    }
    actions.push({ kind: 'code', type: 'submit' });
    return actions;
  },
};
