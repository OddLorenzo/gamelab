import type { ModuleState } from '../core/types';
import type { DeafView } from '../core/views';
import { glyphChar } from './glyphs';
import { HUD_H } from './layout';
import type { ModuleLayout, Rect } from './layout';
import { formatClock } from './timing';

/** The part of CanvasRenderingContext2D the renderer uses, so tests can pass a recording fake. */
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'arcTo'
  | 'fill'
  | 'stroke'
  | 'fillRect'
  | 'strokeRect'
  | 'fillText'
  | 'setLineDash'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'globalAlpha'
>;

export interface PressedSlot {
  moduleId: string;
  slot: number;
}

export interface Pointer {
  id: string;
  x: number;
  y: number;
  color: string;
}

/**
 * Wire and button colors on the dark bomb body. Lightness is spread on purpose (red darkest,
 * white lightest) so the five stay apart for color-blind players, and `drawDeaf` also gives each
 * wire color its own pattern: red solid, blue dashed, yellow dotted, green double line, white thick.
 */
export const WIRE_COLORS: Record<string, string> = {
  red: '#e0443f',
  blue: '#4d83ff',
  yellow: '#ffd23a',
  green: '#4fd68a',
  white: '#f6f6f6',
};

// Deaf palette (the deaf player sees everything, so colors are fine here).
const BODY = '#12161b';
const FRAME = '#1c222a';
const FRAME_EDGE = '#3a4552';
const PLATE = '#262e39';
const PLATE_PRESSED = '#46586f';
const INK = '#eef2f6';
const DIM_INK = '#8b96a5';
const METAL = '#8b96a5';
const PIP_ON = '#ff6a5c';
const OK_GREEN = '#58d68d';
const DARK_INK = '#12161b';

// Blind palette: greys only. The blind player sees no colors and no text, only where to touch.
const B_BODY = '#0a0a0a';
const B_FRAME = '#161616';
const B_FRAME_EDGE = '#2c2c2c';
const B_DISPLAY = '#101010';
const B_PLATE = '#383838';
const B_PLATE_EDGE = '#555555';
const B_PRESSED = '#9a9a9a';
const B_DETAIL = '#5e5e5e';
const B_PIP = '#d0d0d0';

const MAX_PIPS = 5;
const CODE_CELLS = 4;
const TAU = Math.PI * 2;

const valid = (w: number, h: number): boolean => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
const toPx = (r: Rect, w: number, h: number): Rect => ({ x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h });
const isPressed = (p: PressedSlot | null | undefined, moduleId: string, slot: number): boolean =>
  p !== null && p !== undefined && p.moduleId === moduleId && p.slot === slot;

function roundRectPath(ctx: Ctx2D, r: Rect, radius: number): void {
  const k = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  ctx.beginPath();
  ctx.moveTo(r.x + k, r.y);
  ctx.lineTo(r.x + r.w - k, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + k, k);
  ctx.lineTo(r.x + r.w, r.y + r.h - k);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x + r.w - k, r.y + r.h, k);
  ctx.lineTo(r.x + k, r.y + r.h);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y + r.h - k, k);
  ctx.lineTo(r.x, r.y + k);
  ctx.arcTo(r.x, r.y, r.x + k, r.y, k);
  ctx.closePath();
}

