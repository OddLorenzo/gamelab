import './ui/styles.css';
import { connectToRoom, createRoom } from './net/signaling';
import { requestMic } from './net/voice';
import { getLang } from './ui/i18n';
import { loadProgress, saveStars, unlockedLevels } from './ui/progress';
import { createGameScene } from './ui/scenes/game';
import { createLobby, startHostRound, watchGuestRound } from './ui/scenes/lobby';
import type { GameStartInfo, LobbyDeps, RoundDeps } from './ui/scenes/lobby';
import { createResults } from './ui/scenes/results';
import { createVoiceSession } from './ui/voice-session';
import type { VoiceSession } from './ui/voice-session';
import type { EndReason, EndStats } from './net/protocol';
import type { RoomConnection } from './net/transport';

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

/**
 * One voice session per room connection: the connection's remote-audio callbacks cannot be
 * unregistered, and the streams arrive while the players are still in the lobby, so the session
 * is created as soon as the connection exists (see `connect` below).
 */
const voices = new WeakMap<RoomConnection, VoiceSession>();

function voiceOf(conn: RoomConnection, micTrack: MediaStreamTrack | null): VoiceSession {
  let voice = voices.get(conn);
  if (voice === undefined) {
    voice = createVoiceSession(conn, micTrack);
    voices.set(conn, voice);
  }
  return voice;
}

const roundDeps: RoundDeps = { now, onGameStart: (info) => showScene({ name: 'game', info }) };

const lobbyDeps: LobbyDeps = {
  ...roundDeps,
  createRoom: () => createRoom(WORKER_URL),
  requestMic,
  connect: async (code, micTrack) => {
    const conn = await connectToRoom(WORKER_URL, code, micTrack);
    voiceOf(conn, micTrack);
    return conn;
  },
  unlocked: () => unlockedLevels(loadProgress()),
  version: APP_VERSION,
};

function leaveRoom(info: GameStartInfo): void {
  info.game.stop();
  info.conn.close();
  voices.get(info.conn)?.destroy();
  voices.delete(info.conn);
  info.micTrack?.stop(); // the browser's recording indicator must go off
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
    strikes: info.level.strikes,
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
      current = createGameScene(ui, req.info, {
        voice: voiceOf(req.info.conn, req.info.micTrack),
        now,
        onEnded: (reason, stats) => showScene({ name: 'results', info: req.info, reason, stats }),
      });
      break;
    case 'results':
      voices.get(req.info.conn)?.setRole(null); // between levels everybody may talk again
      current = showResults(ui, req.info, req.reason, req.stats);
      break;
  }
}

showScene({ name: 'lobby' });
