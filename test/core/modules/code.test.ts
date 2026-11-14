import { describe, it, expect } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { codeModule, computeTarget, SERIAL_CHARS } from '../../../src/core/modules/code';
import type { ActResult, ModuleAction, ModuleState } from '../../../src/core/types';

const stateOf = (serial: string, entered = ''): ModuleState => ({
  kind: 'code',
  id: 'c1',
  solved: false,
  data: { serial, target: computeTarget(serial), entered },
});

const enteredOf = (s: ModuleState): string => s.data['entered'] as string;
const targetOf = (s: ModuleState): string => s.data['target'] as string;

const digit = (d: unknown): ModuleAction => ({
  kind: 'code',
  type: 'digit',
  payload: { d: d as number },
});
const clear: ModuleAction = { kind: 'code', type: 'clear' };
const submit: ModuleAction = { kind: 'code', type: 'submit' };

const run = (state: ModuleState, actions: ModuleAction[]): ActResult => {
  let result: ActResult = { state, outcome: 'progress' };
  for (const a of actions) result = codeModule.act(result.state, a);
  return result;
};

describe('code module: computeTarget (golden values, hand-computed)', () => {
  // Rule: v = digit value or alphabet position (A=1..Z=26), S = sum of all six v,
  // target digit i (0..3) = (S + (i+1)*v[i] + 3*i) mod 10.
  const GOLDEN: Record<string, string> = {
    '234567': '9656', // all digits, S=27
    '999999': '3579', // all digits, S=54
    ABCDEF: '2866', // no digits, S=21
    ZZZZZZ: '2109', // no digits, S=156
    '9A2Z5H': '0634', // mixed, S=51
  };

  for (const [serial, target] of Object.entries(GOLDEN)) {
    it(`${serial} -> ${target}`, () => {
      expect(computeTarget(serial)).toBe(target);
    });
  }

  it('depends on every serial character (changing any one char changes the target)', () => {
    for (const base of ['234567', 'ABCDEF', '9A2Z5H']) {
      for (let j = 0; j < 6; j++) {
        // +1 on the value of one character: 2->3, 9->8, A->B, Z->Y, H->J etc.
        const c = base[j]!;
        const swapped = c === '9' ? '8' : c === 'Z' ? 'Y' : /\d/.test(c) ? String(Number(c) + 1) : String.fromCharCode(c.charCodeAt(0) + 1);
        const changed = base.slice(0, j) + swapped + base.slice(j + 1);
        expect(computeTarget(changed), `${base} -> ${changed}`).not.toBe(computeTarget(base));
      }
    }
  });

  it('weights: raising char 0 by one adds 2 to digit 0 and 1 to the others', () => {
    // 234567 (9656) -> 334567: S=28, v0=3 -> 31, 37, 46, 57
    expect(computeTarget('334567')).toBe('1767');
  });

  it('chars 5 and 6 only act through the sum', () => {
    // 234567 -> 234568: S=28, every digit +1 -> 0767
    expect(computeTarget('234568')).toBe('0767');
  });

  it('depends on position: swapping two characters changes the target', () => {
    expect(computeTarget('234567')).toBe('9656');
    expect(computeTarget('324567')).toBe('0456'); // same sum 27, weights differ
    expect(computeTarget('ABCDEF')).not.toBe(computeTarget('BACDEF'));
    expect(computeTarget('ABCDEF')).not.toBe(computeTarget('FEDCBA'));
  });

  it('is always exactly 4 digits for every generated serial', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const serial = codeModule.init('c', createRng(seed), 2).data['serial'] as string;
      expect(computeTarget(serial)).toMatch(/^\d{4}$/);
    }
  });

  it('different serials generally give different targets', () => {
    const targets = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      targets.add(targetOf(codeModule.init('c', createRng(seed), 2)));
    }
    expect(targets.size).toBeGreaterThan(100);
  });
});

describe('code module: init', () => {
  it('is deterministic for a given seed and differs across seeds', () => {
    expect(codeModule.init('c', createRng(7), 3)).toEqual(codeModule.init('c', createRng(7), 3));
    const serials = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      serials.add(codeModule.init('c', createRng(seed), 3).data['serial'] as string);
    }
    expect(serials.size).toBeGreaterThan(30);
  });

  it('builds a 6-char readable serial, target from computeTarget, empty entered', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const s = codeModule.init('abc', createRng(seed), 2);
      expect(s.kind).toBe('code');
      expect(s.id).toBe('abc');
      expect(s.solved).toBe(false);
      const serial = s.data['serial'] as string;
      expect(serial).toHaveLength(6);
      for (const ch of serial) expect(SERIAL_CHARS).toContain(ch);
      expect(s.data['target']).toBe(computeTarget(serial));
      expect(enteredOf(s)).toBe('');
    }
  });

  it('serial alphabet excludes ambiguous characters', () => {
    for (const bad of ['0', '1', 'O', 'I', 'L']) expect(SERIAL_CHARS).not.toContain(bad);
    expect(new Set(SERIAL_CHARS).size).toBe(SERIAL_CHARS.length);
  });

  it('produces both letter-only and digit-containing serials over many seeds', () => {
    const serials: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      serials.push(codeModule.init('c', createRng(seed), 2).data['serial'] as string);
    }
    expect(serials.some((s) => /\d/.test(s))).toBe(true);
    expect(serials.some((s) => /[A-Z]/.test(s))).toBe(true);
  });
});

