import type { LevelDef } from '../../core/bomb';
import { buildLevel } from '../../core/levels';
import { GuestGame } from '../../net/guest';
import { HostGame } from '../../net/host';
import type { EndReason } from '../../net/protocol';
import { hostIdOf } from '../../net/transport';
import type { RoomConnection } from '../../net/transport';
import { el } from '../dom';
import { getLang, setLang, t } from '../i18n';
import type { Lang } from '../i18n';

/** Same alphabet as the Worker's room codes. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
const POLL_MS = 500;

/** Upper-case, drop everything outside the room-code alphabet (spaces included), at most 4 letters. */
export function sanitizeCode(raw: string): string {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length === CODE_LENGTH) break;
  }
  return out;
}

/** What the game scene gets once a round is about to run. */
export interface GameStartInfo {
  /** Network role: the lowest PeerId hosts. The player role (blind, deaf, mute) is `game.role`. */
  role: 'host' | 'guest';
  conn: RoomConnection;
  game: HostGame | GuestGame;
  /** Host: buildLevel(id). Guest: the level sent by the host (its seed is blanked). */
  level: LevelDef;
  code: string;
  micTrack: MediaStreamTrack | null;
}

export interface RoundDeps {
  now: () => number;
  /**
   * Host: called BEFORE game.start(), so participant callbacks registered here see the first
   * view. Guest: called when the host's `roles` arrive.
   */
  onGameStart: (info: GameStartInfo) => void;
  makeHost?: (conn: RoomConnection, level: LevelDef, now: () => number) => HostGame;
  makeGuest?: (conn: RoomConnection, now: () => number) => GuestGame;
}

export interface RoundBase {
  code: string;
  micTrack: MediaStreamTrack | null;
}

/**
 * Host side of one round: build the game for `levelId`, hand it over, then start it. False (and
 * nothing built) unless this peer is the host and both other players are connected.
 */
export function startHostRound(conn: RoomConnection, levelId: number, deps: RoundDeps, base: RoundBase): boolean {
  if (conn.peers().length !== 2 || hostIdOf(conn) !== conn.id) return false;
  const level = buildLevel(levelId);
  const game = (deps.makeHost ?? ((c, l, now) => new HostGame(c, l, now)))(conn, level, deps.now);
  deps.onGameStart({ role: 'host', conn, game, level, code: base.code, micTrack: base.micTrack });
  game.start();
  return true;
}

/**
 * Guest side of one round: a GuestGame waiting for the host's roles. Null (nothing built) unless
 * this peer is a guest and both other players are connected. `onEnded` only fires for an end that
 * comes BEFORE the roles (the host left while everybody waited); once the round starts the game
 * scene owns the game's callbacks.
 */
export function watchGuestRound(
  conn: RoomConnection,
  deps: RoundDeps,
  base: RoundBase,
  onEnded?: (reason: EndReason) => void,
): GuestGame | null {
  if (conn.peers().length !== 2 || hostIdOf(conn) === conn.id) return null;
  const game = (deps.makeGuest ?? ((c, now) => new GuestGame(c, now)))(conn, deps.now);
  let started = false;
  game.onRoles((_role, level) => {
    started = true;
    deps.onGameStart({ role: 'guest', conn, game, level, code: base.code, micTrack: base.micTrack });
  });
  game.onEnded((reason) => {
    if (!started) onEnded?.(reason);
  });
  return game;
}

export interface LobbyDeps extends RoundDeps {
  createRoom: () => Promise<string>;
  /** Microphone track for the voice mesh, null when refused. Called on a tap, so the prompt is allowed. */
  requestMic: () => Promise<MediaStreamTrack | null>;
  /** Join room `code` (the host path uses it too, with the code from createRoom). */
  connect: (code: string, micTrack: MediaStreamTrack | null) => Promise<RoomConnection>;
  unlocked: () => number[];
  version?: string;
}

export interface LobbyHandle {
  destroy(): void;
}

type View = 'start' | 'join' | 'room';

const errorKeyOf = (e: unknown): string => {
  const message = e instanceof Error ? e.message : '';
  if (message === 'no-room') return 'err.noRoom';
  if (message === 'full') return 'err.full';
  return 'err.network';
};

