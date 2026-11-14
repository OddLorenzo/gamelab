import { describe, expect, it } from 'vitest';
import { createSession, MODULES, reduce } from '../../src/core/bomb';
import type { Session } from '../../src/core/bomb';
import { buildLevel } from '../../src/core/levels';
import { createRng } from '../../src/core/rng';
import type { ModuleKind, ModuleState } from '../../src/core/types';
import { projectView } from '../../src/core/views';
import type { DeafView } from '../../src/core/views';
import { glyphChar } from '../../src/ui/glyphs';
import { computeLayout, HUD_H, specsFromBlind, specsFromDeaf } from '../../src/ui/layout';
import type { ModuleLayout, Rect } from '../../src/ui/layout';
import { drawBlind, drawDeaf, drawPointers, WIRE_COLORS } from '../../src/ui/renderer';
import { formatClock } from '../../src/ui/timing';
import type { BlindView } from '../../src/core/views';
import { colorAssignments, deepFreeze, isGrey, recordingCtx, shapes, textCalls } from './recording-ctx';
import type { Call } from './recording-ctx';

const W = 375;
const H = 667;
const ASPECT = W / H;

const px = (r: Rect): Rect => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
const within = (x: number, y: number, r: Rect): boolean => x >= r.x - 1e-6 && x <= r.x + r.w + 1e-6 && y >= r.y - 1e-6 && y <= r.y + r.h + 1e-6;

const wiresState = (id: string, colors: string[], cut: number[] = [], solved = false): ModuleState => ({
  kind: 'wires',
  id,
  solved,
  data: { wires: colors.map((color, i) => ({ color, cut: cut.includes(i) })) },
});
const buttonState = (id: string, color: string, label: string, held = false, digit = 7, solved = false): ModuleState => ({
  kind: 'button',
  id,
  solved,
  data: { color, label, held, digit },
});
const symbolsState = (id: string, symbols: string[], next = 0, solved = false): ModuleState => ({
  kind: 'symbols',
  id,
  solved,
  data: { symbols, next },
});
const codeState = (id: string, serial: string, entered: string, solved = false): ModuleState => ({
  kind: 'code',
  id,
  solved,
  data: { serial, entered },
});

const deafView = (modules: ModuleState[], over: Partial<DeafView> = {}): DeafView => ({
  role: 'deaf',
  modules,
  msLeft: 125_000,
  strikesLeft: 2,
  status: 'playing',
  ...over,
});

const layoutOfDeaf = (view: DeafView): ModuleLayout[] => computeLayout(specsFromDeaf(view), ASPECT);

function renderDeaf(view: DeafView, msLeft: number | null = view.msLeft, extra: { pressedSlot?: { moduleId: string; slot: number } | null } = {}) {
  const { ctx, calls } = recordingCtx();
  drawDeaf(ctx, W, H, layoutOfDeaf(view), view, { msLeft, ...extra });
  return calls;
}

function renderBlind(view: BlindView, pressedSlot: { moduleId: string; slot: number } | null = null) {
  const { ctx, calls } = recordingCtx();
  drawBlind(ctx, W, H, computeLayout(specsFromBlind(view), ASPECT), { strikesLeft: view.strikesLeft, pressedSlot });
  return calls;
}

const sessionOf = (levelId: number, seed?: number): Session => createSession(seed === undefined ? buildLevel(levelId) : { ...buildLevel(levelId), seed });

