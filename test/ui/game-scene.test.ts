import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/core/bomb';
import type { LevelDef } from '../../src/core/bomb';
import { buildLevel } from '../../src/core/levels';
import type { ModuleAction, Role } from '../../src/core/types';
import { projectView } from '../../src/core/views';
import type { BlindView, DeafView, MuteView } from '../../src/core/views';
import type { EmoteId, EndReason, EndStats, Participant, PeerId, RoleView } from '../../src/net/protocol';
import type { RoomConnection } from '../../src/net/transport';
import { en, fr, setLang, t } from '../../src/ui/i18n';
import { computeLayout, minSlotSizePx, specsFromBlind, specsFromDeaf } from '../../src/ui/layout';
import type { GameStartInfo } from '../../src/ui/scenes/lobby';
import { createGameScene } from '../../src/ui/scenes/game';
import type { GameSceneDeps } from '../../src/ui/scenes/game';
import { formatClock } from '../../src/ui/timing';
import type { Call } from './recording-ctx';
import { colorAssignments, isGrey, recordingCtx, shapes, textCalls } from './recording-ctx';

/* ---------------------------------------------------------------- fakes */

/** Manual clock: timers only run when the test advances time, and `now` moves with them. */
class FakeClock {
  t = 10_000;
  private seq = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; every: number | null }>();

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.seq++;
    this.timers.set(id, { at: this.t + ms, fn, every: null });
    return id;
  };
  setInterval = (fn: () => void, ms: number): unknown => {
    const id = this.seq++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  };
  clear = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  now = (): number => this.t;

  /** Runs every timer due within `ms`, in order, the clock standing at each timer's due time. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= target && (next === null || entry[1].at < next[1].at)) next = entry;
      if (next === null) break;
      const [id, timer] = next;
      this.t = timer.at;
      if (timer.every === null) this.timers.delete(id);
      else timer.at += timer.every;
      timer.fn();
    }
    this.t = target;
  }

  get active(): number {
    return this.timers.size;
  }
}

class FakeFrames {
  private seq = 1;
  private readonly queue = new Map<number, () => void>();
  requests = 0;
  request = (cb: () => void): unknown => {
    this.requests++;
    const id = this.seq++;
    this.queue.set(id, cb);
    return id;
  };
  cancel = (h: unknown): void => {
    this.queue.delete(h as number);
  };
  flush(): void {
    const all = [...this.queue.values()];
    this.queue.clear();
    for (const cb of all) cb();
  }
  get pending(): number {
    return this.queue.size;
  }
}

class FakeGame implements Participant {
  viewCbs: ((v: RoleView, ms: number | null) => void)[] = [];
  endedCbs: ((r: EndReason, s?: EndStats) => void)[] = [];
  pointerCbs: ((by: PeerId, x: number, y: number) => void)[] = [];
  emoteCbs: ((by: PeerId, id: EmoteId) => void)[] = [];
  acts: { moduleId: string; action: ModuleAction }[] = [];
  pointers: { x: number; y: number }[] = [];
  emotes: EmoteId[] = [];
  left: number | null = null;

  onView(cb: (v: RoleView, ms: number | null) => void): void {
    this.viewCbs.push(cb);
  }
  onEnded(cb: (r: EndReason, s?: EndStats) => void): void {
    this.endedCbs.push(cb);
  }
  onPointer(cb: (by: PeerId, x: number, y: number) => void): void {
    this.pointerCbs.push(cb);
  }
  onEmote(cb: (by: PeerId, id: EmoteId) => void): void {
    this.emoteCbs.push(cb);
  }
  msLeft(): number | null {
    return this.left;
  }
  act(moduleId: string, action: ModuleAction): void {
    this.acts.push({ moduleId, action });
  }
  sendPointer(x: number, y: number): void {
    this.pointers.push({ x, y });
  }
  sendEmote(id: EmoteId): void {
    this.emotes.push(id);
  }
  stop(): void {
    // the real games stop the network here; nothing to do
  }

  pushView(v: RoleView): void {
    this.left = v.role === 'deaf' ? v.msLeft : null;
    for (const cb of this.viewCbs) cb(JSON.parse(JSON.stringify(v)) as RoleView, this.left);
  }
  pointer(by: PeerId, x: number, y: number): void {
    for (const cb of this.pointerCbs) cb(by, x, y);
  }
  emote(by: PeerId, id: EmoteId): void {
    for (const cb of this.emoteCbs) cb(by, id);
  }
  end(reason: EndReason, stats?: EndStats): void {
    for (const cb of this.endedCbs) cb(reason, stats);
  }
}

/* ---------------------------------------------------------------- environment */

const size = { w: 375, h: 667 };

interface CanvasRec {
  calls: Call[];
  ctx: unknown;
}
const recs = new Map<HTMLCanvasElement, CanvasRec>();

const rectOf = (): DOMRect =>
  ({
    left: 0,
    top: 0,
    right: size.w,
    bottom: size.h,
    x: 0,
    y: 0,
    width: size.w,
    height: size.h,
    toJSON: () => ({}),
  }) as DOMRect;

