import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonModule, needsHold } from '../../src/core/modules/button';
import { codeModule } from '../../src/core/modules/code';
import { symbolsModule } from '../../src/core/modules/symbols';
import { correctIndex, wiresModule } from '../../src/core/modules/wires';
import type { Wire } from '../../src/core/modules/wires';
import { createRng } from '../../src/core/rng';
import type { ModuleAction, ModuleKind, ModuleState } from '../../src/core/types';
import { ButtonGesture, createThrottle, hitTest, slotAction, toNormalized } from '../../src/ui/input';

const RECT = { left: 100, top: 50, width: 200, height: 400 };

describe('toNormalized', () => {
  it('maps the rect center to (0.5, 0.5) and the corners to 0 and 1', () => {
    expect(toNormalized({ clientX: 200, clientY: 250 }, RECT)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNormalized({ clientX: 100, clientY: 50 }, RECT)).toEqual({ x: 0, y: 0 });
    expect(toNormalized({ clientX: 300, clientY: 450 }, RECT)).toEqual({ x: 1, y: 1 });
    expect(toNormalized({ clientX: 150, clientY: 150 }, RECT)).toEqual({ x: 0.25, y: 0.25 });
  });

  it('clamps points outside the rect to 0..1 per axis', () => {
    expect(toNormalized({ clientX: -500, clientY: 250 }, RECT)).toEqual({ x: 0, y: 0.5 });
    expect(toNormalized({ clientX: 9999, clientY: 250 }, RECT)).toEqual({ x: 1, y: 0.5 });
    expect(toNormalized({ clientX: 200, clientY: -1 }, RECT)).toEqual({ x: 0.5, y: 0 });
    expect(toNormalized({ clientX: 200, clientY: 10_000 }, RECT)).toEqual({ x: 0.5, y: 1 });
  });

  it('gives 0 (never NaN or Infinity) for a zero or negative size, per axis', () => {
    expect(toNormalized({ clientX: 5, clientY: 5 }, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
    expect(toNormalized({ clientX: 5, clientY: 5 }, { left: 0, top: 0, width: -10, height: -10 })).toEqual({ x: 0, y: 0 });
    expect(toNormalized({ clientX: 150, clientY: 250 }, { left: 100, top: 50, width: 0, height: 400 })).toEqual({ x: 0, y: 0.5 });
    expect(toNormalized({ clientX: 150, clientY: 250 }, { left: 100, top: 50, width: 200, height: 0 })).toEqual({ x: 0.25, y: 0 });
  });

  it('gives 0 for a NaN coordinate', () => {
    expect(toNormalized({ clientX: NaN, clientY: NaN }, RECT)).toEqual({ x: 0, y: 0 });
  });
});

describe('hitTest', () => {
  const layout = [
    {
      moduleId: 'm1',
      slots: [
        { x: 0, y: 0, w: 0.25, h: 0.25 },
        { x: 0.25, y: 0, w: 0.25, h: 0.25 },
        { x: 0.5, y: 0, w: 0.25, h: 0.25 },
      ],
    },
    { moduleId: 'm2', slots: [{ x: 0, y: 0.5, w: 0.5, h: 0.5 }] },
  ];

  it('returns the module and slot index of the rect holding the point', () => {
    expect(hitTest(layout, { x: 0.6, y: 0.1 })).toEqual({ moduleId: 'm1', slot: 2 });
    expect(hitTest(layout, { x: 0.1, y: 0.1 })).toEqual({ moduleId: 'm1', slot: 0 });
    expect(hitTest(layout, { x: 0.3, y: 0.2 })).toEqual({ moduleId: 'm1', slot: 1 });
    expect(hitTest(layout, { x: 0.2, y: 0.7 })).toEqual({ moduleId: 'm2', slot: 0 });
  });

  it('returns null outside every rect and for an empty layout', () => {
    expect(hitTest(layout, { x: 0.9, y: 0.1 })).toBeNull();
    expect(hitTest(layout, { x: 0.1, y: 0.4 })).toBeNull();
    expect(hitTest(layout, { x: 0.9, y: 0.9 })).toBeNull();
    expect(hitTest([], { x: 0.5, y: 0.5 })).toBeNull();
    expect(hitTest([{ moduleId: 'e', slots: [] }], { x: 0.5, y: 0.5 })).toBeNull();
  });

  it('is inclusive on the top and left edges and exclusive on the bottom and right edges', () => {
    const r = [{ moduleId: 'a', slots: [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }] }];
    expect(hitTest(r, { x: 0.25, y: 0.25 })).toEqual({ moduleId: 'a', slot: 0 });
    expect(hitTest(r, { x: 0.25, y: 0.5 })).toEqual({ moduleId: 'a', slot: 0 });
    expect(hitTest(r, { x: 0.5, y: 0.25 })).toEqual({ moduleId: 'a', slot: 0 });
    expect(hitTest(r, { x: 0.75, y: 0.5 })).toBeNull();
    expect(hitTest(r, { x: 0.5, y: 0.75 })).toBeNull();
    expect(hitTest(r, { x: 0.75, y: 0.75 })).toBeNull();
    expect(hitTest(r, { x: 0.2499, y: 0.5 })).toBeNull();
    expect(hitTest(r, { x: 0.5, y: 0.2499 })).toBeNull();
  });

  it('on overlap the first match wins, in layout order then slot order', () => {
    const overlap = [
      { moduleId: 'first', slots: [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }] },
      { moduleId: 'second', slots: [{ x: 0, y: 0, w: 1, h: 1 }] },
    ];
    expect(hitTest(overlap, { x: 0.5, y: 0.5 })).toEqual({ moduleId: 'first', slot: 0 });
    const slotOrder = [{ moduleId: 'm', slots: [{ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }] }];
    expect(hitTest(slotOrder, { x: 0.15, y: 0.15 })).toEqual({ moduleId: 'm', slot: 0 });
    expect(hitTest(slotOrder, { x: 0.3, y: 0.3 })).toEqual({ moduleId: 'm', slot: 1 });
  });
});