describe('code module: act', () => {
  it('digit appends and returns progress', () => {
    const r = run(stateOf('234567'), [digit(4), digit(2)]);
    expect(enteredOf(r.state)).toBe('42');
    expect(r.outcome).toBe('progress');
  });

  it('digit does not mutate the previous state', () => {
    const before = stateOf('234567', '12');
    const frozen = JSON.stringify(before);
    codeModule.act(before, digit(3));
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it('entered never exceeds 4 digits', () => {
    const r = run(stateOf('234567'), [digit(1), digit(2), digit(3), digit(4), digit(5), digit(6)]);
    expect(enteredOf(r.state)).toBe('1234');
    expect(r.outcome).toBe('progress');
  });

  it('5th digit returns the very same state', () => {
    const s = stateOf('234567', '1234');
    const r = codeModule.act(s, digit(5));
    expect(r.state).toBe(s);
    expect(r.outcome).toBe('progress');
  });

  it('ignores invalid digits (same state, progress)', () => {
    const s = stateOf('234567', '12');
    for (const bad of [-1, 10, 1.5, NaN, Infinity, '3', null, undefined]) {
      const r = codeModule.act(s, digit(bad));
      expect(r.state).toBe(s);
      expect(r.outcome).toBe('progress');
    }
    const noPayload = codeModule.act(s, { kind: 'code', type: 'digit' });
    expect(noPayload.state).toBe(s);
    expect(noPayload.outcome).toBe('progress');
  });

  it('accepts the boundary digits 0 and 9', () => {
    expect(enteredOf(run(stateOf('234567'), [digit(0), digit(9)]).state)).toBe('09');
  });

  it('clear empties entered and returns progress', () => {
    const r = codeModule.act(stateOf('234567', '123'), clear);
    expect(enteredOf(r.state)).toBe('');
    expect(r.outcome).toBe('progress');
    expect(r.state.solved).toBe(false);
  });

  it('wrong submit strikes and empties entered, keeps the module unsolved', () => {
    const s = stateOf('234567', '1111'); // target is 9656
    const r = codeModule.act(s, submit);
    expect(r.outcome).toBe('strike');
    expect(enteredOf(r.state)).toBe('');
    expect(r.state.solved).toBe(false);
    expect(targetOf(r.state)).toBe('9656');
  });

  it('incomplete submit (0..3 digits, even a correct prefix) strikes and empties entered', () => {
    for (const partial of ['', '9', '96', '965']) {
      const r = codeModule.act(stateOf('234567', partial), submit);
      expect(r.outcome, `entered "${partial}"`).toBe('strike');
      expect(enteredOf(r.state)).toBe('');
      expect(r.state.solved).toBe(false);
    }
  });

  it('correct submit solves', () => {
    const r = codeModule.act(stateOf('234567', '9656'), submit);
    expect(r.outcome).toBe('solved');
    expect(r.state.solved).toBe(true);
  });

  it('after a wrong submit the code can be re-entered and solved', () => {
    const r1 = run(stateOf('ABCDEF'), [digit(0), digit(0), digit(0), digit(0), submit]);
    expect(r1.outcome).toBe('strike');
    const r2 = run(r1.state, [digit(2), digit(8), digit(6), digit(6), submit]);
    expect(r2.outcome).toBe('solved');
  });

  it('ignores actions for another module kind and unknown types', () => {
    const s = stateOf('234567', '12');
    const other = codeModule.act(s, { kind: 'wires', type: 'digit', payload: { d: 3 } });
    expect(other.state).toBe(s);
    expect(other.outcome).toBe('progress');
    const unknown = codeModule.act(s, { kind: 'code', type: 'explode' });
    expect(unknown.state).toBe(s);
    expect(unknown.outcome).toBe('progress');
  });

  it('a solved module ignores further actions', () => {
    const solved = codeModule.act(stateOf('234567', '9656'), submit).state;
    for (const a of [digit(1), clear, submit]) {
      const r = codeModule.act(solved, a);
      expect(r.state).toBe(solved);
      expect(r.outcome).toBe('progress');
    }
  });
});

describe('code module: solve and manual', () => {
  it('solve is four digit actions then a submit, and solves the module', () => {
    const s = stateOf('ZZZZZZ');
    const actions = codeModule.solve(s);
    expect(actions).toEqual([digit(2), digit(1), digit(0), digit(9), submit]);
    const r = run(s, actions);
    expect(r.outcome).toBe('solved');
    expect(r.state.solved).toBe(true);
  });

  it('solve solves every generated module without a strike on the way', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = codeModule.init('c', createRng(seed), 2);
      let cur = s;
      const actions = codeModule.solve(s);
      expect(actions).toHaveLength(5);
      actions.forEach((a, i) => {
        const r = codeModule.act(cur, a);
        expect(r.outcome).toBe(i === 4 ? 'solved' : 'progress');
        cur = r.state;
      });
      expect(cur.solved).toBe(true);
    }
  });

  it('solve starts with a clear when entered is not empty', () => {
    const s = stateOf('234567', '12');
    const actions = codeModule.solve(s);
    expect(actions[0]).toEqual(clear);
    expect(run(s, actions).outcome).toBe('solved');
  });

  it('manual uses i18n keys only', () => {
    const m = codeModule.manual();
    expect(m.kind).toBe('code');
    expect(m.titleKey).toBe('manual.code.title');
    expect(m.rules.length).toBeGreaterThanOrEqual(4);
    m.rules.forEach((key, i) => expect(key).toBe(`manual.code.rule.${i + 1}`));
  });
});
