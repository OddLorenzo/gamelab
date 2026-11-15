import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndReason, EndStats } from '../../src/net/protocol';
import type { GameStartInfo, LobbyDeps } from '../../src/ui/scenes/lobby';
import type { ResultsDeps } from '../../src/ui/scenes/results';

// main.ts wires the scenes together at import time: every scene is replaced by a recorder.
const state = vi.hoisted(() => ({
  lobbyDeps: null as unknown,
  resultsDeps: null as unknown,
  gameDeps: null as unknown,
  createLobby: vi.fn(),
  watch: vi.fn(),
  results: vi.fn(),
}));

vi.mock('../../src/ui/styles.css', () => ({}));
vi.mock('../../src/net/signaling', () => ({ createRoom: vi.fn(), connectToRoom: vi.fn() }));
vi.mock('../../src/net/voice', () => ({ requestMic: vi.fn() }));
vi.mock('../../src/ui/voice-session', () => ({
  createVoiceSession: () => ({ setRole: vi.fn(), setPeerRoles: vi.fn(), destroy: vi.fn() }),
}));
vi.mock('../../src/ui/scenes/lobby', () => ({
  createLobby: (_root: unknown, deps: unknown) => {
    state.lobbyDeps = deps;
    state.createLobby();
    return { destroy: vi.fn() };
  },
  startHostRound: vi.fn(() => true),
  watchGuestRound: (...args: unknown[]) => state.watch(...args) as unknown,
}));
vi.mock('../../src/ui/scenes/game', () => ({
  createGameScene: (_root: unknown, _info: unknown, deps: unknown) => {
    state.gameDeps = deps;
    return { destroy: vi.fn() };
  },
}));
vi.mock('../../src/ui/scenes/results', () => ({
  createResults: (_root: unknown, deps: unknown) => {
    state.resultsDeps = deps;
    state.results();
    return { destroy: vi.fn() };
  },
}));

const fakeInfo = (role: 'host' | 'guest') => {
  const game = { stop: vi.fn() };
  const conn = { id: 'me', close: vi.fn() };
  const mic = { stop: vi.fn() };
  const info = { role, conn, game, level: { id: 3, strikes: 3 }, code: 'ABCD', micTrack: mic } as unknown as GameStartInfo;
  return { info, game, conn, mic };
};

/** Boots main.ts, starts a game through the lobby and ends it with `reason`. */
const finishRound = async (info: GameStartInfo, reason: EndReason, stats?: EndStats): Promise<void> => {
  vi.resetModules();
  document.body.innerHTML = '<div id="ui"></div>';
  await import('../../src/main');
  (state.lobbyDeps as LobbyDeps).onGameStart(info);
  (state.gameDeps as { onEnded: (r: EndReason, s?: EndStats) => void }).onEnded(reason, stats);
};

describe('main: results wiring', () => {
  beforeEach(() => {
    state.createLobby.mockClear();
    state.watch.mockReset();
    state.results.mockClear();
  });

  it('a guest gets a waiting game on the results screen and Lobby stops it, closes the room and returns to the lobby', async () => {
    const waiting = { stop: vi.fn() };
    state.watch.mockReturnValue(waiting);
    const { info, conn, game, mic } = fakeInfo('guest');
    await finishRound(info, 'won', { strikesLeft: 3, msLeftRatio: 1 });
    expect(state.watch).toHaveBeenCalledTimes(1);
    const deps = state.resultsDeps as ResultsDeps;
    expect(deps.isHost).toBe(false);
    expect(waiting.stop).not.toHaveBeenCalled();
    state.createLobby.mockClear();

    deps.onLobby();
    expect(waiting.stop).toHaveBeenCalledTimes(1);
    expect(game.stop).toHaveBeenCalledTimes(1);
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(mic.stop).toHaveBeenCalledTimes(1);
    expect(state.createLobby).toHaveBeenCalledTimes(1);
  });

  it('a guest after a loss can leave too', async () => {
    const waiting = { stop: vi.fn() };
    state.watch.mockReturnValue(waiting);
    const { info, conn } = fakeInfo('guest');
    await finishRound(info, 'lost', { strikesLeft: 0, msLeftRatio: 0 });
    (state.resultsDeps as ResultsDeps).onLobby();
    expect(waiting.stop).toHaveBeenCalledTimes(1);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it('a waiting game that became the next round is left alone when the next results appear', async () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    state.watch.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { info } = fakeInfo('guest');
    await finishRound(info, 'won', { strikesLeft: 3, msLeftRatio: 1 });
    // the host starts the next round: the waiting game is the game of that round now
    (state.lobbyDeps as LobbyDeps).onGameStart({ ...info, game: first as unknown as GameStartInfo['game'] });
    (state.gameDeps as { onEnded: (r: EndReason, s?: EndStats) => void }).onEnded('lost');
    expect(first.stop).not.toHaveBeenCalled(); // handed over to the game scene, not stopped as a stale waiting game
    (state.resultsDeps as ResultsDeps).onLobby();
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(first.stop).toHaveBeenCalledTimes(1); // once, through info.game: the round it ran is over
  });

  it('the host builds no waiting game; Lobby closes the room', async () => {
    const { info, conn } = fakeInfo('host');
    await finishRound(info, 'won', { strikesLeft: 3, msLeftRatio: 1 });
    expect(state.watch).not.toHaveBeenCalled();
    const deps = state.resultsDeps as ResultsDeps;
    expect(deps.isHost).toBe(true);
    deps.onLobby();
    expect(conn.close).toHaveBeenCalledTimes(1);
  });
});