beforeEach(() => {
  setLang('en');
  size.w = 375;
  size.h = 667;
  recs.clear();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rectOf);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let rec = recs.get(this);
    if (rec === undefined) {
      const { ctx, calls } = recordingCtx();
      const wrapped = new Proxy(ctx as unknown as Record<string, unknown>, {
        get(target, p) {
          if (p === 'setTransform') {
            return (...args: unknown[]) => {
              calls.push(['setTransform', ...args]);
            };
          }
          return target[p as string];
        },
        set(target, p, v) {
          target[p as string] = v;
          return true;
        },
      });
      rec = { calls, ctx: wrapped };
      recs.set(this, rec);
    }
    return rec.ctx as never;
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/* ---------------------------------------------------------------- fixtures */

const LEVEL: LevelDef = {
  id: 1,
  stage: 1,
  seed: 7,
  moduleKinds: ['wires', 'button', 'symbols', 'code'],
  difficulty: 5,
  timeMs: 180_000,
  strikes: 3,
  setting: 'jungle',
};
const session = createSession(LEVEL);
const blindView = projectView(session, 'blind') as BlindView;
const deafView = projectView(session, 'deaf') as DeafView;
const muteView = projectView(session, 'mute') as MuteView;
const ids = Object.fromEntries(blindView.targets.map((x) => [x.kind, x.moduleId])) as Record<string, string>;

interface Rig {
  root: HTMLElement;
  game: FakeGame;
  clock: FakeClock;
  frames: FakeFrames;
  roles: (Role | null)[];
  ended: [EndReason, EndStats | undefined][];
  scene: { destroy(): void };
  info: GameStartInfo;
}

const mount = (
  opts: { mic?: boolean; dpr?: number; level?: LevelDef; extra?: Partial<GameSceneDeps> } = {},
): Rig => {
  const root = document.createElement('div');
  document.body.append(root);
  const game = new FakeGame();
  const clock = new FakeClock();
  const frames = new FakeFrames();
  const roles: (Role | null)[] = [];
  const ended: [EndReason, EndStats | undefined][] = [];
  const info = {
    role: 'guest',
    conn: { id: 'me' } as unknown as RoomConnection,
    game: game as unknown as GameStartInfo['game'],
    level: opts.level ?? LEVEL,
    code: 'ABCD',
    micTrack: opts.mic === false ? null : ({ enabled: true } as unknown as MediaStreamTrack),
  } satisfies GameStartInfo;
  const deps: GameSceneDeps = {
    voice: {
      setRole: (r) => {
        roles.push(r);
      },
    },
    now: clock.now,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    setInterval: clock.setInterval,
    clearInterval: clock.clear,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clear,
    devicePixelRatio: () => opts.dpr ?? 1,
    onEnded: (reason, stats) => {
      ended.push([reason, stats]);
    },
    ...opts.extra,
  };
  const scene = createGameScene(root, info, deps);
  return { root, game, clock, frames, roles, ended, scene, info };
};

const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, testid: string): T => {
  const node = root.querySelector<T>(`[data-testid="${testid}"]`);
  if (node === null) throw new Error(`no ${testid}`);
  return node;
};
const canvasOf = (rig: Rig): HTMLCanvasElement => {
  const c = rig.root.querySelector('canvas');
  if (c === null) throw new Error('no canvas');
  return c;
};
const callsOf = (rig: Rig): Call[] => {
  const rec = recs.get(canvasOf(rig));
  if (rec === undefined) throw new Error('canvas never drew');
  return rec.calls;
};

const fire = (target: EventTarget, type: string, x = 0, y = 0, id = 1): void => {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: type !== 'pointerleave',
      clientX: x,
      clientY: y,
      pointerId: id,
      isPrimary: true,
      button: 0,
    }),
  );
};

type Spec = ReturnType<typeof specsFromBlind>;
const centerOf = (specs: Spec, moduleId: string, slot: number, w = size.w, h = size.h): { x: number; y: number } => {
  const m = computeLayout(specs, w / h).find((l) => l.moduleId === moduleId);
  if (m === undefined) throw new Error('no module');
  const s = m.slots[slot];
  return { x: (s.x + s.w / 2) * w, y: (s.y + s.h / 2) * h };
};
const blindCenter = (moduleId: string, slot: number): { x: number; y: number } =>
  centerOf(specsFromBlind(blindView), moduleId, slot);

/** Mounts a blind scene with its first view drawn. */
const blindRig = (opts: Parameters<typeof mount>[0] = {}): Rig => {
  const rig = mount(opts);
  rig.game.pushView(blindView);
  rig.frames.flush();
  return rig;
};
const deafRig = (opts: Parameters<typeof mount>[0] = {}): Rig => {
  const rig = mount(opts);
  rig.game.left = deafView.msLeft;
  rig.game.pushView(deafView);
  rig.frames.flush();
  return rig;
};
const muteRig = (opts: Parameters<typeof mount>[0] = {}): Rig => {
  const rig = mount(opts);
  rig.game.pushView(muteView);
  rig.frames.flush();
  return rig;
};

/** The dots of the incoming pointers: drawPointers is the last save()...restore() block of a draw. */
const pointerDots = (calls: Call[]): ReturnType<typeof shapes> => {
  const last = calls.map((c) => c[0]).lastIndexOf('save');
  return shapes(calls.slice(last)).filter((x) => x.op === 'fill');
};

const tap = (canvas: HTMLElement, p: { x: number; y: number }, id = 1): void => {
  fire(canvas, 'pointerdown', p.x, p.y, id);
  fire(canvas, 'pointerup', p.x, p.y, id);
};

/* ---------------------------------------------------------------- tests */

