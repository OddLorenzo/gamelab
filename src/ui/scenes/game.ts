import type { Role } from '../../core/types';
import type { BlindView, DeafView } from '../../core/views';
import type { EmoteId, EndReason, EndStats, PeerId, RoleView } from '../../net/protocol';
import { el } from '../dom';
import { EMOTES, createEmoteWheel } from '../emotes';
import { t } from '../i18n';
import { ButtonGesture, createThrottle, hitTest, slotAction, toNormalized } from '../input';
import type { LayoutEntry, Point } from '../input';
import { computeLayout, specsFromBlind, specsFromDeaf } from '../layout';
import type { ModuleLayout } from '../layout';
import { drawBlind, drawDeaf, drawPointers } from '../renderer';
import type { Pointer, PressedSlot } from '../renderer';
import { formatClock } from '../timing';
import type { VoiceSession } from '../voice-session';
import { createManual } from './manual';
import type { ManualHandle } from './manual';
import type { GameStartInfo } from './lobby';

export interface Scene {
  destroy(): void;
}

/** Everything the scene takes from the outside, so tests drive time, frames and the screen. */
export interface GameSceneDeps {
  /** Only `setRole` is used: the scene applies the voice rules of the player's role. */
  voice: Pick<VoiceSession, 'setRole'>;
  /** Monotonic ms clock (the 50 ms pointer throttle). */
  now: () => number;
  /** Called once when the game ends. The scene has already stopped everything by then. */
  onEnded: (reason: EndReason, stats?: EndStats) => void;
  /** Default: requestAnimationFrame / cancelAnimationFrame. */
  requestFrame?: (cb: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
  /** Default: the global timers. Used by the deaf clock tick, the button hold, the toast and the emote wheel. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Default: window.devicePixelRatio. Floored at 1, capped at 3. */
  devicePixelRatio?: () => number;
}

const POINTER_MS = 50;
const CLOCK_TICK_MS = 250;
const TOAST_MS = 2000;
const MAX_DPR = 3;
/** A room has 3 players; the bound only protects the maps from a host that invents ids. */
const MAX_SENDERS = 8;
/** `#rrggbb` on purpose: the blind screen turns them into greys from the hex value. */
const POINTER_COLORS = ['#ff6a5c', '#4d9bff', '#ffd23a', '#58d68d'];

interface RoleUi {
  /** A changed view for this role. */
  apply(view: RoleView): void;
  /** Something other than the view changed (an incoming pointer): repaint soon. */
  invalidate(): void;
  destroy(): void;
}

interface Press {
  moduleId: string;
  slot: number;
  gesture: ButtonGesture | null;
}

interface Remote {
  x: number;
  y: number;
  color: string;
}

export function createGameScene(root: HTMLElement, info: GameStartInfo, deps: GameSceneDeps): Scene {
  const game = info.game;
  const setTimer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number));
  const setTick = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearTick = deps.clearInterval ?? ((h) => globalThis.clearInterval(h as number));
  const requestFrame = deps.requestFrame ?? ((cb) => globalThis.requestAnimationFrame(() => cb()));
  const cancelFrame = deps.cancelFrame ?? ((h) => globalThis.cancelAnimationFrame(h as number));
  const readDpr = deps.devicePixelRatio ?? (() => globalThis.devicePixelRatio);

  let alive = true;
  let role: Role | null = null;
  let ui: RoleUi | null = null;
  let lastKey = '';
  let toastTimer: unknown = null;

  /** Order of first appearance: the label ("Player 2") and the pointer color of a peer. */
  const senders = new Map<PeerId, number>();
  const remotes = new Map<PeerId, Remote>();
  const senderIndex = (by: PeerId): number | null => {
    const known = senders.get(by);
    if (known !== undefined) return known;
    if (senders.size >= MAX_SENDERS) return null;
    senders.set(by, senders.size);
    return senders.size - 1;
  };
  const remoteList = (): Pointer[] => [...remotes].map(([id, r]) => ({ id, x: r.x, y: r.y, color: r.color }));

  /* ------------------------------------------------ common DOM */

  const waiting = el('p', { cls: 'hint game-waiting', testid: 'game-waiting', text: t('game.waiting'), attrs: { role: 'status' } });
  const stage = el('div', { cls: 'game-stage', testid: 'game-stage' }, [waiting]);
  const toast = el('div', { cls: 'game-toast', testid: 'game-toast', attrs: { 'aria-hidden': 'true' } });
  toast.hidden = true;
  const live = el('div', { cls: 'sr-only', testid: 'game-live', attrs: { 'aria-live': 'polite' } });
  const banner =
    info.micTrack === null
      ? el('p', { cls: 'banner game-banner', testid: 'game-mic-denied', text: t('ui.mic.denied'), attrs: { role: 'status' } })
      : null;
  const main = el('main', { cls: 'scene game', testid: 'game' }, [banner, stage, toast, live]);
  root.replaceChildren(main);

  const wheel = createEmoteWheel(main, {
    onPick: (id) => {
      if (alive) game.sendEmote(id);
    },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
  });
  // On the blind screen the canvas is the bomb: a held finger there is the button, never the wheel.
  wheel.attachLongPress(stage, (ev) => role !== 'blind' || !(ev.target instanceof Element) || ev.target.closest('canvas') === null);

  /* ------------------------------------------------ canvas roles (blind, deaf) */

  function mountCanvas(r: 'blind' | 'deaf'): RoleUi {
    const canvas = el('canvas', { cls: 'game-canvas', testid: 'game-canvas' });
    canvas.style.touchAction = 'none';
    if (r === 'blind') canvas.setAttribute('data-no-longpress', '');
    stage.append(canvas);

    let ctx: CanvasRenderingContext2D | null = null;
    let view: BlindView | DeafView | null = null;
    let layout: ModuleLayout[] = [];
    let hit: LayoutEntry[] = [];
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let queued = false;
    let frame: unknown = null;
    let lastClock = '';
    const presses = new Map<number, Press>();
    const throttle = createThrottle(POINTER_MS, deps.now);

    const clockOf = (ms: number | null): string => (ms === null ? '' : formatClock(ms));

    function relayout(): void {
      const rect = stage.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) {
        cssW = 0;
        cssH = 0;
        layout = [];
        hit = [];
        return;
      }
      const ratio = readDpr();
      dpr = Number.isFinite(ratio) && ratio >= 1 ? Math.min(ratio, MAX_DPR) : 1;
      cssW = rect.width;
      cssH = rect.height;
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(cssH * dpr);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      const specs = view === null ? [] : view.role === 'blind' ? specsFromBlind(view) : specsFromDeaf(view);
      layout = computeLayout(specs, cssW / cssH);
      hit = layout.map(({ moduleId, slots }) => ({ moduleId, slots }));
    }

    function draw(): void {
      queued = false;
      frame = null;
      if (!alive || view === null || cssW <= 0 || cssH <= 0) return;
      ctx ??= canvas.getContext('2d');
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (view.role === 'blind') {
        const last = [...presses.values()].pop();
        const pressedSlot: PressedSlot | null = last === undefined ? null : { moduleId: last.moduleId, slot: last.slot };
        drawBlind(ctx, cssW, cssH, layout, { strikesLeft: view.strikesLeft, pressedSlot });
      } else {
        const ms = game.msLeft();
        lastClock = clockOf(ms);
        drawDeaf(ctx, cssW, cssH, layout, view, { msLeft: ms });
      }
      drawPointers(ctx, cssW, cssH, remoteList(), { greyscale: r === 'blind' });
    }

    function invalidate(): void {
      if (!alive || queued) return;
      queued = true;
      frame = requestFrame(draw);
    }

    const onResize = (): void => {
      if (!alive) return;
      relayout();
      invalidate();
    };
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onResize);
      observer.observe(stage);
    } else {
      window.addEventListener('resize', onResize);
    }

    let tick: unknown = null;
    if (r === 'deaf') {
      tick = setTick(() => {
        if (alive && clockOf(game.msLeft()) !== lastClock) invalidate();
      }, CLOCK_TICK_MS);
    }

    /* pointer: every role with a bomb on screen shares it; only the blind one acts */

    const pointOf = (ev: PointerEvent): Point => toNormalized(ev, canvas.getBoundingClientRect());
    const share = (ev: PointerEvent, p: Point): void => {
      if (ev.isPrimary === false) return;
      throttle(() => {
        game.sendPointer(p.x, p.y);
      });
    };
    const endPress = (id: number, how: 'up' | 'cancel'): void => {
      const press = presses.get(id);
      if (press === undefined) return;
      presses.delete(id);
      if (press.gesture !== null) {
        if (how === 'up') press.gesture.up();
        else press.gesture.cancel();
      }
      invalidate();
    };

    const onDown = (ev: PointerEvent): void => {
      if (!alive) return;
      const p = pointOf(ev);
      share(ev, p);
      if (typeof canvas.setPointerCapture === 'function') {
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          // the pointer is already gone: the press simply never starts
        }
      }
      if (r !== 'blind') return;
      const target = hitTest(hit, p);
      if (target === null) return;
      const module = layout.find((m) => m.moduleId === target.moduleId);
      if (module === undefined) return;
      endPress(ev.pointerId, 'cancel');
      const { moduleId, slot } = target;
      if (module.kind === 'button') {
        const gesture = new ButtonGesture({
          emit: (action) => {
            if (alive) game.act(moduleId, action);
          },
          setTimeout: setTimer,
          clearTimeout: clearTimer,
        });
        presses.set(ev.pointerId, { moduleId, slot, gesture });
        gesture.down();
      } else {
        const action = slotAction(module.kind, slot);
        if (action === null) return;
        presses.set(ev.pointerId, { moduleId, slot, gesture: null });
        game.act(moduleId, action);
      }
      invalidate();
    };
    const onMove = (ev: PointerEvent): void => {
      if (alive) share(ev, pointOf(ev));
    };
    const onUp = (ev: PointerEvent): void => {
      if (alive) endPress(ev.pointerId, 'up');
    };
    const onCancel = (ev: PointerEvent): void => {
      if (alive) endPress(ev.pointerId, 'cancel');
    };
    const onContextMenu = (ev: Event): void => {
      ev.preventDefault(); // a long hold on the button must not open a menu
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onCancel);
    canvas.addEventListener('contextmenu', onContextMenu);

    relayout();

    return {
      apply(next) {
        if (next.role !== r) return;
        view = next;
        relayout();
        invalidate();
      },
      invalidate,
      destroy() {
        if (frame !== null) cancelFrame(frame);
        frame = null;
        queued = false;
        if (tick !== null) clearTick(tick);
        observer?.disconnect();
        window.removeEventListener('resize', onResize);
        for (const press of presses.values()) press.gesture?.destroy();
        presses.clear();
        canvas.remove();
      },
    };
  }

  /* ------------------------------------------------ mute role */

  function mountMute(): RoleUi {
    const container = el('div', { cls: 'game-manual', testid: 'game-manual' });
    stage.append(container);
    let manual: ManualHandle | null = null;
    let key = '';
    return {
      apply(next) {
        if (next.role !== 'mute') return;
        const k = JSON.stringify(next.manual);
        if (k === key) return;
        key = k;
        manual?.destroy();
        manual = createManual(container, next.manual);
      },
      invalidate() {
        // the mute view has no geometry: nothing to repaint
      },
      destroy() {
        manual?.destroy();
        manual = null;
        container.remove();
      },
    };
  }

  /* ------------------------------------------------ game callbacks (they cannot be unregistered) */

  game.onView((view) => {
    if (!alive) return;
    if (view.role !== role) {
      ui?.destroy();
      role = view.role;
      remotes.clear();
      lastKey = '';
      stage.replaceChildren();
      main.dataset.role = view.role;
      ui = view.role === 'mute' ? mountMute() : mountCanvas(view.role);
      deps.voice.setRole(view.role);
    }
    // The deaf clock comes from game.msLeft(), so the heartbeat's own msLeft is not a change.
    const key = JSON.stringify(view.role === 'deaf' ? { ...view, msLeft: 0 } : view);
    if (key === lastKey) return;
    lastKey = key;
    ui?.apply(view);
  });

  game.onPointer((by, x, y) => {
    if (!alive || by === info.conn.id) return;
    const index = senderIndex(by);
    if (index === null || (role !== 'blind' && role !== 'deaf')) return;
    remotes.set(by, { x, y, color: POINTER_COLORS[index % POINTER_COLORS.length] });
    ui?.invalidate();
  });

  game.onEmote((by, id: EmoteId) => {
    if (!alive || !EMOTES.includes(id)) return;
    const index = senderIndex(by);
    const text = t('game.emoteFrom', {
      player: t('game.player', { n: index === null ? '?' : index + 1 }),
      emote: t(`emote.${id}`),
    });
    live.textContent = text;
    toast.textContent = text;
    toast.hidden = false;
    if (toastTimer !== null) clearTimer(toastTimer);
    toastTimer = setTimer(() => {
      toastTimer = null;
      toast.hidden = true;
    }, TOAST_MS);
  });

  function stop(): void {
    if (!alive) return;
    alive = false;
    ui?.destroy();
    ui = null;
    wheel.destroy();
    if (toastTimer !== null) clearTimer(toastTimer);
    toastTimer = null;
    main.remove();
  }

  game.onEnded((reason, stats) => {
    if (!alive) return;
    stop();
    deps.onEnded(reason, stats);
  });

  return { destroy: stop };
}