function plate(ctx: Ctx2D, r: Rect, fill: string, edge: string | null, radius: number): void {
  roundRectPath(ctx, r, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (edge !== null) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function disc(ctx: Ctx2D, cx: number, cy: number, radius: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0, radius), 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
}

function ring(ctx: Ctx2D, cx: number, cy: number, radius: number, color: string, width: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0, radius), 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function line(ctx: Ctx2D, x1: number, x2: number, y: number, color: string, width: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function text(ctx: Ctx2D, s: string, x: number, y: number, size: number, color: string, opts: { mono?: boolean; bold?: boolean; align?: CanvasTextAlign } = {}): void {
  ctx.font = `${opts.bold === true ? 'bold ' : ''}${Math.max(8, Math.round(size))}px ${opts.mono === true ? 'monospace' : 'sans-serif'}`;
  ctx.textAlign = opts.align ?? 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** Strike pips centered on `cx`; count is capped so a bad number cannot draw a mile of dots. */
function pips(ctx: Ctx2D, count: number, x0: number, y: number, radius: number, color: string, centered: boolean): void {
  const n = Number.isFinite(count) ? Math.min(MAX_PIPS, Math.max(0, Math.floor(count))) : 0;
  const step = radius * 2.6;
  const start = centered ? x0 - ((n - 1) * step) / 2 : x0 + radius;
  for (let i = 0; i < n; i++) disc(ctx, start + i * step, y, radius, color);
}

// ---------------------------------------------------------------------------------------------
// Blind

/**
 * The blind player's screen: a dark silhouette with big touch slots. Greys only, no text, nothing
 * that depends on the bomb except which module kinds there are, how many slots each has, and the
 * strikes left. (The inputs have no colors, glyphs or serial to leak, by construction.)
 */
export function drawBlind(
  ctx: Ctx2D,
  w: number,
  h: number,
  layout: readonly ModuleLayout[],
  state: { strikesLeft: number; pressedSlot: PressedSlot | null },
): void {
  if (!valid(w, h)) return;
  ctx.save();
  ctx.fillStyle = B_BODY;
  ctx.fillRect(0, 0, w, h);
  const unit = Math.min(w, h);
  pips(ctx, state.strikesLeft, w / 2, (HUD_H * h) / 2, Math.min(HUD_H * h * 0.22, unit * 0.025), B_PIP, true);

  for (const m of layout) {
    plate(ctx, toPx(m.frame, w, h), B_FRAME, B_FRAME_EDGE, unit * 0.02);
    if (m.display !== null) {
      const d = toPx(m.display, w, h);
      ctx.fillStyle = B_DISPLAY;
      ctx.fillRect(d.x, d.y, d.w, d.h);
    }
    m.slots.forEach((s, i) => {
      const r = toPx(s, w, h);
      const lit = isPressed(state.pressedSlot, m.moduleId, i);
      const fill = lit ? B_PRESSED : B_PLATE;
      if (m.kind === 'button') {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        disc(ctx, cx, cy, Math.min(r.w, r.h) * 0.46, fill);
        ring(ctx, cx, cy, Math.min(r.w, r.h) * 0.46, B_PLATE_EDGE, 2);
        return;
      }
      plate(ctx, r, fill, B_PLATE_EDGE, Math.min(r.w, r.h) * 0.18);
      if (m.kind === 'wires') {
        // A groove with a terminal at each end: where a wire would run.
        const y = r.y + r.h / 2;
        line(ctx, r.x + r.w * 0.1, r.x + r.w * 0.9, y, B_DETAIL, Math.max(2, r.h * 0.12));
        disc(ctx, r.x + r.w * 0.07, y, Math.max(3, r.h * 0.14), B_DETAIL);
        disc(ctx, r.x + r.w * 0.93, y, Math.max(3, r.h * 0.14), B_DETAIL);
      }
    });
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Deaf

const recordOf = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const colorOf = (name: unknown): string => (typeof name === 'string' && Object.hasOwn(WIRE_COLORS, name) ? WIRE_COLORS[name] : METAL);

interface WireView {
  color: string;
  cut: boolean;
}

const wiresOf = (m: ModuleState): WireView[] => {
  const raw = recordOf(m.data)['wires'];
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    const o = recordOf(x);
    return { color: typeof o['color'] === 'string' ? o['color'] : '', cut: o['cut'] === true };
  });
};

/**
 * One wire segment from x1 to x2 with the color's pattern, so color-blind players can tell the
 * colors apart: red solid, blue dashed, yellow dotted, green double line, white thick.
 */
function wireSegment(ctx: Ctx2D, color: string, x1: number, x2: number, y: number, lw: number): void {
  const paint = colorOf(color);
  ctx.lineCap = 'butt';
  switch (color) {
    case 'blue':
      line(ctx, x1, x2, y, paint, lw);
      ctx.setLineDash([lw * 0.9, lw * 0.9]);
      line(ctx, x1, x2, y, DARK_INK, lw * 0.3);
      ctx.setLineDash([]);
      break;
    case 'yellow':
      line(ctx, x1, x2, y, paint, lw);
      ctx.lineCap = 'round';
      ctx.setLineDash([0.01, lw * 1.1]);
      line(ctx, x1, x2, y, DARK_INK, lw * 0.34);
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
      break;
    case 'green':
      line(ctx, x1, x2, y - lw * 0.28, paint, lw * 0.36);
      line(ctx, x1, x2, y + lw * 0.28, paint, lw * 0.36);
      break;
    case 'white':
      line(ctx, x1, x2, y, paint, lw * 1.5);
      break;
    default: // red, and any color the table does not know: a plain solid wire
      line(ctx, x1, x2, y, paint, lw);
  }
}

function drawWires(ctx: Ctx2D, m: ModuleLayout, state: ModuleState, w: number, h: number, pressed: PressedSlot | null | undefined): void {
  const wires = wiresOf(state);
  m.slots.forEach((s, i) => {
    const r = toPx(s, w, h);
    plate(ctx, r, isPressed(pressed, m.moduleId, i) ? PLATE_PRESSED : PLATE, null, Math.min(r.w, r.h) * 0.18);
    const wire = wires[i];
    if (wire === undefined) return;
    const y = r.y + r.h / 2;
    const x1 = r.x + r.w * 0.1;
    const x2 = r.x + r.w * 0.9;
    const lw = Math.max(3, r.h * 0.34);
    disc(ctx, r.x + r.w * 0.07, y, Math.max(3, r.h * 0.13), METAL);
    disc(ctx, r.x + r.w * 0.93, y, Math.max(3, r.h * 0.13), METAL);
    if (wire.cut) {
      const mid = (x1 + x2) / 2;
      const gap = (x2 - x1) * 0.09;
      wireSegment(ctx, wire.color, x1, mid - gap, y, lw);
      wireSegment(ctx, wire.color, mid + gap, x2, y, lw);
    } else {
      wireSegment(ctx, wire.color, x1, x2, y, lw);
    }
  });
}

function drawButton(ctx: Ctx2D, m: ModuleLayout, state: ModuleState, w: number, h: number, pressed: PressedSlot | null | undefined): void {
  const slot = m.slots[0];
  if (slot === undefined) return;
  const r = toPx(slot, w, h);
  const d = recordOf(state.data);
  const colorName = d['color'];
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const half = Math.min(r.w, r.h) / 2;
  const face = half * 0.82;
  disc(ctx, cx, cy, half * 0.96, isPressed(pressed, m.moduleId, 0) ? PLATE_PRESSED : PLATE);
  disc(ctx, cx, cy, face, colorOf(colorName));
  ring(ctx, cx, cy, face, DARK_INK, Math.max(2, half * 0.05));
  if (d['held'] === true) ring(ctx, cx, cy, half * 0.93, INK, Math.max(3, half * 0.1));
  const light = colorName === 'yellow' || colorName === 'white';
  const ink = light ? DARK_INK : INK;
  // The raw English words HOLD / PRESS / ABORT, exactly as the manual says them in both languages.
  if (typeof d['label'] === 'string') text(ctx, d['label'], cx, cy - face * 0.18, face * 0.38, ink, { bold: true });
  if (typeof d['digit'] === 'number' && Number.isFinite(d['digit'])) {
    const by = cy + face * 0.5;
    disc(ctx, cx, by, face * 0.27, DARK_INK);
    text(ctx, String(d['digit']), cx, by, face * 0.34, INK, { bold: true });
  }
}

function drawSymbols(ctx: Ctx2D, m: ModuleLayout, state: ModuleState, w: number, h: number, pressed: PressedSlot | null | undefined): void {
  const d = recordOf(state.data);
  const symbols = Array.isArray(d['symbols']) ? (d['symbols'] as unknown[]) : [];
  const next = typeof d['next'] === 'number' && Number.isFinite(d['next']) ? d['next'] : 0;
  m.slots.forEach((s, i) => {
    const r = toPx(s, w, h);
    plate(ctx, r, isPressed(pressed, m.moduleId, i) ? PLATE_PRESSED : PLATE, null, Math.min(r.w, r.h) * 0.14);
    const id = symbols[i];
    if (typeof id === 'string') text(ctx, glyphChar(id), r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.55, INK);
  });
  if (m.display !== null) {
    const b = toPx(m.display, w, h);
    const radius = Math.max(2, Math.min(b.h * 0.3, b.w * 0.04));
    const step = radius * 3;
    const x0 = b.x + b.w / 2 - (step * 3) / 2;
    for (let i = 0; i < 4; i++) {
      const cx = x0 + i * step;
      const cy = b.y + b.h / 2;
      if (i < next) disc(ctx, cx, cy, radius, OK_GREEN);
      else ring(ctx, cx, cy, radius, DIM_INK, 2);
    }
  }
}

function drawCode(ctx: Ctx2D, m: ModuleLayout, state: ModuleState, w: number, h: number, pressed: PressedSlot | null | undefined): void {
  const d = recordOf(state.data);
  const serial = typeof d['serial'] === 'string' ? d['serial'] : '';
  const entered = typeof d['entered'] === 'string' ? d['entered'] : '';
  if (m.display !== null) {
    const b = toPx(m.display, w, h);
    ctx.fillStyle = BODY;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    // Serial on the upper half, as large as the band allows; entered digits in cells on the lower half.
    const serialSize = Math.min(b.h * 0.4, b.w / Math.max(6, serial.length) / 0.65);
    text(ctx, serial, b.x + b.w / 2, b.y + b.h * 0.27, serialSize, INK, { mono: true, bold: true });
    const cells = Math.max(CODE_CELLS, entered.length);
    const cellH = b.h * 0.4;
    const cellW = Math.min(cellH * 0.85, (b.w * 0.8) / cells);
    const gap = cellW * 0.25;
    const total = cells * cellW + (cells - 1) * gap;
    const left = b.x + (b.w - total) / 2;
    const top = b.y + b.h * 0.52;
    for (let i = 0; i < cells; i++) {
      const x = left + i * (cellW + gap);
      ctx.strokeStyle = DIM_INK;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, top, cellW, cellH);
      const digit = entered[i];
      if (digit !== undefined) text(ctx, digit, x + cellW / 2, top + cellH / 2, cellH * 0.7, INK, { mono: true, bold: true });
    }
  }
  m.slots.forEach((s, i) => {
    const r = toPx(s, w, h);
    plate(ctx, r, isPressed(pressed, m.moduleId, i) ? PLATE_PRESSED : PLATE, null, Math.min(r.w, r.h) * 0.16);
    // Keys carry their text so the deaf player can check what the blind player taps.
    // Clear is "C" and submit is "OK" (raw, same in both languages).
    const label = i < 10 ? String(i) : i === 10 ? 'C' : 'OK';
    text(ctx, label, r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * (i < 10 ? 0.5 : 0.4), i === 11 ? OK_GREEN : INK, { bold: true });
  });
}

function drawSolvedOverlay(ctx: Ctx2D, frame: Rect): void {
  ctx.globalAlpha = 0.62;
  ctx.fillStyle = BODY;
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
  ctx.globalAlpha = 1;
  const size = Math.min(frame.w, frame.h) * 0.3;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.5, cy);
  ctx.lineTo(cx - size * 0.12, cy + size * 0.38);
  ctx.lineTo(cx + size * 0.55, cy - size * 0.4);
  ctx.strokeStyle = OK_GREEN;
  ctx.lineWidth = Math.max(3, size * 0.16);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
}

/**
 * The deaf player's screen: the whole bomb with its colors and text, the clock and the strikes.
 * `extra.msLeft` is the clock to show (null = no clock yet). `extra.pressedSlot` lights the slot
 * the blind player is touching. Nothing in `view`, `layout` or `extra` is modified.
 */
export function drawDeaf(
  ctx: Ctx2D,
  w: number,
  h: number,
  layout: readonly ModuleLayout[],
  view: DeafView,
  extra: { msLeft: number | null; pressedSlot?: PressedSlot | null },
): void {
  if (!valid(w, h)) return;
  ctx.save();
  ctx.fillStyle = BODY;
  ctx.fillRect(0, 0, w, h);

  // HUD: strikes left (number then pips) on the left, the clock in the middle.
  const hudH = HUD_H * h;
  const unit = Math.min(w, h);
  const pad = unit * 0.02;
  const numSize = hudH * 0.5;
  text(ctx, String(view.strikesLeft), pad + numSize * 0.4, hudH / 2, numSize, PIP_ON, { bold: true });
  pips(ctx, view.strikesLeft, pad + numSize * 1.0, hudH / 2, Math.min(hudH * 0.2, unit * 0.02), PIP_ON, false);
  if (extra.msLeft !== null) text(ctx, formatClock(extra.msLeft), w / 2, hudH / 2, hudH * 0.72, INK, { bold: true });

  const byId = new Map<string, ModuleState>(view.modules.map((m) => [m.id, m]));
  for (const m of layout) {
    const state = byId.get(m.moduleId);
    if (state === undefined) continue;
    const frame = toPx(m.frame, w, h);
    plate(ctx, frame, FRAME, FRAME_EDGE, unit * 0.02);
    if (state.kind === m.kind) {
      switch (m.kind) {
        case 'wires':
          drawWires(ctx, m, state, w, h, extra.pressedSlot);
          break;
        case 'button':
          drawButton(ctx, m, state, w, h, extra.pressedSlot);
          break;
        case 'symbols':
          drawSymbols(ctx, m, state, w, h, extra.pressedSlot);
          break;
        case 'code':
          drawCode(ctx, m, state, w, h, extra.pressedSlot);
          break;
      }
    }
    if (state.solved) drawSolvedOverlay(ctx, frame);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Pointers

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

/** Grey of the same brightness as a `#rgb` / `#rrggbb` color (a visible grey when it cannot be read). */
function greyOf(color: string): string {
  let hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex === undefined) {
    const short = /^#([0-9a-f]{3})$/i.exec(color)?.[1];
    if (short !== undefined) hex = Array.from(short, (c) => c + c).join('');
  }
  if (hex === undefined) return '#c0c0c0';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt((hex as string).slice(i, i + 2), 16));
  const lum = Math.min(0xee, Math.max(0x90, 0.299 * r + 0.587 * g + 0.114 * b));
  const v = hex2(lum);
  return `#${v}${v}${v}`;
}

/**
 * Dots for the other players' pointers at normalized positions. `greyscale` (the blind player's
 * screen) turns every color into a grey; no text either way.
 */
export function drawPointers(ctx: Ctx2D, w: number, h: number, pointers: readonly Pointer[], opts: { greyscale: boolean }): void {
  if (!valid(w, h) || pointers.length === 0) return;
  const radius = Math.max(5, Math.min(w, h) * 0.02);
  ctx.save();
  for (const p of pointers) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const x = Math.min(1, Math.max(0, p.x)) * w;
    const y = Math.min(1, Math.max(0, p.y)) * h;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = opts.greyscale ? greyOf(p.color) : p.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}