describe('slotAction', () => {
  it('maps wire slots to a cut at that index (positions 0..5 exist, nothing else)', () => {
    for (let i = 0; i < 6; i++) {
      expect(slotAction('wires', i)).toEqual({ kind: 'wires', type: 'cut', payload: { index: i } });
    }
    expect(slotAction('wires', 6)).toBeNull();
    expect(slotAction('wires', -1)).toBeNull();
    expect(slotAction('wires', 1.5)).toBeNull();
    expect(slotAction('wires', NaN)).toBeNull();
  });

  it('maps symbol slots 0..3 to a tap and everything else to null', () => {
    for (let i = 0; i < 4; i++) {
      expect(slotAction('symbols', i)).toEqual({ kind: 'symbols', type: 'tap', payload: { slot: i } });
    }
    expect(slotAction('symbols', 4)).toBeNull();
    expect(slotAction('symbols', -1)).toBeNull();
    expect(slotAction('symbols', 0.5)).toBeNull();
  });

  it('maps code slots 0-9 to digits, 10 to clear, 11 to submit, and everything else to null', () => {
    for (let d = 0; d < 10; d++) {
      expect(slotAction('code', d)).toEqual({ kind: 'code', type: 'digit', payload: { d } });
    }
    expect(slotAction('code', 10)).toEqual({ kind: 'code', type: 'clear' });
    expect(slotAction('code', 11)).toEqual({ kind: 'code', type: 'submit' });
    expect(slotAction('code', 12)).toBeNull();
    expect(slotAction('code', -1)).toBeNull();
    expect(slotAction('code', 1.5)).toBeNull();
    expect(slotAction('code', NaN)).toBeNull();
  });

  it('has no tap mapping for the button (it uses ButtonGesture)', () => {
    for (const slot of [0, 1, -1]) expect(slotAction('button', slot)).toBeNull();
  });

  const fresh = (kind: ModuleKind, seed: number): ModuleState => {
    const mod = { wires: wiresModule, symbols: symbolsModule, code: codeModule, button: buttonModule }[kind];
    return mod.init('m', createRng(seed), 5);
  };
  const MODS = { wires: wiresModule, symbols: symbolsModule, code: codeModule, button: buttonModule };

  it('every action it makes is a real module action: same shape as what the module itself solves with', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const w = fresh('wires', seed);
      const idx = correctIndex(w.data['wires'] as Wire[]);
      expect(slotAction('wires', idx)).toEqual(wiresModule.solve(w)[0]);

      const s = fresh('symbols', seed);
      const order = s.data['order'] as number[];
      expect(order.map((slot) => slotAction('symbols', slot))).toEqual(symbolsModule.solve(s));

      const c = fresh('code', seed);
      const target = c.data['target'] as string;
      const viaSlots = [...target].map((ch) => slotAction('code', Number(ch)));
      viaSlots.push(slotAction('code', 11));
      expect(viaSlots).toEqual(codeModule.solve(c));
    }
  });

  it('every produced action is accepted by the real module act and solves the module end to end', () => {
    for (let seed = 1; seed <= 30; seed++) {
      // wires: cutting the right position solves, any other position is a counted strike
      const w = fresh('wires', seed);
      const wireCount = (w.data['wires'] as Wire[]).length;
      const good = correctIndex(w.data['wires'] as Wire[]);
      for (let i = 0; i < wireCount; i++) {
        const action = slotAction('wires', i) as ModuleAction;
        expect(() => wiresModule.act(w, action)).not.toThrow();
        expect(wiresModule.act(w, action).outcome).toBe(i === good ? 'solved' : 'strike');
      }

      // symbols: tapping the slots in the module's own order solves it
      let s = fresh('symbols', seed);
      let last = 'progress';
      for (const slot of s.data['order'] as number[]) {
        const r = symbolsModule.act(s, slotAction('symbols', slot) as ModuleAction);
        s = r.state;
        last = r.outcome;
      }
      expect(last).toBe('solved');
      expect(s.solved).toBe(true);

      // code: digit slots then submit solves it, clear wipes what was typed
      let c = fresh('code', seed);
      for (const ch of c.data['target'] as string) {
        c = codeModule.act(c, slotAction('code', Number(ch)) as ModuleAction).state;
      }
      expect(c.data['entered']).toBe(c.data['target']);
      const cleared = codeModule.act(c, slotAction('code', 10) as ModuleAction);
      expect(cleared.state.data['entered']).toBe('');
      expect(cleared.outcome).toBe('progress');
      const submitted = codeModule.act(c, slotAction('code', 11) as ModuleAction);
      expect(submitted.outcome).toBe('solved');
    }
    // every slotAction kind is known to the module table above
    expect(Object.keys(MODS).sort()).toEqual(['button', 'code', 'symbols', 'wires']);
  });
});

