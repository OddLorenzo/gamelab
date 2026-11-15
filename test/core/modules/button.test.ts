import { describe, it, expect } from 'vitest';
import { createRng } from '../../../src/core/rng';
import {
  buttonModule,
  needsHold,
  type ButtonColor,
  type ButtonLabel,
} from '../../../src/core/modules/button';
import type { ActResult, ModuleAction, ModuleState } from '../../../src/core/types';

const COLORS: ButtonColor[] = ['orange', 'teal', 'purple', 'pink'];
const LABELS: ButtonLabel[] = ['GO', 'STOP', 'WAIT'];

const stateOf = (color: ButtonColor, label: ButtonLabel, digit = 5, held = false): ModuleState => ({
  kind: 'button',
  id: 'b1',
  solved: false,
  data: { color, label, held, digit },
});

const heldOf = (s: ModuleState): boolean => s.data['held'] as boolean;

const act = (type: string, timerDigit?: number): ModuleAction => ({
  kind: 'button',
  type,
  payload: timerDigit === undefined ? undefined : { timerDigit },
});

// Reference table, written out by hand: true = hold, false = tap.
const EXPECTED: Record<string, boolean> = {
  'orange/GO': false,
  'orange/STOP': true,
  'orange/WAIT': true,
  'teal/GO': false,
  'teal/STOP': true,
  'teal/WAIT': true,
  'purple/GO': true,
  'purple/STOP': false,
  'purple/WAIT': false,
  'pink/GO': true,
  'pink/STOP': false,
  'pink/WAIT': false,
};