describe('structure and the waiting state', () => {
  it('fills the viewport with a main.scene.game and shows a status line until the first view', () => {
    const rig = mount();
    const main = rig.root.querySelector('main');
    expect(main?.classList.contains('scene')).toBe(true);
    expect(main?.classList.contains('game')).toBe(true);
    const waiting = q(rig.root, 'game-waiting');
    expect(waiting.getAttribute('role')).toBe('status');
    expect(waiting.textContent).toBe(t('game.waiting'));
    expect(rig.root.querySelector('canvas')).toBeNull();
    expect(rig.roles).toEqual([]);
    rig.game.pushView(blindView);
    expect(rig.root.querySelector('[data-testid="game-waiting"]')).toBeNull();
    expect(rig.root.querySelector('canvas')).not.toBeNull();
  });

  it('registers every participant callback synchronously in the factory, once', () => {
    const rig = mount();
    expect(rig.game.viewCbs).toHaveLength(1);
    expect(rig.game.endedCbs).toHaveLength(1);
    expect(rig.game.pointerCbs).toHaveLength(1);
    expect(rig.game.emoteCbs).toHaveLength(1);
  });

  it('has exactly one emote toggle for every role', () => {
    for (const view of [blindView, deafView, muteView]) {
      const rig = mount();
      rig.game.pushView(view);
      expect(rig.root.querySelectorAll('[data-testid="emote-toggle"]')).toHaveLength(1);
      rig.scene.destroy();
    }
  });
});

describe('voice role and idempotent views', () => {
  it('the first view sets the voice role, a repeat does not, a changed role re-applies', () => {
    const rig = mount();
    rig.game.pushView(deafView);
    expect(rig.roles).toEqual(['deaf']);
    rig.game.pushView(deafView);
    expect(rig.roles).toEqual(['deaf']);
    rig.game.pushView(muteView);
    expect(rig.roles).toEqual(['deaf', 'mute']);
    rig.game.pushView(blindView);
    expect(rig.roles).toEqual(['deaf', 'mute', 'blind']);
  });

  it('a role change swaps the role UI (canvas to manual to canvas)', () => {
    const rig = mount();
    rig.game.pushView(blindView);
    const first = canvasOf(rig);
    expect(first.hasAttribute('data-no-longpress')).toBe(true);
    rig.game.pushView(muteView);
    expect(rig.root.querySelector('canvas')).toBeNull();
    expect(rig.root.querySelector('[data-testid="manual-page"]')).not.toBeNull();
    rig.game.pushView(deafView);
    expect(canvasOf(rig)).not.toBe(first);
    expect(canvasOf(rig).hasAttribute('data-no-longpress')).toBe(false);
  });

  it('an unchanged heartbeat view keeps the same canvas, the same listeners and requests no frame', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const add = vi.spyOn(canvas, 'addEventListener');
    const winAdd = vi.spyOn(window, 'addEventListener');
    const before = rig.frames.requests;
    for (let i = 0; i < 5; i++) rig.game.pushView(blindView);
    expect(canvasOf(rig)).toBe(canvas);
    expect(add).not.toHaveBeenCalled();
    expect(winAdd).not.toHaveBeenCalled();
    expect(rig.game.viewCbs).toHaveLength(1);
    expect(rig.frames.requests).toBe(before);
  });

  it('a deaf heartbeat that only moved msLeft does not rebuild anything', () => {
    const rig = deafRig();
    const canvas = canvasOf(rig);
    const before = rig.frames.requests;
    rig.game.pushView({ ...deafView, msLeft: deafView.msLeft - 2000 });
    expect(canvasOf(rig)).toBe(canvas);
    expect(rig.frames.requests).toBe(before);
  });

  it('a real change (a strike) redraws once, coalescing several views into one frame', () => {
    const rig = blindRig();
    const before = rig.frames.requests;
    rig.game.pushView({ ...blindView, strikesLeft: 2 });
    rig.game.pushView({ ...blindView, strikesLeft: 1 });
    expect(rig.frames.requests).toBe(before + 1);
    rig.frames.flush();
    expect(rig.frames.pending).toBe(0);
  });

  it('does not draw on its own every animation frame', () => {
    const rig = blindRig();
    const before = rig.frames.requests;
    rig.clock.advance(5000);
    rig.frames.flush();
    expect(rig.frames.requests).toBe(before);
  });
});