describe('WIRE_COLORS', () => {
  it('has a distinct hex color for each of the five wire colors', () => {
    const names = ['red', 'blue', 'yellow', 'green', 'white'];
    expect(Object.keys(WIRE_COLORS).sort()).toEqual([...names].sort());
    for (const n of names) expect(WIRE_COLORS[n]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(new Set(Object.values(WIRE_COLORS)).size).toBe(5);
  });

  it('are readable on the dark bomb body and differ in lightness', () => {
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const values = Object.values(WIRE_COLORS).map(lum);
    for (const l of values) expect((l + 0.05) / (0.02 + 0.05)).toBeGreaterThanOrEqual(3); // vs a body of luminance ~0.02
    // no two colors share a lightness band: neighbours in lightness are at least 0.03 apart in luminance
    const sorted = [...values].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(0.03);
  });
});

describe('drawBlind', () => {
  const view = projectView(sessionOf(9), 'blind') as BlindView;

  it('assigns only greys to fillStyle and strokeStyle', () => {
    const calls = renderBlind(view, { moduleId: view.targets[0].moduleId, slot: 1 });
    const colors = colorAssignments(calls);
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect(isGrey(c), String(c)).toBe(true);
  });

  it('never draws text and never names a color', () => {
    const calls = renderBlind(view);
    expect(calls.filter((c) => c[0] === 'fillText' || c[0] === 'strokeText')).toEqual([]);
    const names = /\b(red|blue|yellow|green|white|orange|purple|pink|cyan|magenta)\b/i;
    for (const c of calls) expect(names.test(JSON.stringify(c)), JSON.stringify(c)).toBe(false);
    for (const c of calls.filter((x) => x[0] === 'set')) {
      expect(['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha']).toContain(c[1]);
    }
  });

  it('draws the same thing for two different bombs of the same kinds (colors, glyphs, serial never leak)', () => {
    const a = sessionOf(9, 11);
    const b = sessionOf(9, 987654);
    const deafA = JSON.stringify(projectView(a, 'deaf'));
    const deafB = JSON.stringify(projectView(b, 'deaf'));
    expect(deafA).not.toBe(deafB);
    const viewA = projectView(a, 'blind') as BlindView;
    const viewB = projectView(b, 'blind') as BlindView;
    expect(renderBlind(viewA)).toEqual(renderBlind(viewB));
    expect(renderBlind(viewA).length).toBeGreaterThan(20);
  });

  it('draws one shape on each slot', () => {
    const layout = computeLayout(specsFromBlind(view), ASPECT);
    const drawn = shapes(renderBlind(view));
    for (const m of layout) {
      m.slots.forEach((s, i) => {
        const r = px(s);
        const hit = drawn.some((sh) => sh.points.some(([x, y]) => within(x, y, r)));
        expect(hit, `${m.moduleId} slot ${i}`).toBe(true);
      });
    }
  });

  it('shows the strikes left as grey pips in the HUD band, count only', () => {
    for (const strikesLeft of [0, 1, 2, 3]) {
      const calls = renderBlind({ ...view, strikesLeft });
      const pips = shapes(calls).filter((s) => s.radii.length > 0 && s.points.every(([, y]) => y < HUD_H * H));
      expect(pips).toHaveLength(strikesLeft);
    }
  });

  it('shows the pressed slot differently', () => {
    const id = view.targets[0].moduleId;
    expect(renderBlind(view, { moduleId: id, slot: 0 })).not.toEqual(renderBlind(view));
    expect(renderBlind(view, { moduleId: id, slot: 0 })).not.toEqual(renderBlind(view, { moduleId: id, slot: 1 }));
  });

  it('draws nothing for a zero canvas, never throws, and does not mutate its inputs', () => {
    const frozen = deepFreeze(structuredClone(view));
    const layout = deepFreeze(computeLayout(specsFromBlind(frozen), ASPECT));
    const state = deepFreeze({ strikesLeft: 2, pressedSlot: { moduleId: frozen.targets[0].moduleId, slot: 0 } });
    for (const [w, h] of [
      [0, 0],
      [0, 600],
      [400, 0],
    ]) {
      const { ctx, calls } = recordingCtx();
      expect(() => drawBlind(ctx, w, h, layout, state)).not.toThrow();
      expect(calls).toEqual([]);
    }
    const { ctx } = recordingCtx();
    expect(() => drawBlind(ctx, W, H, layout, state)).not.toThrow();
  });
});

describe('drawDeaf: wires', () => {
  const colors = ['red', 'blue', 'yellow', 'green', 'white'];

  it('draws wire i in its color inside slot i (wire 0 at the top)', () => {
    const view = deafView([wiresState('w', colors)]);
    const layout = layoutOfDeaf(view);
    const drawn = shapes(renderDeaf(view)).filter((s) => s.op === 'stroke');
    colors.forEach((color, i) => {
      const r = px(layout[0].slots[i]);
      const mine = drawn.filter((s) => s.style === WIRE_COLORS[color] && s.points.length > 0 && s.points.every(([x, y]) => within(x, y, r)));
      expect(mine.length, `wire ${i} ${color}`).toBeGreaterThan(0);
    });
  });

  it('draws a different pattern per color (not only a different color)', () => {
    const sig = (color: string): string => {
      const calls = renderDeaf(deafView([wiresState('w', [color, 'red', 'red'])]), null);
      const swap = new Set<unknown>(Object.values(WIRE_COLORS));
      return JSON.stringify(
        calls.map((c) => (c[0] === 'set' && swap.has(c[2]) ? [c[0], c[1], 'COLOR'] : c)),
      );
    };
    const patterns = new Set(colors.map(sig));
    // red is the reference solid wire; every color has its own pattern
    expect(patterns.size).toBe(colors.length);
  });

  it('draws a cut wire visibly cut: its colored strokes never cross the middle of the slot', () => {
    const intactView = deafView([wiresState('w', ['red', 'blue', 'yellow'])]);
    const cutView = deafView([wiresState('w', ['red', 'blue', 'yellow'], [1])]);
    const layout = layoutOfDeaf(cutView);
    const r = px(layout[0].slots[1]);
    const mid = r.x + r.w / 2;
    const spans = (calls: Call[]): boolean =>
      shapes(calls).some(
        (s) =>
          s.op === 'stroke' &&
          s.style === WIRE_COLORS['blue'] &&
          s.points.some(([x, y]) => within(x, y, r) && x < mid - 1) &&
          s.points.some(([x, y]) => within(x, y, r) && x > mid + 1),
      );
    expect(spans(renderDeaf(intactView))).toBe(true);
    expect(spans(renderDeaf(cutView))).toBe(false);
    expect(renderDeaf(cutView)).not.toEqual(renderDeaf(intactView));
    // the cut wire still shows its color on both halves
    const halves = shapes(renderDeaf(cutView)).filter((s) => s.style === WIRE_COLORS['blue'] && s.points.some(([x, y]) => within(x, y, r)));
    expect(halves.some((s) => s.points.some(([x]) => x < mid))).toBe(true);
    expect(halves.some((s) => s.points.some(([x]) => x > mid))).toBe(true);
  });
});

describe('drawDeaf: button', () => {
  it.each(['HOLD', 'PRESS', 'ABORT'])('draws the raw label %s and the digit inside the button frame', (label) => {
    const view = deafView([buttonState('b', 'blue', label, false, 6)]);
    const frame = px(layoutOfDeaf(view)[0].frame);
    const texts = textCalls(renderDeaf(view)).filter((t) => within(t.x, t.y, frame));
    expect(texts.filter((t) => t.text === label)).toHaveLength(1);
    expect(texts.filter((t) => t.text === '6')).toHaveLength(1);
  });

  it('draws a circle in the button color on the single slot', () => {
    for (const color of ['red', 'blue', 'yellow', 'white']) {
      const view = deafView([buttonState('b', color, 'HOLD')]);
      const slot = px(layoutOfDeaf(view)[0].slots[0]);
      const disc = shapes(renderDeaf(view)).filter(
        (s) => s.op === 'fill' && s.style === WIRE_COLORS[color] && s.radii.length > 0 && within(s.points[0][0], s.points[0][1], slot),
      );
      expect(disc.length, color).toBe(1);
      expect(disc[0].radii[0]).toBeGreaterThan(slot.w * 0.3);
    }
  });

  it('shows a held ring only while held', () => {
    const idle = renderDeaf(deafView([buttonState('b', 'red', 'PRESS', false)]));
    const held = renderDeaf(deafView([buttonState('b', 'red', 'PRESS', true)]));
    expect(held).not.toEqual(idle);
    const ringCount = (calls: Call[]): number => shapes(calls).filter((s) => s.op === 'stroke' && s.radii.length > 0).length;
    expect(ringCount(held)).toBeGreaterThan(ringCount(idle));
  });
});

describe('drawDeaf: symbols', () => {
  const symbols = ['star', 'moon', 'gear', 'key'];

  it('draws glyph i in slot i (reading order)', () => {
    const view = deafView([symbolsState('s', symbols)]);
    const layout = layoutOfDeaf(view);
    const texts = textCalls(renderDeaf(view));
    symbols.forEach((id, i) => {
      const r = px(layout[0].slots[i]);
      expect(texts.filter((t) => t.text === glyphChar(id) && within(t.x, t.y, r)), `slot ${i}`).toHaveLength(1);
    });
  });

  it('shows the progress as `next` filled dots out of 4', () => {
    for (const next of [0, 1, 2, 3, 4]) {
      const view = deafView([symbolsState('s', symbols, next)]);
      const display = px(layoutOfDeaf(view)[0].display as Rect);
      const dots = shapes(renderDeaf(view)).filter((s) => s.radii.length > 0 && within(s.points[0][0], s.points[0][1], display));
      expect(dots).toHaveLength(4);
      expect(dots.filter((d) => d.op === 'fill')).toHaveLength(next);
    }
  });
});

describe('drawDeaf: code', () => {
  const serial = 'K7H2QP';

  it('draws the serial exactly once, in the display band', () => {
    const view = deafView([codeState('c', serial, '')]);
    const layout = layoutOfDeaf(view);
    const display = px(layout[0].display as Rect);
    const texts = textCalls(renderDeaf(view));
    expect(texts.filter((t) => t.text === serial)).toHaveLength(1);
    expect(texts.filter((t) => t.text === serial).every((t) => within(t.x, t.y, display))).toBe(true);
  });

  it('shows the entered digits in the display band, in order', () => {
    for (const entered of ['', '4', '4081', '90']) {
      const view = deafView([codeState('c', serial, entered)]);
      const display = px(layoutOfDeaf(view)[0].display as Rect);
      const inBand = textCalls(renderDeaf(view)).filter((t) => within(t.x, t.y, display) && t.text !== serial);
      const ordered = [...inBand].sort((a, b) => a.x - b.x);
      expect(ordered.map((t) => t.text).join(''), `entered "${entered}"`).toBe(entered);
    }
  });

  it('draws the keypad keys with their text on the slots: digit d on slot d, C on clear, OK on submit', () => {
    const view = deafView([codeState('c', serial, '')]);
    const layout = layoutOfDeaf(view);
    const texts = textCalls(renderDeaf(view));
    for (let slot = 0; slot < 12; slot++) {
      const want = slot < 10 ? String(slot) : slot === 10 ? 'C' : 'OK';
      const r = px(layout[0].slots[slot]);
      expect(texts.filter((t) => t.text === want && within(t.x, t.y, r)), `slot ${slot}`).toHaveLength(1);
    }
  });
});

describe('drawDeaf: HUD', () => {
  const view = deafView([buttonState('b', 'red', 'HOLD')]);

  it('draws the clock as formatClock(msLeft), once', () => {
    for (const ms of [125_000, 59_999, 600_000, 0]) {
      const texts = textCalls(renderDeaf(view, ms)).filter((t) => t.text === formatClock(ms));
      expect(texts, String(ms)).toHaveLength(1);
      expect(texts[0].y).toBeLessThan(HUD_H * H);
    }
  });

  it('with msLeft null draws no clock and does not throw', () => {
    const texts = textCalls(renderDeaf(view, null));
    expect(texts.filter((t) => /^\d+:\d\d$/.test(t.text))).toEqual([]);
  });

  it('draws the strikes left as pips plus the number', () => {
    for (const strikesLeft of [0, 1, 2, 3]) {
      const v = deafView([buttonState('b', 'red', 'HOLD')], { strikesLeft });
      const calls = renderDeaf(v);
      const pips = shapes(calls).filter((s) => s.radii.length > 0 && s.points.every(([, y]) => y < HUD_H * H));
      expect(pips, `strikes ${strikesLeft}`).toHaveLength(strikesLeft);
      const inBand = textCalls(calls).filter((t) => t.y < HUD_H * H);
      expect(inBand.some((t) => t.text === String(strikesLeft))).toBe(true);
    }
  });
});

describe('drawDeaf: solved modules, pressed slot', () => {
  it('draws a solved module dimmed (globalAlpha) and an unsolved one not', () => {
    const open = renderDeaf(deafView([buttonState('b', 'red', 'HOLD', false, 3, false)]));
    const done = renderDeaf(deafView([buttonState('b', 'red', 'HOLD', false, 3, true)]));
    expect(open.some((c) => c[0] === 'set' && c[1] === 'globalAlpha')).toBe(false);
    expect(done.some((c) => c[0] === 'set' && c[1] === 'globalAlpha' && (c[2] as number) < 1)).toBe(true);
  });

  it('highlights the slot the blind player is pressing', () => {
    const view = deafView([wiresState('w', ['red', 'blue', 'green'])]);
    const base = renderDeaf(view);
    const pressed = renderDeaf(view, view.msLeft, { pressedSlot: { moduleId: 'w', slot: 2 } });
    expect(pressed).not.toEqual(base);
    expect(renderDeaf(view, view.msLeft, { pressedSlot: { moduleId: 'w', slot: 1 } })).not.toEqual(pressed);
  });
});

describe('drawDeaf: robustness', () => {
  const view = projectView(sessionOf(9), 'deaf') as DeafView;

  it('draws nothing for a zero canvas', () => {
    for (const [w, h] of [
      [0, 0],
      [0, 600],
      [400, 0],
    ]) {
      const { ctx, calls } = recordingCtx();
      expect(() => drawDeaf(ctx, w, h, layoutOfDeaf(view), view, { msLeft: 1000 })).not.toThrow();
      expect(calls).toEqual([]);
    }
  });

  it('does not mutate the view, the layout or the extra argument', () => {
    const frozenView = deepFreeze(structuredClone(view));
    const layout = deepFreeze(layoutOfDeaf(frozenView));
    const extra = deepFreeze({ msLeft: 90_000 as number | null, pressedSlot: { moduleId: frozenView.modules[0].id, slot: 0 } });
    const { ctx } = recordingCtx();
    expect(() => drawDeaf(ctx, W, H, layout, frozenView, extra)).not.toThrow();
  });

  it('ignores a layout entry whose module is not in the view, and a module with no layout', () => {
    const { ctx } = recordingCtx();
    const layout = computeLayout([{ moduleId: 'ghost', kind: 'wires', slots: 4 }], ASPECT);
    expect(() => drawDeaf(ctx, W, H, layout, view, { msLeft: 5000 })).not.toThrow();
    expect(() => drawDeaf(ctx, W, H, [], view, { msLeft: 5000 })).not.toThrow();
  });
});

describe('drawPointers', () => {
  const pointers = [
    { id: 'a', x: 0.25, y: 0.5, color: '#e5484d' },
    { id: 'b', x: 1, y: 0, color: '#3e63dd' },
  ];

  it('draws one dot per pointer at its normalized position, in its color', () => {
    const { ctx, calls } = recordingCtx();
    drawPointers(ctx, 400, 800, pointers, { greyscale: false });
    const dots = shapes(calls).filter((s) => s.op === 'fill' && s.radii.length > 0);
    expect(dots).toHaveLength(2);
    expect(dots[0].points[0]).toEqual([100, 400]);
    expect(dots[1].points[0]).toEqual([400, 0]);
    expect(dots[0].style).toBe('#e5484d');
    expect(dots[1].style).toBe('#3e63dd');
  });

  it('greyscale mode assigns only greys and draws no text', () => {
    const { ctx, calls } = recordingCtx();
    drawPointers(ctx, 400, 800, pointers, { greyscale: true });
    const colors = colorAssignments(calls);
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect(isGrey(c), String(c)).toBe(true);
    expect(textCalls(calls)).toEqual([]);
    expect(shapes(calls).filter((s) => s.op === 'fill' && s.radii.length > 0)).toHaveLength(2);
  });

  it('draws nothing for no pointers or a zero canvas; skips non-finite positions', () => {
    const a = recordingCtx();
    drawPointers(a.ctx, 400, 800, [], { greyscale: false });
    expect(a.calls).toEqual([]);
    const b = recordingCtx();
    drawPointers(b.ctx, 0, 0, pointers, { greyscale: false });
    expect(b.calls).toEqual([]);
    const c = recordingCtx();
    expect(() => drawPointers(c.ctx, 400, 800, [{ id: 'x', x: Number.NaN, y: 0.5, color: '#fff' }], { greyscale: false })).not.toThrow();
    expect(shapes(c.calls).filter((s) => s.op === 'fill' && s.radii.length > 0)).toHaveLength(0);
  });

  it('does not mutate the pointers', () => {
    const { ctx } = recordingCtx();
    expect(() => drawPointers(ctx, 400, 800, deepFreeze(structuredClone(pointers)), { greyscale: true })).not.toThrow();
  });
});

describe('never throws, for any state the core can produce', () => {
  const KINDS: ModuleKind[] = ['wires', 'button', 'symbols', 'code'];

  function randomSession(seed: number): Session {
    const rng = createRng(seed);
    const kinds = KINDS.filter(() => rng.int(3) > 0);
    const def = {
      ...buildLevel(1 + rng.int(10)),
      seed,
      moduleKinds: kinds.length > 0 ? kinds : [rng.pick(KINDS)],
      difficulty: 1 + rng.int(5),
      strikes: 1 + rng.int(3),
    };
    let s = createSession(def);
    for (const m of [...s.modules]) {
      const mode = rng.int(4);
      if (mode === 0) continue;
      const actions = MODULES[m.kind].solve(m);
      const used = mode === 1 ? actions : actions.slice(0, rng.int(actions.length + 1));
      for (const action of used) s = reduce(s, { type: 'act', role: 'blind', moduleId: m.id, action });
      const extra =
        m.kind === 'wires'
          ? { kind: m.kind, type: 'cut', payload: { index: rng.int(6) } }
          : m.kind === 'button'
            ? { kind: m.kind, type: 'hold' }
            : m.kind === 'symbols'
              ? { kind: m.kind, type: 'tap', payload: { slot: rng.int(4) } }
              : { kind: m.kind, type: 'digit', payload: { d: rng.int(10) } };
      s = reduce(s, { type: 'act', role: 'blind', moduleId: m.id, action: extra });
    }
    return s;
  }

  it('over 200 random sessions, both draw functions, at phone and desktop size', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const session = randomSession(seed);
      const deaf = projectView(session, 'deaf') as DeafView;
      const blind = projectView(session, 'blind') as BlindView;
      const rng = createRng(seed * 31);
      for (const [w, h] of [
        [375, 667],
        [1280, 720],
      ]) {
        const target = blind.targets[rng.int(blind.targets.length)];
        const pressed = rng.int(2) === 0 ? null : { moduleId: target.moduleId, slot: rng.int(target.slots) };
        const layout = computeLayout(specsFromDeaf(deaf), w / h);
        const b = recordingCtx();
        expect(() => drawBlind(b.ctx, w, h, computeLayout(specsFromBlind(blind), w / h), { strikesLeft: blind.strikesLeft, pressedSlot: pressed })).not.toThrow();
        for (const c of colorAssignments(b.calls)) expect(isGrey(c)).toBe(true);
        expect(textCalls(b.calls)).toEqual([]);
        const d = recordingCtx();
        expect(() => drawDeaf(d.ctx, w, h, layout, deaf, { msLeft: rng.int(2) === 0 ? null : deaf.msLeft, pressedSlot: pressed })).not.toThrow();
        expect(d.calls.length).toBeGreaterThan(10);
      }
    }
  });
});
