import type { ModuleKind } from '../core/types';
import type { BlindView, DeafView } from '../core/views';

/** Rectangle in normalized canvas coordinates: 0..1 on both axes, y down. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ModuleSpec {
  moduleId: string;
  kind: ModuleKind;
  slots: number;
}

export interface ModuleLayout {
  moduleId: string;
  kind: ModuleKind;
  frame: Rect;
  /**
   * Band inside the frame that holds no slot: the code module's serial and entered digits, the
   * symbols module's progress dots. Null for wires and button. Same geometry for every player.
   */
  display: Rect | null;
  /** One rect per slot, directly usable as `hitTest` input together with `moduleId`. */
  slots: Rect[];
}

/**
 * Top band of the canvas (fraction of its height) kept free for the HUD: the clock and the
 * strikes. No module frame or slot starts above it.
 */
export const HUD_H = 0.07;

// All lengths below are fractions of the canvas HEIGHT, so a gap is as many pixels sideways as
// it is vertically. Small on purpose: on a 375x667 phone with four modules every pixel counts
// towards the 44 px touch size.
const MARGIN = 0.008;
const FRAME_GAP = 0.008;
const FRAME_PAD = 0.008;
const WIRE_GAP = 0.003;
const GRID_GAP = 0.005;
const CODE_DISPLAY = 0.2; // share of the frame's inner height
const SYMBOLS_DISPLAY = 0.1;
const CODE_ROWS = 4;
const CODE_COLS = 3;

/** Phone keypad, row by row, as slot numbers: digit d is slot d, clear 10, submit 11. */
const KEYPAD: readonly (readonly number[])[] = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
  [10, 0, 11],
];

const CODE_SLOTS = 12;
const SYMBOL_SLOTS = 4;

/**
 * Slots of a module kind. wires: the wire count, given as a number, an array of wires, or the
 * module data object (`{ wires: [...] }`); anything else gives 0. button 1, symbols 4, code 12.
 */
export function slotCount(kind: ModuleKind, data?: unknown): number {
  switch (kind) {
    case 'wires':
      if (typeof data === 'number') return Number.isInteger(data) && data > 0 ? data : 0;
      if (Array.isArray(data)) return data.length;
      if (typeof data === 'object' && data !== null) {
        const wires = (data as { wires?: unknown }).wires;
        return Array.isArray(wires) ? wires.length : 0;
      }
      return 0;
    case 'button':
      return 1;
    case 'symbols':
      return SYMBOL_SLOTS;
    case 'code':
      return CODE_SLOTS;
  }
}

export function specsFromBlind(view: BlindView): ModuleSpec[] {
  return view.targets.map((t) => ({ moduleId: t.moduleId, kind: t.kind, slots: t.slots }));
}

/** Same specs as `specsFromBlind` for the same bomb, so the deaf player sees the blind player's geometry. */
export function specsFromDeaf(view: DeafView): ModuleSpec[] {
  return view.modules.map((m) => ({ moduleId: m.id, kind: m.kind, slots: slotCount(m.kind, m.data) }));
}

// Working space: height 1, width = aspect. Normalized at the very end.
interface U {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inset = (r: U, d: number): U => ({ x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) });

/**
 * Frames in a grid: 1 full; 2 always stacked (one above the other, whatever the aspect); 3+ two
 * per row, a lone last one spans the row. The arrangement never depends on the aspect: the
 * pointer a player shares travels as 0..1 canvas coordinates, so every device must put the same
 * module in the same part of the canvas.
 */
function frames(n: number, area: U): U[] {
  if (n <= 0) return [];
  if (n === 1) return [area];
  if (n === 2) {
    const h = (area.h - FRAME_GAP) / 2;
    return [0, 1].map((i) => ({ x: area.x, y: area.y + i * (h + FRAME_GAP), w: area.w, h }));
  }
  const rows = Math.ceil(n / 2);
  const h = (area.h - (rows - 1) * FRAME_GAP) / rows;
  const half = (area.w - FRAME_GAP) / 2;
  const out: U[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 2);
    const y = area.y + row * (h + FRAME_GAP);
    const lone = i === n - 1 && n % 2 === 1;
    out.push(lone ? { x: area.x, y, w: area.w, h } : { x: area.x + (i % 2) * (half + FRAME_GAP), y, w: half, h });
  }
  return out;
}

