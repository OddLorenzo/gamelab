import type { ModuleAction, ModuleKind } from '../core/types';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutEntry {
  moduleId: string;
  slots: SlotRect[];
}

const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)));

/** Pointer position inside `rect` as 0..1 on each axis. A zero or negative size gives 0 for that axis. */
export function toNormalized(ev: { clientX: number; clientY: number }, rect: Rect): Point {
  return {
    x: rect.width > 0 ? clamp01((ev.clientX - rect.left) / rect.width) : 0,
    y: rect.height > 0 ? clamp01((ev.clientY - rect.top) / rect.height) : 0,
  };
}

/**
 * Slot under the point. A rect includes its top and left edges and excludes its bottom and right
 * edges, so neighbouring slots never both match. First match in layout order, then slot order.
 */
export function hitTest(layout: readonly LayoutEntry[], p: Point): { moduleId: string; slot: number } | null {
  for (const entry of layout) {
    for (const [slot, r] of entry.slots.entries()) {
      if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) {
        return { moduleId: entry.moduleId, slot };
      }
    }
  }
  return null;
}

const MAX_WIRES = 6; // a wires module has 3..6 wires
const SYMBOL_SLOTS = 4;
const CODE_CLEAR = 10;
const CODE_SUBMIT = 11;

const isIndex = (n: number, count: number): boolean => Number.isInteger(n) && n >= 0 && n < count;

/**
 * Module action for a TAP on a slot of the blind player's screen. Slot meaning (ruling R8):
 * wires: wire position, first wire = 0; symbols: 0..3 in reading order; code: 0-9 digits,
 * 10 clear, 11 submit. The button has no tap mapping (it uses ButtonGesture). Anything that is
 * not a slot of that kind gives null. The module stays the judge: a wires slot past the real wire
 * count is a harmless no-op there.
 */
export function slotAction(kind: ModuleKind, slot: number): ModuleAction | null {
  switch (kind) {
    case 'wires':
      return isIndex(slot, MAX_WIRES) ? { kind: 'wires', type: 'cut', payload: { index: slot } } : null;
    case 'symbols':
      return isIndex(slot, SYMBOL_SLOTS) ? { kind: 'symbols', type: 'tap', payload: { slot } } : null;
    case 'code':
      if (isIndex(slot, 10)) return { kind: 'code', type: 'digit', payload: { d: slot } };
      if (slot === CODE_CLEAR) return { kind: 'code', type: 'clear' };
      if (slot === CODE_SUBMIT) return { kind: 'code', type: 'submit' };
      return null;
    case 'button':
      return null;
  }
}

export const HOLD_MS = 300;

export interface GestureDeps {
  emit(action: ModuleAction): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Hold threshold, default 300 ms. */
  holdMs?: number;
}

/**
 * The blind player's gesture on the single button slot.
 * Down then up before the threshold: one `press`. Down kept for >= holdMs: one `hold` at the
 * threshold, then on up one `release`. `cancel` (pointer cancel or leave) ends a hold with a
 * release and otherwise emits nothing.
 *
 * `release` carries `timerDigit: 0` as a placeholder: the host overwrites it with the real seconds
 * digit (ruling R1), so the client value never matters.
 */
export class ButtonGesture {
  private state: 'idle' | 'down' | 'held' = 'idle';
  private handle: unknown = null;

  constructor(private readonly deps: GestureDeps) {}

  down(): void {
    if (this.state !== 'idle') return;
    this.state = 'down';
    this.handle = this.deps.setTimeout(() => {
      this.handle = null;
      if (this.state !== 'down') return;
      this.state = 'held';
      this.deps.emit({ kind: 'button', type: 'hold' });
    }, this.deps.holdMs ?? HOLD_MS);
  }

  up(): void {
    const was = this.state;
    if (was === 'idle') return;
    this.stopTimer();
    this.state = 'idle';
    this.deps.emit(was === 'held' ? this.release() : { kind: 'button', type: 'press' });
  }

  cancel(): void {
    const was = this.state;
    this.stopTimer();
    this.state = 'idle';
    if (was === 'held') this.deps.emit(this.release());
  }

  destroy(): void {
    this.stopTimer();
    this.state = 'idle';
  }

  private release(): ModuleAction {
    return { kind: 'button', type: 'release', payload: { timerDigit: 0 } };
  }

  private stopTimer(): void {
    if (this.handle !== null) this.deps.clearTimeout(this.handle);
    this.handle = null;
  }
}

/** Leading-edge throttle: runs `fn` at most once per `ms`, drops the calls in between (no trailing run). */
export function createThrottle(ms: number, now: () => number): (fn: () => void) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (fn) => {
    const t = now();
    if (t - last >= ms || t < last) {
      last = t;
      fn();
    }
  };
}
