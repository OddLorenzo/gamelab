import { EMOTE_IDS } from '../net/protocol';
import type { EmoteId } from '../net/protocol';
import { el } from './dom';
import { t } from './i18n';

/** The six emote ids: the protocol list itself, never a second copy. */
export const EMOTES = EMOTE_IDS;

/** Distance from the wheel centre to the middle of each emote button, in CSS px. */
export const WHEEL_RADIUS = 92;
export const LONG_PRESS_MS = 400;
/** A press that moves further than this is a drag (the shared pointer), not a long-press. */
export const LONG_PRESS_MOVE_PX = 10;

const ICONS: Record<EmoteId, string> = {
  point: '👉',
  wave: '👋',
  slap: '💥',
  panic: '😱',
  yes: '👍',
  no: '👎',
};

/**
 * `n` points on a circle of `radius` around (0, 0), evenly spaced, the first at the top and going
 * clockwise on screen (y grows downwards, so the top is y = -radius).
 */
export function wheelPositions(n: number, radius: number): { x: number; y: number }[] {
  if (!(n > 0)) return [];
  return Array.from({ length: n }, (_, k) => {
    const angle = (2 * Math.PI * k) / n;
    return { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) };
  });
}

export interface EmoteWheelDeps {
  onPick(id: EmoteId): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface EmoteWheel {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** A press held still for 400 ms on `target` opens the wheel. Removed again by destroy(). */
  attachLongPress(target: HTMLElement): void;
  destroy(): void;
}

/** A toggle button and a ring of six emote buttons, appended to `root`. */
export function createEmoteWheel(root: HTMLElement, deps: EmoteWheelDeps): EmoteWheel {
  const setTimer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number));

  const toggle = el(
    'button',
    { cls: 'emote-toggle', testid: 'emote-toggle', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-label': t('emote.open') } },
    [el('span', { text: '🐵', attrs: { 'aria-hidden': 'true' } })],
  );
  const positions = wheelPositions(EMOTES.length, WHEEL_RADIUS);
  const buttons = EMOTES.map((id, i) => {
    const b = el(
      'button',
      { cls: 'emote-btn', testid: `emote-${id}`, attrs: { type: 'button', 'aria-label': t(`emote.${id}`) } },
      [el('span', { text: ICONS[id], attrs: { 'aria-hidden': 'true' } })],
    );
    b.style.setProperty('--x', `${positions[i].x}px`);
    b.style.setProperty('--y', `${positions[i].y}px`);
    b.addEventListener('click', () => {
      close();
      deps.onPick(id);
    });
    return b;
  });
  const ring = el('div', { cls: 'emote-ring', testid: 'emote-ring', attrs: { role: 'group', 'aria-label': t('emote.open') } }, buttons);
  ring.hidden = true;
  const wrap = el('div', { cls: 'emote-wheel', testid: 'emote-wheel' }, [toggle, ring]);

  let opened = false;

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') close();
  };

  function open(): void {
    if (opened) return;
    opened = true;
    ring.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey);
    buttons[0].focus({ preventScroll: true });
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    const hadFocus = wrap.contains(document.activeElement);
    ring.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    if (hadFocus) toggle.focus({ preventScroll: true });
  }

  toggle.addEventListener('click', () => {
    if (opened) close();
    else open();
  });

  /* ------------------------------------------------ long-press */

  let pending: unknown = null;
  let start = { x: 0, y: 0 };
  const stopPress = (): void => {
    if (pending !== null) clearTimer(pending);
    pending = null;
  };
  const onDown = (ev: Event): void => {
    stopPress();
    const e = ev as MouseEvent;
    start = { x: e.clientX, y: e.clientY };
    pending = setTimer(() => {
      pending = null;
      open();
    }, LONG_PRESS_MS);
  };
  const onMove = (ev: Event): void => {
    if (pending === null) return;
    const e = ev as MouseEvent;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_MOVE_PX) stopPress();
  };
  const attached: HTMLElement[] = [];
  const END_EVENTS = ['pointerup', 'pointercancel', 'pointerleave'] as const;

  root.append(wrap);

  return {
    open,
    close,
    isOpen: () => opened,
    attachLongPress(target) {
      attached.push(target);
      target.addEventListener('pointerdown', onDown);
      target.addEventListener('pointermove', onMove);
      for (const type of END_EVENTS) target.addEventListener(type, stopPress);
    },
    destroy() {
      close();
      stopPress();
      for (const target of attached) {
        target.removeEventListener('pointerdown', onDown);
        target.removeEventListener('pointermove', onMove);
        for (const type of END_EVENTS) target.removeEventListener(type, stopPress);
      }
      attached.length = 0;
      wrap.remove();
    },
  };
}
