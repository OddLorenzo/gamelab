import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLevel } from '../../src/core/levels';
import { GuestGame } from '../../src/net/guest';
import { HostGame } from '../../src/net/host';
import type { NetMsg, PeerId } from '../../src/net/protocol';
import type { RoomConnection } from '../../src/net/transport';
import { setLang, t } from '../../src/ui/i18n';
import { CODE_ALPHABET, createLobby, sanitizeCode } from '../../src/ui/scenes/lobby';
import type { GameStartInfo, LobbyDeps, LobbyHandle } from '../../src/ui/scenes/lobby';
import styles from '../../src/ui/styles.css?raw';

/* ---------------------------------------------------------------- fakes */

interface FakeConn extends RoomConnection {
  peerIds: PeerId[];
  sent: { to: PeerId; msg: NetMsg }[];
  deliver(from: PeerId, msg: NetMsg): void;
  leave(id: PeerId): void;
  /** The link to `id` never opened (the mesh's watchdog or an ICE failure). */
  failLink(id: PeerId): void;
  /** The signaling socket dropped on its own. */
  closeSignaling(code?: number, reason?: string): void;
  closed: boolean;
}

/** `id` aaaa is the lowest id: that peer is the host once all three are connected. */
const fakeConn = (id: PeerId, peerIds: PeerId[] = []): FakeConn => {
  const messageCbs: ((from: PeerId, msg: NetMsg) => void)[] = [];
  const leftCbs: ((id: PeerId) => void)[] = [];
  const failedCbs: ((id: PeerId) => void)[] = [];
  const closedCbs: ((code: number, reason: string) => void)[] = [];
  const conn: FakeConn = {
    id,
    peerIds,
    sent: [],
    closed: false,
    peers: () => [...conn.peerIds],
    send: (to, msg) => {
      conn.sent.push({ to, msg });
    },
    onMessage: (cb) => {
      messageCbs.push(cb);
    },
    onPeerLeft: (cb) => {
      leftCbs.push(cb);
    },
    onRemoteAudio: () => undefined,
    onLinkFailed: (cb) => {
      failedCbs.push(cb);
    },
    onSignalingClosed: (cb) => {
      closedCbs.push(cb);
    },
    failLink: (who) => {
      for (const cb of failedCbs) cb(who);
    },
    closeSignaling: (code = 1006, reason = '') => {
      for (const cb of closedCbs) cb(code, reason);
    },
    close: () => {
      conn.closed = true;
    },
    deliver: (from, msg) => {
      for (const cb of messageCbs) cb(from, msg);
    },
    leave: (who) => {
      conn.peerIds = conn.peerIds.filter((p) => p !== who);
      for (const cb of leftCbs) cb(who);
    },
  };
  return conn;
};

const NOW = 5_000;

interface Rig {
  root: HTMLElement;
  deps: LobbyDeps & {
    createRoom: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    requestMic: ReturnType<typeof vi.fn>;
    onGameStart: ReturnType<typeof vi.fn>;
    makeHost: ReturnType<typeof vi.fn>;
    makeGuest: ReturnType<typeof vi.fn>;
  };
  handle: LobbyHandle;
  conn: FakeConn;
  /** Every microphone track the fake requestMic handed out, in order. */
  tracks: { stop: ReturnType<typeof vi.fn> }[];
}

const mount = (opts: { id?: PeerId; unlocked?: number[]; code?: string } = {}): Rig => {
  const conn = fakeConn(opts.id ?? 'aaaaaaaa');
  const tracks: Rig['tracks'] = [];
  const deps = {
    createRoom: vi.fn(() => Promise.resolve(opts.code ?? 'ABCD')),
    connect: vi.fn((_code: string, _mic: MediaStreamTrack | null) => Promise.resolve<RoomConnection>(conn)),
    requestMic: vi.fn(() => {
      const track = { kind: 'audio', stop: vi.fn() };
      tracks.push(track);
      return Promise.resolve<MediaStreamTrack | null>(track as unknown as MediaStreamTrack);
    }),
    now: () => NOW,
    unlocked: () => opts.unlocked ?? [1],
    onGameStart: vi.fn(),
    makeHost: vi.fn((c: RoomConnection, level, now) => new HostGame(c, level, now)),
    makeGuest: vi.fn((c: RoomConnection, now) => new GuestGame(c, now)),
    version: 'v0',
  } as Rig['deps'];
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const handle = createLobby(root, deps);
  return { root, deps, handle, conn, tracks };
};