export function createLobby(root: HTMLElement, deps: LobbyDeps): LobbyHandle {
  let view: View = 'start';
  let busy = false;
  let destroyed = false;
  let errorKey: string | null = null;
  let micDenied = false;
  let joinCode = '';
  let conn: RoomConnection | null = null;
  let code = '';
  let micTrack: MediaStreamTrack | null = null;
  let guest: GuestGame | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let shownPeers = -1;
  let chosen = 1;

  /** The lobby owns the microphone track until a game takes it over. */
  const stopMic = (): void => {
    micTrack?.stop();
    micTrack = null;
  };

  const stopPoll = (): void => {
    if (poll !== null) clearInterval(poll);
    poll = null;
  };

  const roundDeps: RoundDeps = {
    ...deps,
    onGameStart: (info) => {
      stopPoll();
      guest = null; // handed over: destroy() must not stop it
      micTrack = null; // the game owns the microphone track from here on
      destroyed = true; // the game owns the connection now: nothing here may touch it again
      deps.onGameStart(info);
    },
  };
  const base = (): RoundBase => ({ code, micTrack });

  /* ------------------------------------------------------------ render */

  /**
   * Redraw the whole lobby. Focus: 'keep' restores the control that had it (language chip),
   * 'heading' moves it to the title, 'view' to the first useful thing of the view (the code
   * field, the Start button when enabled, else the room code).
   */
  const render = (focus: 'keep' | 'heading' | 'view' = 'keep'): void => {
    if (destroyed) return;
    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
    const page = el('main', { cls: 'scene lobby' }, [el('h1', { text: t('app.title'), attrs: { tabindex: '-1' } })]);
    if (busy) page.setAttribute('aria-busy', 'true');
    if (micDenied) page.append(el('p', { cls: 'banner', testid: 'mic-banner', text: t('ui.mic.denied'), attrs: { role: 'status' } }));
    if (busy) page.append(el('p', { cls: 'hint', testid: 'connecting', text: t('lobby.connecting'), attrs: { role: 'status' } }));
    page.append(el('p', { cls: errorKey === null ? 'alert empty' : 'alert', testid: 'error', text: errorKey === null ? '' : t(errorKey), attrs: { role: 'alert' } }));
    if (view === 'room' && conn !== null) page.append(roomView(conn));
    else page.append(startView());
    page.append(footer());
    root.replaceChildren(page);
    let target: HTMLElement | null = null;
    if (focus === 'view') {
      const start = root.querySelector<HTMLButtonElement>('[data-testid="start"]');
      target =
        root.querySelector<HTMLElement>('[data-testid="code-input"]') ??
        (start !== null && !start.disabled ? start : root.querySelector<HTMLElement>('[data-testid="room-code-box"]'));
    }
    if (focus !== 'keep') (target ?? root.querySelector<HTMLElement>('h1'))?.focus();
    else if (focusKey !== undefined) root.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`)?.focus();
  };

  const button = (testid: string, text: string, onClick: () => void, cls = 'btn'): HTMLButtonElement => {
    const b = el('button', { cls, text, testid, attrs: { type: 'button', 'data-focus': testid } });
    b.addEventListener('click', onClick);
    return b;
  };

  const startView = (): HTMLElement => {
    const box = el('div', { cls: 'actions' });
    const create = button('create', t('lobby.create'), () => void begin(() => deps.createRoom()), 'btn primary');
    const join = button('join', t('lobby.join'), () => {
      view = 'join';
      errorKey = null;
      render('view');
    });
    create.disabled = busy;
    join.disabled = busy;
    join.setAttribute('aria-expanded', String(view === 'join'));
    box.append(create, join);
    if (view === 'join') box.append(joinForm());
    return box;
  };

  const joinForm = (): HTMLElement => {
    const form = el('form', { cls: 'join-form' });
    const input = el('input', {
      cls: 'code-input',
      testid: 'code-input',
      attrs: {
        type: 'text',
        'aria-label': t('lobby.codeLabel'),
        placeholder: t('lobby.codePlaceholder'),
        autocomplete: 'off',
        autocapitalize: 'characters',
        autocorrect: 'off',
        spellcheck: 'false',
        enterkeyhint: 'go',
        'data-focus': 'code-input',
      },
    });
    input.value = joinCode;
    const go = el('button', { cls: 'btn primary', text: t('lobby.joinGo'), testid: 'join-go', attrs: { type: 'submit' } });
    go.disabled = busy || joinCode.length !== CODE_LENGTH;
    input.addEventListener('input', () => {
      joinCode = sanitizeCode(input.value);
      if (input.value !== joinCode) input.value = joinCode;
      go.disabled = busy || joinCode.length !== CODE_LENGTH;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (joinCode.length === CODE_LENGTH) void begin(() => Promise.resolve(joinCode));
    });
    form.append(input, go);
    return form;
  };

  const roomView = (c: RoomConnection): HTMLElement => {
    const peerCount = c.peers().length;
    const full = peerCount === 2;
    const isHost = hostIdOf(c) === c.id;
    const box = el('section', { cls: 'room' });

    box.append(
      el('p', { cls: 'label', text: t('lobby.codeLabel') }),
      el('p', { cls: 'room-code', testid: 'room-code-box', attrs: { tabindex: '-1' } }, [
        el('span', { cls: 'sr-only', text: `${t('lobby.codeLabel')}: ${[...code].join(' ')}` }),
        el('span', { testid: 'room-code', text: code, attrs: { 'aria-hidden': 'true' } }),
      ]),
    );

    const seats = el('ul', { cls: 'seats', testid: 'seats', attrs: { 'aria-label': t('lobby.seats', { count: peerCount + 1 }) } });
    for (let i = 0; i < 3; i++) {
      const filled = i <= peerCount;
      const label = i === 0 ? t('lobby.seatYou') : filled ? t('lobby.seatFilled') : t('lobby.seatEmpty');
      seats.append(el('li', { cls: filled ? 'seat on' : 'seat', text: label, attrs: { 'data-filled': String(filled) } }));
    }
    box.append(seats);

    if (isHost) {
      box.append(levelPicker());
      const start = button('start', t('lobby.start'), onStart, 'btn primary');
      start.disabled = !full;
      box.append(start);
    }
    if (!full) box.append(el('p', { cls: 'hint', testid: 'waiting', text: t('lobby.waiting'), attrs: { role: 'status' } }));
    else if (!isHost) box.append(el('p', { cls: 'hint', testid: 'wait-host', text: t('lobby.waitHost'), attrs: { role: 'status' } }));

    box.append(button('leave', t('lobby.leave'), leave, 'btn quiet'));
    return box;
  };

  const levelPicker = (): HTMLElement => {
    const ids = deps.unlocked();
    if (!ids.includes(chosen)) chosen = ids.length > 0 ? Math.max(...ids) : 1;
    const wrap = el('div', { cls: 'levels' }, [el('p', { cls: 'label', text: t('lobby.level') })]);
    const chips = el('div', { cls: 'chips', attrs: { role: 'group', 'aria-label': t('lobby.level') } });
    const name = el('p', { cls: 'hint', testid: 'level-name' });
    const describe = (): void => {
      name.textContent = `${t('level.n', { n: chosen })} - ${t(buildLevel(chosen).setting)}`;
    };
    for (const id of ids) {
      const chip = el('button', {
        cls: 'chip',
        text: String(id),
        attrs: { type: 'button', 'data-level': String(id), 'data-focus': `level-${String(id)}`, 'aria-label': t('level.n', { n: id }), 'aria-pressed': String(id === chosen) },
      });
      chip.addEventListener('click', () => {
        chosen = id;
        for (const other of chips.querySelectorAll<HTMLElement>('[data-level]')) other.setAttribute('aria-pressed', String(other === chip));
        describe();
      });
      chips.append(chip);
    }
    describe();
    wrap.append(chips, name);
    return wrap;
  };

  const footer = (): HTMLElement => {
    const lang = el('div', { cls: 'chips', attrs: { role: 'group', 'aria-label': t('lobby.lang') } });
    for (const l of ['fr', 'en'] as Lang[]) {
      const chip = button(`lang-${l}`, l.toUpperCase(), () => {
        setLang(l);
        render();
      }, 'chip');
      chip.setAttribute('aria-pressed', String(getLang() === l));
      lang.append(chip);
    }
    const version = deps.version ?? 'v0';
    return el('footer', { cls: 'foot' }, [lang, el('p', { cls: 'version', text: t('lobby.footerVersion', { version }) })]);
  };

  /* ------------------------------------------------------------ actions */

  /** Create or join: microphone, then the code, then the connection. Any failure becomes an inline error. */
  const begin = async (getCode: () => Promise<string>): Promise<void> => {
    if (busy || destroyed) return;
    busy = true;
    errorKey = null;
    render('heading');
    stopMic(); // never leave an earlier track recording
    try {
      micTrack = await deps.requestMic().catch(() => null);
      if (destroyed) {
        stopMic();
        return;
      }
      micDenied = micTrack === null;
      const room = await getCode();
      const connection = await deps.connect(room, micTrack);
      if (destroyed) {
        connection.close();
        stopMic();
        return;
      }
      conn = connection;
      code = room;
      view = 'room';
      shownPeers = -1;
      busy = false;
      const open = deps.unlocked();
      chosen = open.length > 0 ? Math.max(...open) : 1;
      poll = setInterval(() => sync(), POLL_MS);
      sync('view');
      return;
    } catch (e) {
      errorKey = errorKeyOf(e);
      stopMic();
    }
    busy = false;
    render(view === 'join' ? 'view' : 'heading');
  };

  /** RoomConnection has no peers-changed event: look at it on a timer and redraw when it moved. */
  const sync = (focus: 'keep' | 'view' = 'keep'): void => {
    if (conn === null || destroyed) return;
    const peerCount = conn.peers().length;
    if (peerCount === 2 && guest === null) {
      guest = watchGuestRound(conn, roundDeps, base(), (reason) => {
        errorKey = reason === 'host-left' ? 'err.hostLeft' : 'err.playerLeft';
        render();
      });
    } else if (peerCount !== 2 && guest !== null) {
      guest.stop(); // the host id is fixed at construction: a changed roster needs a new game
      guest = null;
    }
    if (peerCount !== shownPeers) {
      shownPeers = peerCount;
      render(focus);
    }
  };

  const onStart = (): void => {
    if (conn === null) return;
    if (!startHostRound(conn, chosen, roundDeps, base())) {
      errorKey = 'err.playerLeft';
      render();
    }
  };

  const leave = (): void => {
    stopPoll();
    guest?.stop();
    guest = null;
    conn?.close();
    conn = null;
    stopMic();
    view = 'start';
    errorKey = null;
    joinCode = '';
    shownPeers = -1;
    render('heading');
  };

  render('heading');

  return {
    destroy() {
      destroyed = true;
      stopPoll();
      stopMic(); // null after a handoff, so a game's track is never stopped here
      if (guest !== null) guest.stop();
      guest = null;
      root.replaceChildren();
    },
  };
}