/* ---------------------------------------------------------------- ButtonGesture */

interface GestureRig {
  gesture: ButtonGesture;
  actions: ModuleAction[];
}

const rig = (): GestureRig => {
  const actions: ModuleAction[] = [];
  const gesture = new ButtonGesture({
    emit: (a) => actions.push(a),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return { gesture, actions };
};

describe('ButtonGesture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a quick tap emits one press on release and nothing before', () => {
    const { gesture, actions } = rig();
    gesture.down();
    expect(actions).toEqual([]);
    vi.advanceTimersByTime(299);
    expect(actions).toEqual([]);
    gesture.up();
    expect(actions).toEqual([{ kind: 'button', type: 'press' }]);
    vi.advanceTimersByTime(5000);
    expect(actions).toHaveLength(1);
  });

  it('a hold emits hold exactly once at 300 ms, then release (any timerDigit) on up', () => {
    const { gesture, actions } = rig();
    gesture.down();
    vi.advanceTimersByTime(299);
    expect(actions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(actions).toEqual([{ kind: 'button', type: 'hold' }]);
    vi.advanceTimersByTime(10_000);
    expect(actions).toHaveLength(1);
    gesture.up();
    expect(actions).toEqual([
      { kind: 'button', type: 'hold' },
      { kind: 'button', type: 'release', payload: { timerDigit: 0 } },
    ]);
  });

  it('cancel before the threshold emits nothing and the timer never fires', () => {
    const { gesture, actions } = rig();
    gesture.down();
    vi.advanceTimersByTime(299);
    gesture.cancel();
    vi.advanceTimersByTime(5000);
    expect(actions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel after the hold emits a release, once', () => {
    const { gesture, actions } = rig();
    gesture.down();
    vi.advanceTimersByTime(400);
    gesture.cancel();
    expect(actions).toEqual([
      { kind: 'button', type: 'hold' },
      { kind: 'button', type: 'release', payload: { timerDigit: 0 } },
    ]);
    gesture.cancel();
    gesture.up();
    expect(actions).toHaveLength(2);
  });

  it('never double-emits: up without down, repeated up, and a second down while down are ignored', () => {
    const { gesture, actions } = rig();
    gesture.up();
    gesture.cancel();
    expect(actions).toEqual([]);
    gesture.down();
    gesture.down();
    vi.advanceTimersByTime(300);
    expect(actions).toEqual([{ kind: 'button', type: 'hold' }]);
    gesture.down();
    vi.advanceTimersByTime(1000);
    expect(actions).toHaveLength(1);
    gesture.up();
    gesture.up();
    expect(actions.map((a) => a.type)).toEqual(['hold', 'release']);
  });

  it('can be used again after a tap, a hold and a cancel', () => {
    const { gesture, actions } = rig();
    gesture.down();
    gesture.up();
    gesture.down();
    vi.advanceTimersByTime(300);
    gesture.up();
    gesture.down();
    gesture.cancel();
    gesture.down();
    gesture.up();
    expect(actions.map((a) => a.type)).toEqual(['press', 'hold', 'release', 'press']);
  });

  it('destroy clears a pending hold timer', () => {
    const { gesture, actions } = rig();
    gesture.down();
    gesture.destroy();
    vi.advanceTimersByTime(1000);
    expect(actions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** The host overwrites timerDigit with the real seconds digit; the test plays the host. */
  const play = (state: ModuleState, gestureFor: (g: ButtonGesture) => void): { state: ModuleState; outcomes: string[] } => {
    let s = state;
    const outcomes: string[] = [];
    const digit = s.data['digit'] as number;
    const g = new ButtonGesture({
      emit: (a) => {
        const real = a.type === 'release' ? { ...a, payload: { ...a.payload, timerDigit: digit } } : a;
        const r = buttonModule.act(s, real);
        s = r.state;
        outcomes.push(r.outcome);
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    gestureFor(g);
    return { state: s, outcomes };
  };

  const seeded = (wantHold: boolean): ModuleState => {
    for (let seed = 1; seed < 500; seed++) {
      const s = buttonModule.init('b', createRng(seed), 1);
      if (needsHold(s.data['color'] as never, s.data['label'] as never) === wantHold) return s;
    }
    throw new Error('no button state found');
  };

  it('a tap solves a tap-type button and strikes a hold-type one', () => {
    const tapType = seeded(false);
    const solved = play(tapType, (g) => {
      g.down();
      g.up();
    });
    expect(solved.outcomes).toEqual(['solved']);
    expect(solved.state.solved).toBe(true);

    const holdType = seeded(true);
    const struck = play(holdType, (g) => {
      g.down();
      g.up();
    });
    expect(struck.outcomes).toEqual(['strike']);
    expect(struck.state.solved).toBe(false);
  });

  it('a hold solves a hold-type button once the host supplies the right digit, and strikes a tap-type one', () => {
    const holdType = seeded(true);
    const solved = play(holdType, (g) => {
      g.down();
      vi.advanceTimersByTime(300);
      g.up();
    });
    expect(solved.outcomes).toEqual(['progress', 'solved']);
    expect(solved.state.solved).toBe(true);

    const tapType = seeded(false);
    const struck = play(tapType, (g) => {
      g.down();
      vi.advanceTimersByTime(300);
      g.up();
    });
    expect(struck.outcomes).toEqual(['progress', 'strike']);
    expect(struck.state.solved).toBe(false);
  });

  it('a cancel while holding also ends the hold (the module is never left held)', () => {
    const holdType = seeded(true);
    const r = play(holdType, (g) => {
      g.down();
      vi.advanceTimersByTime(500);
      g.cancel();
    });
    expect(r.outcomes).toEqual(['progress', 'solved']);
    expect(r.state.data['held']).toBe(false);
  });
});

describe('createThrottle', () => {
  it('runs the first call at once (leading edge) and ignores calls inside the window', () => {
    let t = 1000;
    const run = createThrottle(50, () => t);
    const fn = vi.fn();
    run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    t = 1010;
    run(fn);
    t = 1049;
    run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs again at exactly 50 ms and counts the next window from that run', () => {
    let t = 0;
    const run = createThrottle(50, () => t);
    const fn = vi.fn();
    run(fn);
    t = 50;
    run(fn);
    expect(fn).toHaveBeenCalledTimes(2);
    t = 99;
    run(fn);
    expect(fn).toHaveBeenCalledTimes(2);
    t = 100;
    run(fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('has no trailing edge: a dropped call is never replayed later', () => {
    let t = 0;
    const run = createThrottle(50, () => t);
    const fn = vi.fn();
    run(fn);
    t = 10;
    run(fn);
    t = 5000;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes each call its own function: the dropped one is not called, the next one is', () => {
    let t = 0;
    const run = createThrottle(50, () => t);
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    run(a);
    t = 20;
    run(b);
    t = 60;
    run(c);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('survives a clock that goes backwards (the window re-opens)', () => {
    let t = 1000;
    const run = createThrottle(50, () => t);
    const fn = vi.fn();
    run(fn);
    t = 10;
    run(fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