describe('button module: init', () => {
  it('is deterministic for a given seed and differs across seeds', () => {
    expect(buttonModule.init('b', createRng(7), 3)).toEqual(buttonModule.init('b', createRng(7), 3));
    const variants = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      variants.add(JSON.stringify(buttonModule.init('b', createRng(seed), 3).data));
    }
    expect(variants.size).toBeGreaterThan(10);
  });

  it('starts unsolved, not held, kind and id set, digit is an integer 0..9', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const s = buttonModule.init('abc', createRng(seed), 2);
      expect(s.kind).toBe('button');
      expect(s.id).toBe('abc');
      expect(s.solved).toBe(false);
      expect(heldOf(s)).toBe(false);
      expect(COLORS).toContain(s.data['color']);
      expect(LABELS).toContain(s.data['label']);
      const digit = s.data['digit'] as number;
      expect(Number.isInteger(digit) && digit >= 0 && digit <= 9).toBe(true);
    }
  });

  it('can generate every color and label, and ignores difficulty (NaN safe)', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const s = buttonModule.init('b', createRng(seed), NaN);
      seen.add(`${String(s.data['color'])}/${String(s.data['label'])}`);
    }
    expect([...seen].sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe('needsHold rule table (first match wins)', () => {
  it('matches the hand-written table for all 12 color/label combinations', () => {
    for (const color of COLORS) {
      for (const label of LABELS) {
        expect(needsHold(color, label), `${color}/${label}`).toBe(EXPECTED[`${color}/${label}`]);
      }
    }
  });

  it('rule 1 (purple or pink GO holds) beats rule 2 (GO taps, pink taps)', () => {
    expect(needsHold('purple', 'GO')).toBe(true);
    expect(needsHold('pink', 'GO')).toBe(true);
    expect(needsHold('orange', 'GO')).toBe(false);
  });

  it('rule 2 (GO or pink taps) beats rule 3 (orange or teal holds)', () => {
    expect(needsHold('orange', 'GO')).toBe(false);
    expect(needsHold('teal', 'GO')).toBe(false);
    expect(needsHold('pink', 'STOP')).toBe(false);
    expect(needsHold('pink', 'WAIT')).toBe(false);
  });

  it('rule 3: orange and teal STOP / WAIT hold, ahead of the tap fallback', () => {
    expect(needsHold('orange', 'STOP')).toBe(true);
    expect(needsHold('teal', 'WAIT')).toBe(true);
  });

  it('fallback: purple STOP and purple WAIT are taps', () => {
    expect(needsHold('purple', 'STOP')).toBe(false);
    expect(needsHold('purple', 'WAIT')).toBe(false);
  });

  it('both gestures occur, 6 of the 12 pairs hold', () => {
    expect(Object.values(EXPECTED).filter(Boolean)).toHaveLength(6);
  });
});

describe('button module: tap-type (orange GO)', () => {
  const tapState = stateOf('orange', 'GO', 3);

  it('press solves', () => {
    const r = buttonModule.act(tapState, act('press', 8));
    expect(r.outcome).toBe('solved');
    expect(r.state.solved).toBe(true);
  });

  it('hold only starts holding, then release strikes whatever the digit', () => {
    const h = buttonModule.act(tapState, act('hold', 3));
    expect(h.outcome).toBe('progress');
    expect(heldOf(h.state)).toBe(true);
    // 3 is the state digit: a hold-type would be solved here, a tap-type must strike.
    const r = buttonModule.act(h.state, act('release', 3));
    expect(r.outcome).toBe('strike');
    expect(r.state.solved).toBe(false);
    expect(heldOf(r.state)).toBe(false);
  });

  it('can still be solved by a tap after a strike', () => {
    const h = buttonModule.act(tapState, act('hold', 0));
    const r = buttonModule.act(h.state, act('release', 0));
    expect(buttonModule.act(r.state, act('press', 0)).outcome).toBe('solved');
  });
});

describe('button module: hold-type (teal STOP, digit 4)', () => {
  const holdState = stateOf('teal', 'STOP', 4);

  it('a quick press strikes', () => {
    const r = buttonModule.act(holdState, act('press', 4));
    expect(r.outcome).toBe('strike');
    expect(r.state.solved).toBe(false);
  });

  it('release before holding does nothing', () => {
    const r = buttonModule.act(holdState, act('release', 4));
    expect(r.outcome).toBe('progress');
    expect(r.state).toBe(holdState);
  });

  it('hold then release on the right digit solves', () => {
    const h = buttonModule.act(holdState, act('hold', 9));
    expect(h.outcome).toBe('progress');
    expect(heldOf(h.state)).toBe(true);
    const r = buttonModule.act(h.state, act('release', 4));
    expect(r.outcome).toBe('solved');
    expect(r.state.solved).toBe(true);
    expect(heldOf(r.state)).toBe(false);
  });

  it('release on a wrong digit strikes, drops the hold, and a retry can solve', () => {
    const h = buttonModule.act(holdState, act('hold', 0));
    const bad = buttonModule.act(h.state, act('release', 7));
    expect(bad.outcome).toBe('strike');
    expect(bad.state.solved).toBe(false);
    expect(heldOf(bad.state)).toBe(false);
    const h2 = buttonModule.act(bad.state, act('hold', 0));
    expect(buttonModule.act(h2.state, act('release', 4)).outcome).toBe('solved');
  });

  it('digit 0 is a valid target', () => {
    const zero = stateOf('pink', 'GO', 0);
    const h = buttonModule.act(zero, act('hold', 5));
    expect(buttonModule.act(h.state, act('release', 0)).outcome).toBe('solved');
  });

  it('a second hold while held changes nothing', () => {
    const h = buttonModule.act(holdState, act('hold', 0));
    const again = buttonModule.act(h.state, act('hold', 0));
    expect(again.outcome).toBe('progress');
    expect(again.state).toBe(h.state);
  });

  it('press while held changes nothing', () => {
    const h = buttonModule.act(holdState, act('hold', 0));
    const p = buttonModule.act(h.state, act('press', 4));
    expect(p.outcome).toBe('progress');
    expect(p.state).toBe(h.state);
  });
});

describe('button module: robustness', () => {
  it('release with a missing, non-integer, NaN or out-of-range digit is ignored while held', () => {
    const held = stateOf('teal', 'STOP', 4, true);
    const bad: (ModuleAction['payload'])[] = [
      undefined,
      {},
      { timerDigit: '4' },
      { timerDigit: 4.5 },
      { timerDigit: NaN },
      { timerDigit: Infinity },
      { timerDigit: -1 },
      { timerDigit: 10 },
    ];
    for (const payload of bad) {
      const r = buttonModule.act(held, { kind: 'button', type: 'release', payload });
      expect(r.outcome, JSON.stringify(payload)).toBe('progress');
      expect(r.state).toBe(held);
    }
  });

  it('unknown action type or wrong module kind is ignored', () => {
    const s = stateOf('orange', 'GO');
    const r1 = buttonModule.act(s, act('smash', 1));
    expect(r1.outcome).toBe('progress');
    expect(r1.state).toBe(s);
    const r2 = buttonModule.act(s, { kind: 'wires', type: 'press', payload: { timerDigit: 1 } });
    expect(r2.outcome).toBe('progress');
    expect(r2.state).toBe(s);
  });

  it('a solved module ignores further actions', () => {
    const solved: ActResult = buttonModule.act(stateOf('orange', 'GO'), act('press', 0));
    expect(solved.state.solved).toBe(true);
    for (const a of [act('press', 0), act('hold', 0), act('release', 0)]) {
      const r = buttonModule.act(solved.state, a);
      expect(r.outcome).toBe('progress');
      expect(r.state).toBe(solved.state);
    }
  });

  it('act does not mutate the input state', () => {
    const s = stateOf('teal', 'STOP', 4);
    const before = JSON.stringify(s);
    buttonModule.act(s, act('hold', 0));
    buttonModule.act(s, act('press', 0));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('button module: solve', () => {
  it('solves every color/label/digit combination through act', () => {
    for (const color of COLORS) {
      for (const label of LABELS) {
        for (let digit = 0; digit <= 9; digit++) {
          let s = stateOf(color, label, digit);
          const actions = buttonModule.solve(s);
          let last: ActResult | undefined;
          for (const a of actions) {
            last = buttonModule.act(s, a);
            s = last.state;
          }
          expect(last?.outcome, `${color}/${label}/${digit}`).toBe('solved');
          expect(s.solved).toBe(true);
        }
      }
    }
  });

  it('tap-type solves with a single press, hold-type with hold then release', () => {
    expect(buttonModule.solve(stateOf('purple', 'WAIT')).map((a) => a.type)).toEqual(['press']);
    const hold = buttonModule.solve(stateOf('orange', 'WAIT', 6));
    expect(hold.map((a) => a.type)).toEqual(['hold', 'release']);
    expect(hold[1].payload).toEqual({ timerDigit: 6 });
  });

  it('seeded states are solved by solve', () => {
    for (let seed = 1; seed <= 50; seed++) {
      let s = buttonModule.init('b', createRng(seed), 3);
      let last: ActResult | undefined;
      for (const a of buttonModule.solve(s)) {
        last = buttonModule.act(s, a);
        s = last.state;
      }
      expect(last?.outcome, `seed ${seed}`).toBe('solved');
    }
  });
});

describe('button module: manual', () => {
  it('uses i18n keys only and lists five rules in order', () => {
    const m = buttonModule.manual();
    expect(m.kind).toBe('button');
    expect(m.titleKey).toBe('manual.button.title');
    expect(m.rules).toEqual([1, 2, 3, 4, 5].map((n) => `manual.button.rule.${n}`));
  });
});
