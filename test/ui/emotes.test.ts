import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMOTE_IDS } from '../../src/net/protocol';
import type { EmoteId } from '../../src/net/protocol';
import { EMOTES, createEmoteWheel, wheelPositions } from '../../src/ui/emotes';
import type { EmoteWheel } from '../../src/ui/emotes';
import { en, fr, setLang } from '../../src/ui/i18n';

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Rig {
  root: HTMLElement;
  stage: HTMLElement;
  picks: EmoteId[];
  wheel: EmoteWheel;
}

const mount = (): Rig => {
  const root = document.createElement('div');
  const stage = document.createElement('div');
  document.body.append(root, stage);
  const picks: EmoteId[] = [];
  const wheel = createEmoteWheel(root, { onPick: (id) => picks.push(id), ...timers });
  return { root, stage, picks, wheel };
};

const q = (root: ParentNode, testid: string): HTMLElement => {
  const node = root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (node === null) throw new Error(`no ${testid}`);
  return node;
};
const toggle = (root: ParentNode): HTMLButtonElement => q(root, 'emote-toggle') as HTMLButtonElement;
const isOpen = (root: ParentNode): boolean => toggle(root).getAttribute('aria-expanded') === 'true';

const fire = (target: EventTarget, type: string, init: { clientX?: number; clientY?: number } = {}): void => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 }));
};
const key = (k: string): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
};

describe('EMOTES', () => {
  it('is the protocol list itself (not a copy) with exactly six ids', () => {
    expect(EMOTES).toBe(EMOTE_IDS);
    expect(EMOTES).toHaveLength(6);
    expect([...EMOTES]).toEqual(['point', 'wave', 'slap', 'panic', 'yes', 'no']);
  });
});

describe('wheelPositions', () => {
  it('puts the first at the top and goes clockwise, evenly, all at the same distance', () => {
    const p = wheelPositions(6, 100);
    expect(p).toHaveLength(6);
    expect(p[0].x).toBeCloseTo(0, 6);
    expect(p[0].y).toBeCloseTo(-100, 6);
    // clockwise on screen (y down): the second is up and to the right, the fourth is at the bottom
    expect(p[1].x).toBeGreaterThan(0);
    expect(p[1].y).toBeLessThan(0);
    expect(p[3].x).toBeCloseTo(0, 6);
    expect(p[3].y).toBeCloseTo(100, 6);
    expect(p[4].x).toBeLessThan(0);
    for (const { x, y } of p) expect(Math.hypot(x, y)).toBeCloseTo(100, 6);
    const step = (2 * Math.PI) / 6;
    for (let k = 0; k < 6; k++) {
      expect(p[k].x).toBeCloseTo(100 * Math.sin(k * step), 6);
      expect(p[k].y).toBeCloseTo(-100 * Math.cos(k * step), 6);
    }
  });

  it('works for other counts and radii, and gives nothing for n <= 0', () => {
    const four = wheelPositions(4, 10);
    expect(four[1].x).toBeCloseTo(10, 6);
    expect(four[1].y).toBeCloseTo(0, 6);
    expect(four[2].y).toBeCloseTo(10, 6);
    expect(wheelPositions(1, 5)[0].y).toBeCloseTo(-5, 6);
    expect(wheelPositions(0, 5)).toEqual([]);
    expect(wheelPositions(-2, 5)).toEqual([]);
    for (const { x, y } of wheelPositions(6, 0)) {
      expect(x).toBeCloseTo(0, 9);
      expect(y).toBeCloseTo(0, 9);
    }
  });
});