const q = (root: ParentNode, id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null): Promise<void> => {
  if (el === null) throw new Error('element missing');
  el.click();
  await vi.advanceTimersByTimeAsync(0);
};
const type = (input: HTMLInputElement, text: string): void => {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const tick = async (ms = 500): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

const openJoin = async (r: Rig): Promise<HTMLInputElement> => {
  await click(q(r.root, 'join'));
  return q(r.root, 'code-input') as HTMLInputElement;
};
const joinWith = async (r: Rig, code: string): Promise<void> => {
  const input = await openJoin(r);
  type(input, code);
  await click(q(r.root, 'join-go'));
};
const alertText = (r: Rig): string => r.root.querySelector('[role="alert"]')?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  setLang('en');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------- tests */

describe('sanitizeCode', () => {
  it('uppercases, trims, drops letters outside the alphabet and caps at 4', () => {
    expect(sanitizeCode('abcd')).toBe('ABCD');
    expect(sanitizeCode('  ab cd  ')).toBe('ABCD');
    expect(sanitizeCode('ABCDEFGH')).toBe('ABCD');
    expect(sanitizeCode('ilo0-1')).toBe('');
    expect(sanitizeCode('a1b2c3d4e')).toBe('ABCD');
    expect(sanitizeCode('<img>')).toBe('MG');
  });

  it('the alphabet is the Worker one', () => {
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ');
  });
});

describe('start view', () => {
  it('shows Create and Join buttons, language chips and the version footer', () => {
    const r = mount();
    expect(q(r.root, 'create')?.textContent).toBe(t('lobby.create'));
    expect(q(r.root, 'join')?.textContent).toBe(t('lobby.join'));
    expect(q(r.root, 'lang-fr')).not.toBeNull();
    expect(q(r.root, 'lang-en')?.getAttribute('aria-pressed')).toBe('true');
    expect(r.root.querySelector('footer')?.textContent).toContain('v0');
    expect(r.root.querySelector('select')).toBeNull();
  });

  it('all interactive elements are real buttons or inputs, with a label', () => {
    const r = mount();
    for (const b of r.root.querySelectorAll('button')) expect((b.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect(r.root.querySelectorAll('[onclick], [role="button"]')).toHaveLength(0);
  });

  it('switching the language re-renders and keeps focus on the chip', async () => {
    const r = mount();
    const fr = q(r.root, 'lang-fr') as HTMLElement;
    fr.focus();
    await click(fr);
    expect(q(r.root, 'create')?.textContent).toBe(t('lobby.create'));
    expect(t('lobby.create')).not.toBe('Create a room');
    expect(q(r.root, 'lang-fr')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(q(r.root, 'lang-fr'));
  });
});

describe('privacy link', () => {
  const link = (root: ParentNode): HTMLAnchorElement | null => q(root, 'privacy') as HTMLAnchorElement | null;

  it('is in the footer, points at privacy.html next to the page, opens in a NEW tab (the room connection must survive)', () => {
    const r = mount();
    const a = link(r.root);
    expect(a).not.toBeNull();
    expect(a?.tagName).toBe('A');
    expect(a?.closest('footer')).not.toBeNull();
    expect(a?.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}privacy.html`);
    expect(a?.getAttribute('href')).not.toMatch(/^[a-z][a-z0-9+.-]*:|^\/\//i);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('is labelled in both languages', async () => {
    const r = mount();
    expect(link(r.root)?.textContent).toBe('Privacy');
    await click(q(r.root, 'lang-fr'));
    expect(link(r.root)?.textContent).toBe('Confidentialité');
    await click(q(r.root, 'lang-en'));
    expect(link(r.root)?.textContent).toBe('Privacy');
  });

  it('is keyboard focusable (a real link with an href, no negative tabindex)', () => {
    const r = mount();
    const a = link(r.root) as HTMLAnchorElement;
    expect(a.getAttribute('tabindex')).toBeNull();
    a.focus();
    expect(document.activeElement).toBe(a);
  });

  it('is also there in the room view, and the v0 label stays', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    await tick();
    expect(link(r.root)).not.toBeNull();
    expect(link(r.root)?.getAttribute('target')).toBe('_blank');
    expect(link(r.root)?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(r.root.querySelector('footer')?.textContent).toContain('v0');
  });

  it('has a 44 px tap height in the stylesheet', () => {
    const rule = /\.foot-link\s*\{[^}]*\}/.exec(styles)?.[0] ?? '';
    expect(rule).toMatch(/min-height:\s*44px/);
  });
});

describe('join code input', () => {
  it('uppercases, trims and rejects letters outside the alphabet, capped at 4', async () => {
    const r = mount();
    const input = await openJoin(r);
    // a maxlength of 4 would cut a pasted " abcd" to " abc" before sanitizeCode ever ran
    expect(input.maxLength === -1 || input.maxLength >= 12).toBe(true);
    type(input, ' ab cd ');
    expect(input.value).toBe('ABCD');
    type(input, 'xyzzy');
    expect(input.value).toBe('XYZZ');
    type(input, 'i1lo0');
    expect(input.value).toBe('');
    type(input, 'AB<>cde');
    expect(input.value).toBe('ABCD');
  });

  it('a pasted code longer than 4 raw characters keeps its first 4 valid letters', async () => {
    const r = mount();
    const input = await openJoin(r);
    type(input, ' abcd');
    expect(input.value).toBe('ABCD');
    type(input, 'AB CD');
    expect(input.value).toBe('ABCD');
    type(input, 'abcdefg');
    expect(input.value).toBe('ABCD');
    type(input, '  ab   cd  ');
    expect(input.value).toBe('ABCD');
  });

  it('Go is disabled until 4 valid letters are typed', async () => {
    const r = mount();
    const input = await openJoin(r);
    const go = q(r.root, 'join-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(input, 'abc');
    expect(go.disabled).toBe(true);
    type(input, 'abcd');
    expect(go.disabled).toBe(false);
  });

  it('the input has a label and the placeholder', async () => {
    const r = mount();
    const input = await openJoin(r);
    expect(input.getAttribute('aria-label') ?? r.root.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
      t('lobby.codeLabel'),
    );
    expect(input.placeholder).toBe(t('lobby.codePlaceholder'));
  });

  it('joins with the sanitized code', async () => {
    const r = mount();
    await joinWith(r, ' abcd ');
    expect(r.deps.connect).toHaveBeenCalledTimes(1);
    expect(r.deps.connect.mock.calls[0][0]).toBe('ABCD');
    expect(q(r.root, 'room-code')?.textContent).toBe('ABCD');
  });
});

describe('errors', () => {
  it('an unknown code shows err.noRoom and no room view', async () => {
    const r = mount();
    r.deps.connect.mockRejectedValueOnce(new Error('no-room'));
    await joinWith(r, 'ABCD');
    expect(alertText(r)).toBe(t('err.noRoom'));
    expect(q(r.root, 'room-code')).toBeNull();
    expect(q(r.root, 'seats')).toBeNull();
  });

  it('a full room shows err.full', async () => {
    const r = mount();
    r.deps.connect.mockRejectedValueOnce(new Error('full'));
    await joinWith(r, 'ABCD');
    expect(alertText(r)).toBe(t('err.full'));
    expect(q(r.root, 'room-code')).toBeNull();
  });

  it('any other failure shows err.network, for join and for create', async () => {
    const r = mount();
    r.deps.connect.mockRejectedValueOnce(new Error('network'));
    await joinWith(r, 'ABCD');
    expect(alertText(r)).toBe(t('err.network'));

    const c = mount();
    c.deps.createRoom.mockRejectedValueOnce(new TypeError('boom'));
    await click(q(c.root, 'create'));
    expect(alertText(c)).toBe(t('err.network'));
    expect(q(c.root, 'room-code')).toBeNull();
  });

  it('never uses window.alert; the alert region is a role=alert element', async () => {
    const spy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const r = mount();
    r.deps.connect.mockRejectedValueOnce(new Error('full'));
    await joinWith(r, 'ABCD');
    expect(spy).not.toHaveBeenCalled();
    expect(r.root.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it('a second attempt clears the previous error', async () => {
    const r = mount();
    r.deps.connect.mockRejectedValueOnce(new Error('no-room'));
    await joinWith(r, 'ABCD');
    expect(alertText(r)).not.toBe('');
    await click(q(r.root, 'join-go'));
    expect(alertText(r)).toBe('');
  });
});

describe('microphone', () => {
  it('a refused microphone shows the banner and the room still opens', async () => {
    const r = mount();
    r.deps.requestMic.mockResolvedValueOnce(null);
    await click(q(r.root, 'create'));
    expect(q(r.root, 'mic-banner')?.textContent).toBe(t('ui.mic.denied'));
    expect(q(r.root, 'room-code')).not.toBeNull();
    expect(r.deps.connect).toHaveBeenCalledWith('ABCD', null);
  });

  it('a granted microphone is passed to connect and no banner shows', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    expect(q(r.root, 'mic-banner')).toBeNull();
    expect(r.deps.connect.mock.calls[0][1]).toBe(r.tracks[0]);
  });
});

describe('microphone ownership', () => {
  const full = ['bbbbbbbb', 'cccccccc'];

  it('Leave stops the track', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    expect(r.tracks[0].stop).not.toHaveBeenCalled();
    await click(q(r.root, 'leave'));
    expect(r.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('a failed join stops the track, and the retry asks for a fresh one', async () => {
    const r = mount();
    r.deps.connect.mockRejectedValueOnce(new Error('no-room'));
    await joinWith(r, 'ABCD');
    expect(r.tracks[0].stop).toHaveBeenCalledTimes(1);
    await click(q(r.root, 'join-go'));
    expect(r.deps.requestMic).toHaveBeenCalledTimes(2);
    expect(r.deps.connect.mock.calls[1][1]).toBe(r.tracks[1]);
    expect(r.tracks[1].stop).not.toHaveBeenCalled();
    expect(r.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('a failed create stops the track too', async () => {
    const r = mount();
    r.deps.createRoom.mockRejectedValueOnce(new Error('network'));
    await click(q(r.root, 'create'));
    expect(r.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('destroy without a handoff stops the track', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.handle.destroy();
    expect(r.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('destroy while the connection is still pending stops the track once it arrives', async () => {
    const r = mount();
    let resolve: (c: RoomConnection) => void = () => undefined;
    r.deps.connect.mockReturnValueOnce(new Promise<RoomConnection>((res) => (resolve = res)));
    await click(q(r.root, 'create'));
    r.handle.destroy();
    resolve(r.conn);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.conn.closed).toBe(true);
    expect(r.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('a host handoff does NOT stop the track, not even on the destroy that follows', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.conn.peerIds = full;
    await tick();
    await click(q(r.root, 'start'));
    r.handle.destroy();
    expect(r.tracks[0].stop).not.toHaveBeenCalled();
    r.deps.onGameStart.mock.calls[0][0].game.stop();
  });

  it('a guest handoff does NOT stop the track either', async () => {
    const r = mount({ id: 'bbbbbbbb' });
    await joinWith(r, 'ABCD');
    r.conn.peerIds = ['aaaaaaaa', 'cccccccc'];
    await tick();
    r.conn.deliver('aaaaaaaa', {
      t: 'roles',
      assign: { aaaaaaaa: 'blind', bbbbbbbb: 'deaf', cccccccc: 'mute' },
      level: { ...buildLevel(1), seed: 0 },
    });
    r.handle.destroy();
    expect(r.tracks[0].stop).not.toHaveBeenCalled();
    r.deps.onGameStart.mock.calls[0][0].game.stop();
  });
});

describe('focus and busy state', () => {
  it('focus starts on the title', () => {
    const r = mount();
    expect(document.activeElement).toBe(r.root.querySelector('h1'));
    expect(r.root.querySelector('h1')?.getAttribute('tabindex')).toBe('-1');
  });

  it('after Create focus lands on the room code when Start is not yet enabled', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    expect(document.activeElement).toBe(q(r.root, 'room-code-box'));
  });

  it('after Create focus lands on Start when the host is already enabled', async () => {
    const r = mount();
    r.conn.peerIds = ['bbbbbbbb', 'cccccccc'];
    await click(q(r.root, 'create'));
    expect(document.activeElement).toBe(q(r.root, 'start'));
  });

  it('opening the join form focuses the code field', async () => {
    const r = mount();
    const input = await openJoin(r);
    expect(document.activeElement).toBe(input);
  });

  it('a failed join puts focus back on the code field', async () => {
    const r = mount();
    r.deps.connect.mockRejectedValueOnce(new Error('full'));
    await joinWith(r, 'ABCD');
    expect(document.activeElement).toBe(q(r.root, 'code-input'));
  });

  it('a failed create puts focus on the title', async () => {
    const r = mount();
    r.deps.createRoom.mockRejectedValueOnce(new Error('network'));
    await click(q(r.root, 'create'));
    expect(document.activeElement).toBe(r.root.querySelector('h1'));
  });

  it('Leave puts focus on the title', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    await click(q(r.root, 'leave'));
    expect(document.activeElement).toBe(r.root.querySelector('h1'));
  });

  it('a roster change does not steal focus from the control that has it', async () => {
    const r = mount({ unlocked: [1, 2, 3] });
    await click(q(r.root, 'create'));
    r.conn.peerIds = ['bbbbbbbb'];
    await tick(); // first redraw for the new roster
    r.root.querySelector<HTMLElement>('[data-level="2"]')?.focus();
    r.conn.peerIds = ['bbbbbbbb', 'cccccccc'];
    await tick();
    expect(document.activeElement).toBe(r.root.querySelector('[data-level="2"]'));
  });

  it('shows a connecting status and aria-busy while the connection is pending, then clears both on success', async () => {
    const r = mount();
    let resolve: (c: RoomConnection) => void = () => undefined;
    r.deps.connect.mockReturnValueOnce(new Promise<RoomConnection>((res) => (resolve = res)));
    await click(q(r.root, 'create'));
    expect(q(r.root, 'connecting')?.textContent).toBe(t('lobby.connecting'));
    expect(q(r.root, 'connecting')?.getAttribute('role')).toBe('status');
    expect(r.root.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    resolve(r.conn);
    await vi.advanceTimersByTimeAsync(0);
    expect(q(r.root, 'connecting')).toBeNull();
    expect(r.root.querySelector('main')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('clears the connecting status and aria-busy after a failure too', async () => {
    const r = mount();
    let reject: (e: Error) => void = () => undefined;
    r.deps.connect.mockReturnValueOnce(new Promise<RoomConnection>((_res, rej) => (reject = rej)));
    await joinWith(r, 'ABCD');
    expect(q(r.root, 'connecting')).not.toBeNull();
    reject(new Error('network'));
    await vi.advanceTimersByTimeAsync(0);
    expect(q(r.root, 'connecting')).toBeNull();
    expect(r.root.querySelector('main')?.hasAttribute('aria-busy')).toBe(false);
    expect(alertText(r)).toBe(t('err.network'));
  });
});

describe('room view', () => {
  it('create shows the code, three seats with one filled, and polls every 500 ms', async () => {
    const r = mount({ code: 'WXYZ' });
    await click(q(r.root, 'create'));
    expect(r.deps.createRoom).toHaveBeenCalledTimes(1);
    expect(q(r.root, 'room-code')?.textContent).toBe('WXYZ');
    const seats = q(r.root, 'seats') as HTMLElement;
    expect(seats.querySelectorAll('li')).toHaveLength(3);
    expect(seats.querySelectorAll('li[data-filled="true"]')).toHaveLength(1);
    expect(q(r.root, 'waiting')?.textContent).toBe(t('lobby.waiting'));

    r.conn.peerIds = ['bbbbbbbb'];
    await tick(499);
    expect(seats.isConnected && q(r.root, 'seats')?.querySelectorAll('li[data-filled="true"]')).toHaveLength(1);
    await tick(1);
    expect(q(r.root, 'seats')?.querySelectorAll('li[data-filled="true"]')).toHaveLength(2);

    r.conn.peerIds = ['bbbbbbbb', 'cccccccc'];
    await tick();
    expect(q(r.root, 'seats')?.querySelectorAll('li[data-filled="true"]')).toHaveLength(3);
  });

  it('has screen-reader text for the code and a labelled seat list', async () => {
    const r = mount({ code: 'WXYZ' });
    await click(q(r.root, 'create'));
    expect(r.root.querySelector('.sr-only')?.textContent).toContain('W X Y Z');
    expect(q(r.root, 'seats')?.getAttribute('aria-label')).toBe(t('lobby.seats', { count: 1 }));
  });

  it('a hostile room code is text, never markup', async () => {
    const hostile = '<img src=x onerror="window.pwn=1">';
    const r = mount({ code: hostile });
    await click(q(r.root, 'create'));
    expect(q(r.root, 'room-code')?.textContent).toBe(hostile);
    expect(r.root.querySelector('img')).toBeNull();
    expect(r.root.innerHTML).not.toContain('<img');
  });

  it('a hostile typed code cannot become markup either', async () => {
    const r = mount();
    const input = await openJoin(r);
    type(input, '<img src=x onerror=1>');
    expect(input.value).not.toContain('<');
    expect(r.root.querySelector('img')).toBeNull();
  });

  it('destroy clears the polling interval and empties the root', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    expect(vi.getTimerCount()).toBe(1);
    r.handle.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(r.root.childNodes).toHaveLength(0);
  });

  it('Leave closes the connection, stops the polling and returns to the start view', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    await click(q(r.root, 'leave'));
    expect(r.conn.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(q(r.root, 'create')).not.toBeNull();
  });
});

describe('link failure and signaling loss in the lobby', () => {
  const full = ['bbbbbbbb', 'cccccccc'];

  it('a link that cannot be established shows err.linkFailed, keeps the room view and lets the player Leave', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.conn.peerIds = ['bbbbbbbb'];
    await tick();
    r.conn.failLink('cccccccc');
    expect(alertText(r)).toBe(t('err.linkFailed'));
    expect(r.root.querySelector('[role="alert"]')?.textContent).toContain('strict network');
    expect(q(r.root, 'room-code')?.textContent).toBe('ABCD'); // still the room view
    expect(q(r.root, 'seats')).not.toBeNull();
    await click(q(r.root, 'leave'));
    expect(r.conn.closed).toBe(true);
    expect(q(r.root, 'create')).not.toBeNull();
    expect(alertText(r)).toBe('');
  });

  it('the error survives the polling redraws', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.conn.failLink('bbbbbbbb');
    r.conn.peerIds = ['cccccccc'];
    await tick();
    expect(alertText(r)).toBe(t('err.linkFailed'));
  });

  it('a signaling socket that closed while the lobby waits for players shows err.network', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.conn.peerIds = ['bbbbbbbb'];
    await tick();
    r.conn.closeSignaling(1006, 'gone');
    expect(alertText(r)).toBe(t('err.network'));
    expect(q(r.root, 'room-code')).not.toBeNull();
    expect(q(r.root, 'leave')).not.toBeNull();
  });

  it('a signaling close with all three already connected is not an error', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.conn.peerIds = full;
    await tick();
    r.conn.closeSignaling();
    expect(alertText(r)).toBe('');
    expect((q(r.root, 'start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('after Leave, a late failure or close from the old connection shows nothing', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    await click(q(r.root, 'leave'));
    r.conn.failLink('bbbbbbbb');
    r.conn.closeSignaling();
    expect(alertText(r)).toBe('');
    expect(q(r.root, 'create')).not.toBeNull();
  });

  it('after the game starts (host), a late link failure or signaling close does not touch the screen', async () => {
    const r = mount();
    r.deps.onGameStart.mockImplementation(() => {
      r.root.replaceChildren(Object.assign(document.createElement('main'), { id: 'game-scene' }));
    });
    await click(q(r.root, 'create'));
    r.conn.peerIds = full;
    await tick();
    await click(q(r.root, 'start'));
    const before = r.root.innerHTML;
    r.conn.failLink('bbbbbbbb');
    r.conn.closeSignaling();
    await tick(2000);
    expect(r.root.innerHTML).toBe(before);
    expect(r.root.querySelector('#game-scene')).not.toBeNull();
    (r.deps.onGameStart.mock.calls[0][0] as GameStartInfo).game.stop();
  });

  it('after the game starts (guest), a late link failure or signaling close does not touch the screen', async () => {
    const r = mount({ id: 'bbbbbbbb' });
    let info: GameStartInfo | null = null;
    r.deps.onGameStart.mockImplementation((i: GameStartInfo) => {
      info = i;
      r.root.replaceChildren(Object.assign(document.createElement('main'), { id: 'game-scene' }));
    });
    await joinWith(r, 'ABCD');
    r.conn.peerIds = ['aaaaaaaa', 'cccccccc'];
    await tick();
    r.conn.deliver('aaaaaaaa', { t: 'roles', assign: { aaaaaaaa: 'blind', bbbbbbbb: 'deaf', cccccccc: 'mute' }, level: { ...buildLevel(1), seed: 0 } });
    expect(r.deps.onGameStart).toHaveBeenCalledTimes(1);
    const before = r.root.innerHTML;
    r.conn.failLink('cccccccc');
    r.conn.closeSignaling();
    await tick(2000);
    expect(r.root.innerHTML).toBe(before);
    (info as GameStartInfo | null)?.game.stop();
  });
});

describe('host', () => {
  const full = ['bbbbbbbb', 'cccccccc'];

  it('Start is disabled until all three are connected, then enabled', async () => {
    const r = mount({ unlocked: [1] });
    await click(q(r.root, 'create'));
    const start = () => q(r.root, 'start') as HTMLButtonElement | null;
    expect(start()?.disabled).toBe(true);
    r.conn.peerIds = ['bbbbbbbb'];
    await tick();
    expect(start()?.disabled).toBe(true);
    r.conn.peerIds = full;
    await tick();
    expect(start()?.disabled).toBe(false);
    expect(start()?.textContent).toBe(t('lobby.start'));
    r.conn.leave('cccccccc');
    await tick();
    expect(start()?.disabled).toBe(true);
  });

  it('the level chips list exactly the unlocked levels and mark the chosen one', async () => {
    const r = mount({ unlocked: [1, 2, 3, 5] });
    await click(q(r.root, 'create'));
    const chips = () => [...r.root.querySelectorAll<HTMLButtonElement>('[data-level]')];
    expect(chips().map((c) => c.dataset.level)).toEqual(['1', '2', '3', '5']);
    expect(chips().every((c) => c.tagName === 'BUTTON')).toBe(true);
    // the likeliest choice is the furthest unlocked level
    expect(chips().filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.level)).toEqual(['5']);
    chips()[1].focus();
    await click(chips()[1]);
    expect(chips().filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.level)).toEqual(['2']);
    expect(chips().find((c) => c.dataset.level === '2')?.getAttribute('aria-label')).toBe(t('level.n', { n: 2 }));
    expect(document.activeElement).toBe(chips()[1]);
    expect(r.root.querySelector('select')).toBeNull();
  });

  it('version 0 lists no level above 10, even when the progress unlocks one', async () => {
    const r = mount({ unlocked: [1, 2, 9, 10, 11, 12, 100] });
    await click(q(r.root, 'create'));
    const chips = [...r.root.querySelectorAll<HTMLButtonElement>('[data-level]')];
    expect(chips.map((c) => c.dataset.level)).toEqual(['1', '2', '9', '10']);
    expect(chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.level)).toEqual(['10']);
  });

  it('Start builds a HostGame with buildLevel(chosen), calls start() and hands off', async () => {
    const r = mount({ unlocked: [1, 2, 3] });
    await click(q(r.root, 'create'));
    r.conn.peerIds = full;
    await tick();
    await click(r.root.querySelector('[data-level="2"]'));
    await click(q(r.root, 'start'));

    expect(r.deps.makeHost).toHaveBeenCalledTimes(1);
    const [c, level, now] = r.deps.makeHost.mock.calls[0];
    expect(c).toBe(r.conn);
    expect(level).toEqual(buildLevel(2));
    expect(now()).toBe(NOW);
    // start() really ran: roles went out to both guests
    expect(r.conn.sent.filter((s) => s.msg.t === 'roles').map((s) => s.to).sort()).toEqual(full);

    expect(r.deps.onGameStart).toHaveBeenCalledTimes(1);
    const info = r.deps.onGameStart.mock.calls[0][0] as GameStartInfo;
    expect(info.role).toBe('host');
    expect(info.conn).toBe(r.conn);
    expect(info.game).toBeInstanceOf(HostGame);
    expect(info.level).toEqual(buildLevel(2));
    expect(info.code).toBe('ABCD');
    expect(info.micTrack).toBe(r.tracks[0]);
    expect(vi.getTimerCount()).toBe(2); // only the HostGame timers: the lobby polling is gone
    (info.game as HostGame).stop();
  });

  it('hands the game off BEFORE start(), so callbacks registered in onGameStart see the first view', async () => {
    const r = mount();
    const order: string[] = [];
    r.deps.onGameStart.mockImplementation((info: GameStartInfo) => {
      order.push(`handoff sent=${String(r.conn.sent.length)}`);
      (info.game as HostGame).onView(() => order.push('view'));
    });
    await click(q(r.root, 'create'));
    r.conn.peerIds = full;
    await tick();
    await click(q(r.root, 'start'));
    expect(order).toEqual(['handoff sent=0', 'view']);
    r.deps.onGameStart.mock.calls[0][0].game.stop();
  });

  it('a host does not construct a GuestGame', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.conn.peerIds = full;
    await tick();
    expect(r.deps.makeGuest).not.toHaveBeenCalled();
  });

  it('does not start when a player left in the meantime', async () => {
    const r = mount();
    await click(q(r.root, 'create'));
    r.conn.peerIds = full;
    await tick();
    const start = q(r.root, 'start') as HTMLButtonElement;
    r.conn.peerIds = ['bbbbbbbb']; // left, but the next poll has not run yet
    start.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.deps.onGameStart).not.toHaveBeenCalled();
    expect(alertText(r)).toBe(t('err.playerLeft'));
  });
});

describe('guest', () => {
  const guestPeers = ['aaaaaaaa', 'cccccccc']; // aaaaaaaa is the lowest id: the host

  const asGuest = async (): Promise<Rig> => {
    const r = mount({ id: 'bbbbbbbb' });
    await joinWith(r, 'ABCD');
    return r;
  };

  it('never sees Start or level chips, and waits for the host once full', async () => {
    const r = await asGuest();
    r.conn.peerIds = ['aaaaaaaa'];
    await tick();
    expect(q(r.root, 'start')).toBeNull();
    r.conn.peerIds = guestPeers;
    await tick();
    expect(q(r.root, 'start')).toBeNull();
    expect(r.root.querySelectorAll('[data-level]')).toHaveLength(0);
    expect(q(r.root, 'wait-host')?.textContent).toBe(t('lobby.waitHost'));
  });

  it('constructs its GuestGame only when peers().length === 2', async () => {
    const r = await asGuest();
    await tick(1500);
    expect(r.deps.makeGuest).not.toHaveBeenCalled();
    r.conn.peerIds = ['aaaaaaaa'];
    await tick(1500);
    expect(r.deps.makeGuest).not.toHaveBeenCalled();
    r.conn.peerIds = guestPeers;
    await tick();
    expect(r.deps.makeGuest).toHaveBeenCalledTimes(1);
    expect(r.deps.makeGuest.mock.calls[0][0]).toBe(r.conn);
    await tick(2000);
    expect(r.deps.makeGuest).toHaveBeenCalledTimes(1);
  });

  it('hands off when the host sends roles, with the level from the host', async () => {
    const r = await asGuest();
    r.conn.peerIds = guestPeers;
    await tick();
    expect(r.deps.onGameStart).not.toHaveBeenCalled();
    r.conn.deliver('aaaaaaaa', {
      t: 'roles',
      assign: { aaaaaaaa: 'blind', bbbbbbbb: 'deaf', cccccccc: 'mute' },
      level: { ...buildLevel(4), seed: 0 },
    });
    expect(r.deps.onGameStart).toHaveBeenCalledTimes(1);
    const info = r.deps.onGameStart.mock.calls[0][0] as GameStartInfo;
    expect(info.role).toBe('guest');
    expect(info.game).toBeInstanceOf(GuestGame);
    expect(info.level.id).toBe(4);
    expect(info.conn).toBe(r.conn);
    expect(vi.getTimerCount()).toBe(1); // the GuestGame watchdog only: lobby polling cleared
    (info.game as GuestGame).stop();
  });

  it('shows err.hostLeft when the host leaves before the level starts', async () => {
    const r = await asGuest();
    r.conn.peerIds = guestPeers;
    await tick();
    r.conn.leave('aaaaaaaa');
    await vi.advanceTimersByTimeAsync(0);
    expect(alertText(r)).toBe(t('err.hostLeft'));
  });

  it('drops its GuestGame when the roster shrinks and builds a fresh one when full again', async () => {
    const r = await asGuest();
    r.conn.peerIds = guestPeers;
    await tick();
    const first = r.deps.makeGuest.mock.results[0].value as GuestGame;
    const stop = vi.spyOn(first, 'stop');
    r.conn.peerIds = ['aaaaaaaa'];
    await tick();
    expect(stop).toHaveBeenCalledTimes(1);
    r.conn.peerIds = guestPeers;
    await tick();
    expect(r.deps.makeGuest).toHaveBeenCalledTimes(2);
  });
});