/** Splits `box` into rows x cols cells, row-major, `gap` apart. */
function grid(box: U, rows: number, cols: number, gap: number): U[] {
  const w = (box.w - (cols - 1) * gap) / cols;
  const h = (box.h - (rows - 1) * gap) / rows;
  const out: U[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push({ x: box.x + c * (w + gap), y: box.y + r * (h + gap), w, h });
  }
  return out;
}

function bodyOf(kind: ModuleKind, count: number, inner: U): { display: U | null; slots: U[] } {
  switch (kind) {
    case 'wires': {
      const h = Math.max(0, (inner.h - (count - 1) * WIRE_GAP) / Math.max(1, count));
      return {
        display: null,
        slots: Array.from({ length: count }, (_, i) => ({ x: inner.x, y: inner.y + i * (h + WIRE_GAP), w: inner.w, h })),
      };
    }
    case 'button': {
      // One big round slot: the largest centered square.
      const side = Math.min(inner.w, inner.h);
      return { display: null, slots: [{ x: inner.x + (inner.w - side) / 2, y: inner.y + (inner.h - side) / 2, w: side, h: side }] };
    }
    case 'symbols': {
      const dh = inner.h * SYMBOLS_DISPLAY;
      const display = { x: inner.x, y: inner.y, w: inner.w, h: dh };
      const rest = { x: inner.x, y: inner.y + dh + GRID_GAP, w: inner.w, h: Math.max(0, inner.h - dh - GRID_GAP) };
      return { display, slots: grid(rest, 2, 2, GRID_GAP) }; // row-major: 0 TL, 1 TR, 2 BL, 3 BR
    }
    case 'code': {
      const dh = inner.h * CODE_DISPLAY;
      const display = { x: inner.x, y: inner.y, w: inner.w, h: dh };
      const rest = { x: inner.x, y: inner.y + dh + GRID_GAP, w: inner.w, h: Math.max(0, inner.h - dh - GRID_GAP) };
      const cells = grid(rest, CODE_ROWS, CODE_COLS, GRID_GAP);
      const slots: U[] = new Array<U>(CODE_SLOTS);
      KEYPAD.forEach((row, r) => row.forEach((slot, c) => (slots[slot] = cells[r * CODE_COLS + c])));
      return { display, slots };
    }
  }
}

/**
 * Lays the modules out on a canvas of the given aspect (width / height, portrait < 1). Pure
 * geometry, no pixels: every rect is in 0..1 of the canvas. Only the first `slots` slots of a
 * kind are produced (a kind never has more than its fixed count; wires use the spec's count).
 * Below the HUD band the modules fill the canvas in a grid, with as little padding as possible.
 */
export function computeLayout(specs: readonly ModuleSpec[], aspect = 1): ModuleLayout[] {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const area: U = { x: MARGIN, y: HUD_H, w: Math.max(0, a - 2 * MARGIN), h: 1 - HUD_H - MARGIN };
  const boxes = frames(specs.length, area);
  const norm = (r: U): Rect => ({ x: r.x / a, y: r.y, w: r.w / a, h: r.h });
  return specs.map((s, i) => {
    const frame = boxes[i];
    const body = bodyOf(s.kind, s.slots, inset(frame, FRAME_PAD));
    return {
      moduleId: s.moduleId,
      kind: s.kind,
      frame: norm(frame),
      display: body.display ? norm(body.display) : null,
      slots: body.slots.slice(0, s.slots).map(norm),
    };
  });
}

/** Smallest slot side, in pixels, over every slot of the layout on a canvas of `canvasW` x `canvasH`. */
export function minSlotSizePx(layout: readonly ModuleLayout[], canvasW: number, canvasH: number): number {
  let min = Number.POSITIVE_INFINITY;
  for (const m of layout) {
    for (const s of m.slots) min = Math.min(min, s.w * canvasW, s.h * canvasH);
  }
  return min;
}