describe('createEmoteWheel', () => {
  beforeEach(() => {
    setLang('en');
    document.body.replaceChildren();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a closed toggle and exactly six emote buttons with accessible names in both languages', () => {
    const { root } = mount();
    const t = toggle(root);
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.getAttribute('aria-label')).toBe(en['emote.open']);
    expect(t.type).toBe('button');
    const buttons = EMOTE_IDS.map((id) => q(root, `emote-${id}`) as HTMLButtonElement);
    const ids = [...root.querySelectorAll<HTMLElement>('[data-testid^="emote-"]')].map((n) => n.dataset['testid']);
    expect(ids.filter((id) => !['emote-toggle', 'emote-ring', 'emote-wheel'].includes(id ?? ''))).toEqual(EMOTE_IDS.map((id) => `emote-${id}`));
    expect(root.querySelectorAll('.emote-ring button')).toHaveLength(6);
    for (const [i, id] of EMOTE_IDS.entries()) {
      expect(buttons[i].getAttribute('aria-label')).toBe(en[`emote.${id}`]);
      expect(buttons[i].type).toBe('button');
      expect(buttons[i].querySelector('[aria-hidden="true"]')?.textContent).toBeTruthy();
      expect(fr[`emote.${id}`], id).toBeTruthy();
    }
    setLang('fr');
    const root2 = document.createElement('div');
    document.body.append(root2);
    createEmoteWheel(root2, { onPick: () => undefined, ...timers });
    expect(toggle(root2).getAttribute('aria-label')).toBe(fr['emote.open']);
    for (const id of EMOTE_IDS) expect(q(root2, `emote-${id}`).getAttribute('aria-label')).toBe(fr[`emote.${id}`]);
  });

  it('keeps the ring out of reach (hidden) while closed and shows it when open', () => {
    const { root } = mount();
    const ring = q(root, 'emote-ring');
    expect(ring.hidden).toBe(true);
    toggle(root).click();
    expect(isOpen(root)).toBe(true);
    expect(ring.hidden).toBe(false);
    toggle(root).click();
    expect(isOpen(root)).toBe(false);
    expect(ring.hidden).toBe(true);
  });

  it('places the six buttons on the circle given by wheelPositions', () => {
    const { root } = mount();
    const first = q(root, 'emote-point');
    const radius = Math.abs(Number.parseFloat(first.style.getPropertyValue('--y')));
    expect(radius).toBeGreaterThan(40);
    const pos = wheelPositions(6, radius);
    for (const [i, id] of EMOTE_IDS.entries()) {
      const b = q(root, `emote-${id}`);
      expect(Number.parseFloat(b.style.getPropertyValue('--x'))).toBeCloseTo(pos[i].x, 3);
      expect(Number.parseFloat(b.style.getPropertyValue('--y'))).toBeCloseTo(pos[i].y, 3);
    }
  });

  it('selecting an emote calls onPick once with that id and closes the wheel', () => {
    for (const id of EMOTE_IDS) {
      document.body.replaceChildren();
      const { root, picks } = mount();
      toggle(root).click();
      q(root, `emote-${id}`).click();
      expect(picks).toEqual([id]);
      expect(isOpen(root)).toBe(false);
      expect(q(root, 'emote-ring').hidden).toBe(true);
    }
  });

  it('does not call onPick just by opening or closing', () => {
    const { root, picks } = mount();
    toggle(root).click();
    toggle(root).click();
    expect(picks).toEqual([]);
  });

  it('moves focus into the ring on open and back to the toggle after a pick or Escape', () => {
    const { root } = mount();
    toggle(root).click();
    expect(document.activeElement).toBe(q(root, 'emote-point'));
    key('Escape');
    expect(document.activeElement).toBe(toggle(root));
    toggle(root).click();
    q(root, 'emote-no').click();
    expect(document.activeElement).toBe(toggle(root));
  });

  it('Escape closes an open wheel and does nothing when closed', () => {
    const { root, picks } = mount();
    key('Escape');
    expect(isOpen(root)).toBe(false);
    toggle(root).click();
    key('a');
    expect(isOpen(root)).toBe(true);
    key('Escape');
    expect(isOpen(root)).toBe(false);
    expect(picks).toEqual([]);
  });

  it('a long-press of 400 ms on the attached stage opens it, 399 ms does not', () => {
    const { root, stage, wheel } = mount();
    wheel.attachLongPress(stage);
    fire(stage, 'pointerdown');
    vi.advanceTimersByTime(399);
    expect(isOpen(root)).toBe(false);
    fire(stage, 'pointerup');
    vi.advanceTimersByTime(1000);
    expect(isOpen(root)).toBe(false);

    fire(stage, 'pointerdown');
    vi.advanceTimersByTime(399);
    expect(isOpen(root)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isOpen(root)).toBe(true);
    fire(stage, 'pointerup');
    expect(isOpen(root)).toBe(true);
  });

  it('a pointercancel, a pointerleave or a move of more than 10 px cancels the long-press', () => {
    const { root, stage, wheel } = mount();
    wheel.attachLongPress(stage);
    for (const type of ['pointercancel', 'pointerleave']) {
      fire(stage, 'pointerdown', { clientX: 50, clientY: 50 });
      vi.advanceTimersByTime(300);
      fire(stage, type);
      vi.advanceTimersByTime(1000);
      expect(isOpen(root), type).toBe(false);
    }
    fire(stage, 'pointerdown', { clientX: 50, clientY: 50 });
    vi.advanceTimersByTime(300);
    fire(stage, 'pointermove', { clientX: 61, clientY: 50 });
    vi.advanceTimersByTime(1000);
    expect(isOpen(root)).toBe(false);
  });

  it('a jitter of up to 10 px does not cancel the long-press', () => {
    const { root, stage, wheel } = mount();
    wheel.attachLongPress(stage);
    fire(stage, 'pointerdown', { clientX: 50, clientY: 50 });
    vi.advanceTimersByTime(200);
    fire(stage, 'pointermove', { clientX: 56, clientY: 58 });
    vi.advanceTimersByTime(200);
    expect(isOpen(root)).toBe(true);
  });

  it('a long-press on an already open wheel keeps it open', () => {
    const { root, stage, wheel } = mount();
    wheel.attachLongPress(stage);
    toggle(root).click();
    fire(stage, 'pointerdown');
    vi.advanceTimersByTime(400);
    expect(isOpen(root)).toBe(true);
  });

  it('can attach several stages', () => {
    const { root, stage, wheel } = mount();
    const other = document.createElement('div');
    document.body.append(other);
    wheel.attachLongPress(stage);
    wheel.attachLongPress(other);
    fire(other, 'pointerdown');
    vi.advanceTimersByTime(400);
    expect(isOpen(root)).toBe(true);
  });

  it('open() and close() work from code', () => {
    const { root, wheel } = mount();
    wheel.open();
    expect(isOpen(root)).toBe(true);
    expect(wheel.isOpen()).toBe(true);
    wheel.close();
    expect(isOpen(root)).toBe(false);
    expect(wheel.isOpen()).toBe(false);
  });

  it('destroy removes the DOM, the Escape listener, the stage listeners and any pending timer', () => {
    const { root, stage, wheel } = mount();
    wheel.attachLongPress(stage);
    fire(stage, 'pointerdown');
    expect(vi.getTimerCount()).toBe(1);
    wheel.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(root.children).toHaveLength(0);
    fire(stage, 'pointerdown');
    expect(vi.getTimerCount()).toBe(0);

    const removed = vi.spyOn(document, 'removeEventListener');
    const second = mount();
    second.wheel.open();
    second.wheel.destroy();
    expect(removed.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
    removed.mockRestore();
    expect(() => second.wheel.destroy()).not.toThrow();
    expect(second.picks).toEqual([]);
  });
});