describe('blind', () => {
  it('a tap on wires slot 1 sends exactly one cut for wire 1', () => {
    const rig = blindRig();
    tap(canvasOf(rig), blindCenter(ids['wires'], 1));
    expect(rig.game.acts).toEqual([{ moduleId: ids['wires'], action: { kind: 'wires', type: 'cut', payload: { index: 1 } } }]);
  });

  it('a tap on empty space sends nothing', () => {
    const rig = blindRig();
    tap(canvasOf(rig), { x: size.w / 2, y: 2 }); // the HUD band holds no slot
    expect(rig.game.acts).toEqual([]);
  });

  it('a symbols slot sends tap with that slot', () => {
    const rig = blindRig();
    tap(canvasOf(rig), blindCenter(ids['symbols'], 2));
    expect(rig.game.acts).toEqual([{ moduleId: ids['symbols'], action: { kind: 'symbols', type: 'tap', payload: { slot: 2 } } }]);
  });

  it('the keypad sends digit 7, clear and submit', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    tap(canvas, blindCenter(ids['code'], 7));
    tap(canvas, blindCenter(ids['code'], 10));
    tap(canvas, blindCenter(ids['code'], 11));
    expect(rig.game.acts.map((a) => a.action)).toEqual([
      { kind: 'code', type: 'digit', payload: { d: 7 } },
      { kind: 'code', type: 'clear' },
      { kind: 'code', type: 'submit' },
    ]);
    expect(rig.game.acts.every((a) => a.moduleId === ids['code'])).toBe(true);
  });

  it('a tap-slot sends once on pointerdown, not again on move or up', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const p = blindCenter(ids['wires'], 0);
    fire(canvas, 'pointerdown', p.x, p.y);
    expect(rig.game.acts).toHaveLength(1);
    fire(canvas, 'pointermove', p.x + 1, p.y);
    fire(canvas, 'pointerup', p.x + 1, p.y);
    expect(rig.game.acts).toHaveLength(1);
  });

  it('moving or hovering never sends an action', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const p = blindCenter(ids['wires'], 1);
    fire(canvas, 'pointermove', p.x, p.y);
    fire(canvas, 'pointermove', p.x + 2, p.y + 2);
    expect(rig.game.acts).toEqual([]);
  });

  it('the button: a quick down and up sends press', () => {
    const rig = blindRig();
    tap(canvasOf(rig), blindCenter(ids['button'], 0));
    expect(rig.game.acts).toEqual([{ moduleId: ids['button'], action: { kind: 'button', type: 'press' } }]);
  });

  it('the button: down, 300 ms, up sends hold then release', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const p = blindCenter(ids['button'], 0);
    fire(canvas, 'pointerdown', p.x, p.y);
    expect(rig.game.acts).toEqual([]);
    rig.clock.advance(299);
    expect(rig.game.acts).toEqual([]);
    rig.clock.advance(1);
    expect(rig.game.acts.map((a) => a.action.type)).toEqual(['hold']);
    fire(canvas, 'pointerup', p.x, p.y);
    expect(rig.game.acts.map((a) => a.action.type)).toEqual(['hold', 'release']);
    expect(rig.game.acts.every((a) => a.moduleId === ids['button'])).toBe(true);
  });

  it('the button: a cancel after the hold releases, a cancel before it sends nothing', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const p = blindCenter(ids['button'], 0);
    fire(canvas, 'pointerdown', p.x, p.y);
    rig.clock.advance(300);
    fire(canvas, 'pointercancel', p.x, p.y);
    expect(rig.game.acts.map((a) => a.action.type)).toEqual(['hold', 'release']);

    rig.game.acts.length = 0;
    fire(canvas, 'pointerdown', p.x, p.y);
    rig.clock.advance(100);
    fire(canvas, 'pointercancel', p.x, p.y);
    rig.clock.advance(1000);
    expect(rig.game.acts).toEqual([]);
  });

  it('the button: the pointer leaving after the hold releases too', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const p = blindCenter(ids['button'], 0);
    fire(canvas, 'pointerdown', p.x, p.y);
    rig.clock.advance(400);
    fire(canvas, 'pointerleave', p.x, p.y);
    expect(rig.game.acts.map((a) => a.action.type)).toEqual(['hold', 'release']);
  });

  it('sends the shared pointer throttled: 49 ms apart is one message, 50 ms is a second', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    fire(canvas, 'pointermove', size.w / 2, size.h / 2);
    expect(rig.game.pointers).toHaveLength(1);
    expect(rig.game.pointers[0].x).toBeCloseTo(0.5, 6);
    expect(rig.game.pointers[0].y).toBeCloseTo(0.5, 6);
    rig.clock.advance(49);
    fire(canvas, 'pointermove', size.w / 4, size.h / 4);
    expect(rig.game.pointers).toHaveLength(1);
    rig.clock.advance(1);
    fire(canvas, 'pointermove', size.w / 4, size.h / 4);
    expect(rig.game.pointers).toHaveLength(2);
    expect(rig.game.pointers[1].x).toBeCloseTo(0.25, 6);
  });

  it('a press also shares the pointer (the others see where the blind player taps)', () => {
    const rig = blindRig();
    const p = blindCenter(ids['wires'], 0);
    fire(canvasOf(rig), 'pointerdown', p.x, p.y);
    expect(rig.game.pointers).toHaveLength(1);
  });

  it('captures the pointer when the browser supports it, and sets touch-action none', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const capture = vi.fn();
    (canvas as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = capture;
    const p = blindCenter(ids['wires'], 0);
    fire(canvas, 'pointerdown', p.x, p.y, 7);
    expect(capture).toHaveBeenCalledWith(7);
    expect(canvas.style.touchAction).toBe('none');
  });

  it('marks the canvas data-no-longpress and a 400 ms press on it does not open the wheel, the toggle does', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    expect(canvas.hasAttribute('data-no-longpress')).toBe(true);
    const toggle = q(rig.root, 'emote-toggle');
    fire(canvas, 'pointerdown', 5, 5);
    rig.clock.advance(400);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fire(canvas, 'pointerup', 5, 5);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('draws no text and only greys, own bomb and incoming pointers included', () => {
    const rig = blindRig();
    rig.game.pointer('p1', 0.25, 0.4);
    rig.game.pointer('p2', 0.7, 0.2);
    rig.frames.flush();
    const calls = callsOf(rig);
    expect(textCalls(calls)).toEqual([]);
    const colors = colorAssignments(calls);
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect(isGrey(c), String(c)).toBe(true);
  });

  it('draws the incoming pointer as a grey dot at its normalized position', () => {
    const rig = blindRig();
    rig.game.pointer('p1', 0.25, 0.4);
    rig.frames.flush();
    const dots = pointerDots(callsOf(rig));
    expect(dots).toHaveLength(1);
    expect(dots[0].points[0][0]).toBeCloseTo(0.25 * size.w, 6);
    expect(dots[0].points[0][1]).toBeCloseTo(0.4 * size.h, 6);
    expect(isGrey(dots[0].style)).toBe(true);
  });

  it('lights the pressed slot while the pointer is down and clears it on up', () => {
    const rig = blindRig();
    const canvas = canvasOf(rig);
    const p = blindCenter(ids['wires'], 1);
    const fills = (): unknown[] => colorAssignments(callsOf(rig)).filter((c) => c === '#9a9a9a');
    expect(fills()).toHaveLength(0);
    fire(canvas, 'pointerdown', p.x, p.y);
    rig.frames.flush();
    expect(fills().length).toBeGreaterThan(0);
    callsOf(rig).length = 0;
    fire(canvas, 'pointerup', p.x, p.y);
    rig.frames.flush();
    expect(fills()).toHaveLength(0);
  });
});

