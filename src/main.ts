import './ui/styles.css';
import { connectToRoom, createRoom } from './net/signaling';
import { requestMic } from './net/voice';
import { el } from './ui/dom';
import { getLang } from './ui/i18n';
import { loadProgress, saveStars, unlockedLevels } from './ui/progress';
import { createLobby, startHostRound, watchGuestRound } from './ui/scenes/lobby';
import type { GameStartInfo, LobbyDeps, RoundDeps } from './ui/scenes/lobby';
import { createResults } from './ui/scenes/results';
import type { EndReason, EndStats } from './net/protocol';

const WORKER_URL: string = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';
const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'v0';

const ui = document.getElementById('ui');
if (ui === null) throw new Error('index.html is missing <div id="ui">');
document.documentElement.lang = getLang();

interface Scene {
  destroy(): void;
}

type SceneRequest =
  | { name: 'lobby' }
  | { name: 'game'; info: GameStartInfo }
  | { name: 'results'; info: GameStartInfo; reason: EndReason; stats?: EndStats };

let current: Scene | null = null;

const now = (): number => performance.now();

const roundDeps: RoundDeps = { now, onGameStart: (info) => showScene({ name: 'game', info }) };

const lobbyDeps: LobbyDeps = {
  ...roundDeps,
  createRoom: () => createRoom(WORKER_URL),
  requestMic,
  connect: (code, micTrack) => connectToRoom(WORKER_URL, code, micTrack),
  unlocked: () => unlockedLevels(loadProgress()),
  version: APP_VERSION,
};

/** Task 14 replaces this with the in-game scene (canvas, role views, voice, emotes). */
function createGamePlaceholder(root: HTMLElement, info: GameStartInfo): Scene {
  let alive = true;
  root.replaceChildren(
    el('main', { cls: 'scene', testid: 'game-placeholder' }, [
      el('h1', { text: 'Game scene placeholder' }),
      el('p', { cls: 'hint', text: `Level ${String(info.level.id)} - the real scene arrives in a later task.` }),
    ]),
  );
  info.game.onEnded((reason, stats) => {
    if (alive) showScene({ name: 'results', info, reason, stats });
  });
  return {
    destroy() {
      alive = false;
      root.replaceChildren();
    },
  };
}

function leaveRoom(info: GameStartInfo): void {
  info.game.stop();
  info.conn.close();
  showScene({ name: 'lobby' });
}

/** Host: play again (same or next level). Everybody else is already waiting for the roles. */
function playAgain(info: GameStartInfo, levelId: number): void {
  if (!startHostRound(info.conn, levelId, roundDeps, info)) {
    showScene({ name: 'results', info, reason: 'player-left' });
  }
}

function showResults(root: HTMLElement, info: GameStartInfo, reason: EndReason, stats?: EndStats): Scene {
  const finished = reason === 'won' || reason === 'lost';
  if (finished && info.role === 'guest') {
    // wait for the host's next round; a host that leaves first ends the wait
    const waiting = watchGuestRound(info.conn, roundDeps, info, (r) => showScene({ name: 'results', info, reason: r }));
    if (waiting === null) return showResults(root, info, 'player-left');
  }
  return createResults(root, {
    isHost: info.role === 'host',
    reason,
    stats,
    levelId: info.level.id,
    saveStars,
    unlocked: () => unlockedLevels(loadProgress()),
    onNext: () => playAgain(info, info.level.id + 1),
    onRetry: () => playAgain(info, info.level.id),
    onLobby: () => leaveRoom(info),
  });
}

function showScene(req: SceneRequest): void {
  if (ui === null) return;
  current?.destroy();
  current = null;
  switch (req.name) {
    case 'lobby':
      current = createLobby(ui, lobbyDeps);
      break;
    case 'game':
      current = createGamePlaceholder(ui, req.info);
      break;
    case 'results':
      current = showResults(ui, req.info, req.reason, req.stats);
      break;
  }
}

showScene({ name: 'lobby' });