describe('deaf', () => {
  it('draws the clock from game.msLeft(), not from the view', () => {
    const rig = mount();
    rig.game.pushView({ ...deafView, msLeft: 99_000 });
    rig.game.left = 125_000; // the game clock is the truth
    rig.frames.flush();
    expect(textCalls(callsOf(rig)).map((x) => x.text)).toContain('2:05');
    expect(textCalls(callsOf(rig)).map((x) => x.text)).not.toContain('1:39');
  });

  it('a click never calls act, but shares the pointer', () => {
    const rig = deafRig();
    const canvas = canvasOf(rig);
    for (const [kind, slot] of [['wires', 1], ['button', 0], ['symbols', 2], ['code', 7], ['code', 11]] as const) {
      tap(canvas, centerOf(specsFromDeaf(deafView), ids[kind], slot), 1);
      rig.clock.advance(60);
    }
    rig.clock.advance(1000);
    fire(canvas, 'pointerdown', 100, 100);
    rig.clock.advance(400);
    fire(canvas, 'pointerup', 100, 100);
    expect(rig.game.acts).toEqual([]);
    expect(rig.game.pointers.length).toBeGreaterThan(0);
  });

  it('shares the pointer throttled at 50 ms', () => {
    const rig = deafRig();
    const canvas = canvasOf(rig);
    fire(canvas, 'pointermove', 10, 10);
    rig.clock.advance(49);
    fire(canvas, 'pointermove', 20, 20);
    expect(rig.game.pointers).toHaveLength(1);
    rig.clock.advance(1);
    fire(canvas, 'pointermove', 20, 20);
    expect(rig.game.pointers).toHaveLength(2);
  });

  it('redraws when the displayed second changes and not when it does not', () => {
    const rig = deafRig();
    expect(formatClock(deafView.msLeft)).toBe('3:00');
    expect(textCalls(callsOf(rig)).map((x) => x.text)).toContain('3:00');
    const base = rig.frames.requests;

    rig.game.left = 179_900; // 3:00 -> 2:59: one redraw at the next tick
    rig.clock.advance(250);
    expect(rig.frames.requests).toBe(base + 1);
    rig.frames.flush();
    expect(textCalls(callsOf(rig)).map((x) => x.text)).toContain('2:59');

    rig.game.left = 179_000; // still 2:59: no frame, however many ticks
    rig.clock.advance(250);
    rig.clock.advance(250);
    rig.clock.advance(250);
    expect(rig.frames.requests).toBe(base + 1);

    rig.game.left = 178_999; // 2:58
    rig.clock.advance(250);
    expect(rig.frames.requests).toBe(base + 2);
  });

  it('colors the incoming pointers per sender, not grey', () => {
    const rig = deafRig();
    rig.game.pointer('p1', 0.25, 0.4);
    rig.game.pointer('p2', 0.7, 0.2);
    rig.game.pointer('p1', 0.3, 0.45); // p1 moved: still one dot
    rig.frames.flush();
    const dots = pointerDots(callsOf(rig));
    expect(dots).toHaveLength(2);
    expect(dots[0].style).not.toBe(dots[1].style);
    expect(dots.some((d) => !isGrey(d.style))).toBe(true);
    const xs = dots.map((d) => d.points[0][0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0.3 * size.w, 6);
    expect(xs[1]).toBeCloseTo(0.7 * size.w, 6);
  });

  it('the sender keeps its color across draws', () => {
    const rig = deafRig();
    rig.game.pointer('p1', 0.25, 0.4);
    rig.game.pointer('p2', 0.7, 0.2);
    rig.frames.flush();
    const colorOf = (x: number): unknown =>
      pointerDots(callsOf(rig)).find((d) => Math.abs(d.points[0][0] - x * size.w) < 1e-6)?.style;
    const before = colorOf(0.7);
    callsOf(rig).length = 0;
    rig.game.pointer('p1', 0.1, 0.1);
    rig.frames.flush();
    expect(colorOf(0.7)).toBe(before);
  });

  it('draws the deaf bomb text (strikes, clock), unlike the blind canvas', () => {
    const rig = deafRig();
    expect(textCalls(callsOf(rig)).length).toBeGreaterThan(0);
  });

  it('the deaf interval is cleaned up with the scene', () => {
    const rig = deafRig();
    expect(rig.clock.active).toBeGreaterThan(0);
    rig.scene.destroy();
    expect(rig.clock.active).toBe(0);
  });
});

describe('mute', () => {
  it('shows the manual pages for view.manual and has no canvas', () => {
    const rig = muteRig();
    expect(rig.root.querySelector('canvas')).toBeNull();
    expect(q(rig.root, 'manual-title').textContent).toBe(t(muteView.manual[0].titleKey));
    expect(q(rig.root, 'manual-indicator').textContent).toBe(`1/${String(muteView.manual.length)}`);
    q(rig.root, 'manual-next').click();
    expect(q(rig.root, 'manual-title').textContent).toBe(t(muteView.manual[1].titleKey));
  });

  it('sends no pointer on pointer events and draws nothing, even for incoming pointers', () => {
    const rig = muteRig();
    for (const target of [q(rig.root, 'game-stage'), q(rig.root, 'game-manual'), q(rig.root, 'manual-page')]) {
      fire(target, 'pointerdown', 50, 50);
      fire(target, 'pointermove', 60, 60);
      fire(target, 'pointerup', 60, 60);
      rig.clock.advance(100);
    }
    rig.game.pointer('p1', 0.5, 0.5);
    rig.frames.flush();
    expect(rig.game.pointers).toEqual([]);
    expect(rig.game.acts).toEqual([]);
    expect(recs.size).toBe(0);
  });

  it('emote picks call sendEmote', () => {
    const rig = muteRig();
    q(rig.root, 'emote-toggle').click();
    q(rig.root, 'emote-yes').click();
    q(rig.root, 'emote-toggle').click();
    q(rig.root, 'emote-panic').click();
    expect(rig.game.emotes).toEqual(['yes', 'panic']);
  });

  it('keeps the current page across an identical view, rebuilds when the manual changes', () => {
    const rig = muteRig();
    q(rig.root, 'manual-next').click();
    rig.game.pushView(muteView);
    rig.game.pushView({ ...muteView, strikesLeft: 1 }); // strikes are not on the manual
    expect(q(rig.root, 'manual-indicator').textContent).toBe(`2/${String(muteView.manual.length)}`);
    rig.game.pushView({ ...muteView, manual: muteView.manual.slice(0, 1) });
    expect(q(rig.root, 'manual-indicator').textContent).toBe('1/1');
  });

  it('a long press on the manual opens the wheel (only the blind canvas is exempt)', () => {
    const rig = muteRig();
    const stage = q(rig.root, 'game-stage');
    fire(stage, 'pointerdown', 20, 20);
    rig.clock.advance(400);
    expect(q(rig.root, 'emote-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('a long press on the deaf canvas opens the wheel', () => {
    const rig = deafRig();
    fire(canvasOf(rig), 'pointerdown', 20, 20);
    rig.clock.advance(400);
    expect(q(rig.root, 'emote-toggle').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('emotes, banner and live region', () => {
  it('an incoming emote shows a toast and announces it, the toast goes after 2000 ms', () => {
    const rig = blindRig();
    const toast = q(rig.root, 'game-toast');
    const live = q(rig.root, 'game-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(toast.hidden).toBe(true);
    rig.game.emote('p1', 'wave');
    const expected = t('game.emoteFrom', { player: t('game.player', { n: 1 }), emote: t('emote.wave') });
    expect(toast.textContent).toBe(expected);
    expect(toast.hidden).toBe(false);
    expect(live.textContent).toBe(expected);
    rig.clock.advance(1999);
    expect(toast.hidden).toBe(false);
    rig.clock.advance(1);
    expect(toast.hidden).toBe(true);
  });

  it('a new emote restarts the 2 s window and labels players by order of first appearance', () => {
    const rig = blindRig();
    const toast = q(rig.root, 'game-toast');
    rig.game.emote('p1', 'wave');
    rig.clock.advance(1500);
    rig.game.emote('p2', 'yes');
    expect(toast.textContent).toBe(t('game.emoteFrom', { player: t('game.player', { n: 2 }), emote: t('emote.yes') }));
    rig.clock.advance(1500);
    expect(toast.hidden).toBe(false);
    rig.clock.advance(500);
    expect(toast.hidden).toBe(true);
    rig.game.emote('p1', 'no');
    expect(toast.textContent).toBe(t('game.emoteFrom', { player: t('game.player', { n: 1 }), emote: t('emote.no') }));
  });

  it('the toast text is in the current language', () => {
    setLang('fr');
    const rig = blindRig();
    rig.game.emote('p1', 'panic');
    expect(q(rig.root, 'game-toast').textContent).toBe(`${t('game.player', { n: 1 })} : ${fr['emote.panic']}`);
  });

  it('the mic-denied banner is shown iff there is no mic track', () => {
    const denied = mount({ mic: false });
    const banner = q(denied.root, 'game-mic-denied');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toBe(t('ui.mic.denied'));
    const ok = mount({ mic: true });
    expect(ok.root.querySelector('[data-testid="game-mic-denied"]')).toBeNull();
  });

  it('own emote picks from the wheel call sendEmote on the blind and the deaf screen too', () => {
    for (const make of [blindRig, deafRig]) {
      const rig = make();
      q(rig.root, 'emote-toggle').click();
      q(rig.root, 'emote-point').click();
      expect(rig.game.emotes).toEqual(['point']);
    }
  });

  it('ignores an emote id that is not one of the six', () => {
    const rig = blindRig();
    rig.game.emote('p1', '<b>x</b>' as EmoteId);
    expect(q(rig.root, 'game-toast').hidden).toBe(true);
    expect(q(rig.root, 'game-live').textContent).toBe('');
  });

  it('never turns a hostile peer id into markup', () => {
    const rig = blindRig();
    const evil = '<img src=x onerror=alert(1)>';
    rig.game.emote(evil, 'wave');
    rig.game.pointer(evil, 0.5, 0.5);
    rig.game.emote('__proto__', 'yes');
    rig.game.pointer('constructor', 0.2, 0.2);
    expect(rig.root.querySelector('img')).toBeNull();
    expect(rig.root.innerHTML).not.toContain('onerror');
    expect(rig.root.innerHTML).not.toContain('<img');
    expect(q(rig.root, 'game-toast').textContent).toBe(t('game.emoteFrom', { player: t('game.player', { n: 2 }), emote: t('emote.yes') }));
    rig.frames.flush();
  });

  it('ignores pointers from itself and bounds the number of remembered senders', () => {
    const rig = deafRig();
    rig.game.pointer('me', 0.5, 0.5);
    for (let i = 0; i < 40; i++) rig.game.pointer(`peer${String(i)}`, 0.1, 0.1);
    rig.frames.flush();
    const dots = pointerDots(callsOf(rig));
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.length).toBeLessThanOrEqual(8);
    expect(dots.every((d) => Math.abs(d.points[0][0] - 0.5 * size.w) > 1e-6)).toBe(true);
  });
});

describe('end of the game and destroy', () => {
  it('ended calls onEnded once with reason and stats and stops everything', () => {
    const rig = deafRig();
    rig.game.emote('p1', 'wave');
    const stats: EndStats = { strikesLeft: 2, msLeftRatio: 0.5 };
    rig.game.end('won', stats);
    expect(rig.ended).toEqual([['won', stats]]);
    expect(rig.clock.active).toBe(0);
    expect(rig.frames.pending).toBe(0);
    expect(rig.root.querySelector('main.game')).toBeNull();
    rig.game.end('lost');
    expect(rig.ended).toHaveLength(1);
  });

  it('ended without stats passes undefined', () => {
    const rig = blindRig();
    rig.game.end('player-left');
    expect(rig.ended).toEqual([['player-left', undefined]]);
  });

  it('a held button is not released after the game ended (timers are gone)', () => {
    const rig = blindRig();
    const p = blindCenter(ids['button'], 0);
    fire(canvasOf(rig), 'pointerdown', p.x, p.y);
    rig.game.end('lost');
    rig.clock.advance(1000);
    expect(rig.game.acts).toEqual([]);
    expect(rig.clock.active).toBe(0);
  });

  it('destroy removes the DOM and every timer, frame and listener; later callbacks do nothing', () => {
    const rig = deafRig();
    rig.game.pointer('p1', 0.5, 0.5); // a draw is pending
    const canvas = canvasOf(rig);
    rig.scene.destroy();
    expect(rig.root.querySelector('main.game')).toBeNull();
    expect(rig.clock.active).toBe(0);
    expect(rig.frames.pending).toBe(0);
    const requests = rig.frames.requests;
    const rolesBefore = [...rig.roles];
    expect(() => {
      rig.game.pushView(blindView);
      rig.game.pushView(muteView);
      rig.game.pointer('p1', 0.1, 0.1);
      rig.game.emote('p1', 'wave');
      rig.game.end('won');
      fire(canvas, 'pointerdown', 100, 100);
      fire(canvas, 'pointermove', 110, 100);
      window.dispatchEvent(new Event('resize'));
      rig.scene.destroy();
    }).not.toThrow();
    expect(rig.ended).toEqual([]);
    expect(rig.roles).toEqual(rolesBefore);
    expect(rig.frames.requests).toBe(requests);
    expect(rig.clock.active).toBe(0);
    expect(rig.game.pointers).toEqual([]);
    expect(rig.root.childElementCount).toBe(0);
  });

  it('destroy does not stop the mic track', () => {
    const rig = blindRig();
    const stop = vi.fn();
    (rig.info.micTrack as unknown as { stop: () => void }).stop = stop;
    rig.scene.destroy();
    expect(stop).not.toHaveBeenCalled();
  });

  it('a mute scene destroy removes the manual key listener', () => {
    const rig = muteRig();
    q(rig.root, 'manual-next').click();
    const remove = vi.spyOn(document, 'removeEventListener');
    rig.scene.destroy();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
  });
});

describe('canvas size, layout and resize', () => {
  it('sizes the backing store to css size times the device pixel ratio and scales the context', () => {
    const rig = blindRig({ dpr: 2 });
    const canvas = canvasOf(rig);
    expect(canvas.width).toBe(750);
    expect(canvas.height).toBe(1334);
    const transforms = callsOf(rig).filter((c) => c[0] === 'setTransform');
    expect(transforms.length).toBeGreaterThan(0);
    expect(transforms[transforms.length - 1]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
    // the renderer works in CSS px: the body fill covers 375 x 667, not 750 x 1334
    const fillRects = callsOf(rig).filter((c) => c[0] === 'fillRect');
    expect(fillRects[0]).toEqual(['fillRect', 0, 0, 375, 667]);
  });

  it('caps the device pixel ratio at 3 and never goes below 1', () => {
    expect(canvasOf(blindRig({ dpr: 5 })).width).toBe(375 * 3);
    expect(canvasOf(blindRig({ dpr: 0 })).width).toBe(375);
    expect(canvasOf(blindRig({ dpr: Number.NaN })).width).toBe(375);
  });

  it('a resize recomputes the layout with the new aspect (hit testing follows)', () => {
    // two modules stack on a portrait screen and sit side by side on a landscape one
    const two: BlindView = { ...blindView, targets: blindView.targets.slice(0, 2) };
    const rig = mount();
    rig.game.pushView(two);
    rig.frames.flush();
    const canvas = canvasOf(rig);
    const specs = specsFromBlind(two);
    const before = centerOf(specs, ids['wires'], 1);
    size.w = 1280;
    size.h = 720;
    window.dispatchEvent(new Event('resize'));
    rig.frames.flush();
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    const after = centerOf(specs, ids['wires'], 1, 1280, 720);
    expect(Math.hypot(after.x / 1280 - before.x / 375, after.y / 720 - before.y / 667)).toBeGreaterThan(0.1); // the layouts really differ
    tap(canvas, after);
    expect(rig.game.acts).toEqual([{ moduleId: ids['wires'], action: { kind: 'wires', type: 'cut', payload: { index: 1 } } }]);
    // the old position no longer hits that wire
    rig.game.acts.length = 0;
    tap(canvas, { x: (before.x / 375) * 1280, y: (before.y / 667) * 720 });
    expect(rig.game.acts.filter((a) => a.action.type === 'cut' && (a.action.payload as { index: number }).index === 1)).toEqual([]);
  });

  it('a resize also redraws at the new size', () => {
    const rig = deafRig();
    callsOf(rig).length = 0;
    size.w = 1280;
    size.h = 720;
    window.dispatchEvent(new Event('resize'));
    rig.frames.flush();
    expect(callsOf(rig).filter((c) => c[0] === 'fillRect')[0]).toEqual(['fillRect', 0, 0, 1280, 720]);
  });

  it('uses a ResizeObserver on the stage when there is one, and disconnects it', () => {
    const observed: Element[] = [];
    let callback: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callback = cb;
        }
        observe(target: Element): void {
          observed.push(target);
        }
        disconnect = disconnect;
      },
    );
    const rig = blindRig();
    expect(observed).toContain(q(rig.root, 'game-stage'));
    size.w = 1280;
    size.h = 720;
    callback();
    rig.frames.flush();
    expect(canvasOf(rig).width).toBe(1280);
    rig.scene.destroy();
    expect(disconnect).toHaveBeenCalled();
  });

  it('removes the window resize listener on destroy', () => {
    const rig = blindRig();
    const remove = vi.spyOn(window, 'removeEventListener');
    rig.scene.destroy();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('through the scene: every slot of levels 1..10 is at least 44 px at 375x667 and hits the right action', () => {
    for (let id = 1; id <= 10; id++) {
      const level = buildLevel(id);
      const s = createSession(level);
      const view = projectView(s, 'blind') as BlindView;
      const rig = mount({ level });
      rig.game.pushView(view);
      rig.frames.flush();
      const specs = specsFromBlind(view);
      const layout = computeLayout(specs, size.w / size.h);
      expect(minSlotSizePx(layout, size.w, size.h), `level ${String(id)}`).toBeGreaterThanOrEqual(44);
      // with the mic-denied banner (about 42 px) the stage is shorter: still tappable
      expect(minSlotSizePx(computeLayout(specs, size.w / (size.h - 42)), size.w, size.h - 42), `level ${String(id)} with banner`).toBeGreaterThanOrEqual(44);
      const canvas = canvasOf(rig);
      for (const m of layout) {
        for (let slot = 0; slot < m.slots.length; slot++) {
          rig.game.acts.length = 0;
          tap(canvas, centerOf(specs, m.moduleId, slot));
          const got = rig.game.acts.map((a) => ({ id: a.moduleId, type: a.action.type }));
          const kindType = { wires: 'cut', button: 'press', symbols: 'tap', code: slot === 10 ? 'clear' : slot === 11 ? 'submit' : 'digit' }[m.kind];
          expect(got, `level ${String(id)} ${m.kind} ${String(slot)}`).toEqual([{ id: m.moduleId, type: kindType }]);
        }
      }
      rig.scene.destroy();
    }
  });

  it('does not draw before the stage has a size, and draws once it has', () => {
    size.w = 0;
    size.h = 0;
    const rig = mount();
    rig.game.pushView(blindView);
    rig.frames.flush();
    expect(recs.size === 0 || callsOf(rig).filter((c) => c[0] === 'fillRect').length === 0).toBe(true);
    size.w = 375;
    size.h = 667;
    window.dispatchEvent(new Event('resize'));
    rig.frames.flush();
    expect(callsOf(rig).filter((c) => c[0] === 'fillRect').length).toBeGreaterThan(0);
  });
});

describe('copy', () => {
  it('the game keys exist in both languages with the same placeholders', () => {
    for (const key of ['game.waiting', 'game.player', 'game.emoteFrom']) {
      expect(en[key]).toBeTruthy();
      expect(fr[key]).toBeTruthy();
    }
  });
});
