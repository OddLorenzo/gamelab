import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndReason, EndStats } from '../../src/net/protocol';
import { en, fr, setLang, t } from '../../src/ui/i18n';
import { V0_MAX_LEVEL } from '../../src/ui/progress';
import { createResults, starsFor } from '../../src/ui/scenes/results';
import type { ResultsDeps } from '../../src/ui/scenes/results';

const stats = (strikesLeft: number, msLeftRatio: number): EndStats => ({ strikesLeft, msLeftRatio });

describe('starsFor', () => {
  it('strikes 3: 3 stars need strikesLeft >= 2, exactly at the boundary', () => {
    expect(starsFor(stats(2, 0.4), 'won', 3)).toBe(3);
    expect(starsFor(stats(3, 1), 'won', 3)).toBe(3);
    expect(starsFor(stats(1, 1), 'won', 3)).toBe(2);
    expect(starsFor(stats(0, 1), 'won', 3)).toBe(2);
  });

  it('strikes 2: 3 stars need strikesLeft >= 1', () => {
    expect(starsFor(stats(1, 0.4), 'won', 2)).toBe(3);
    expect(starsFor(stats(2, 1), 'won', 2)).toBe(3);
    expect(starsFor(stats(0, 1), 'won', 2)).toBe(2);
  });

  it('strikes 1 (stage 7+): 3 stars are reachable with no strike used', () => {
    expect(starsFor(stats(1, 0.4), 'won', 1)).toBe(3);
    expect(starsFor(stats(1, 1), 'won', 1)).toBe(3);
    expect(starsFor(stats(0, 1), 'won', 1)).toBe(2);
  });

  it('the time boundary is 0.4 exactly: just below gives 2, whatever the strikes', () => {
    for (const strikes of [1, 2, 3]) {
      expect(starsFor(stats(3, 0.4), 'won', strikes), String(strikes)).toBe(3);
      expect(starsFor(stats(3, 0.399), 'won', strikes), String(strikes)).toBe(2);
    }
  });

  it('gives 2 stars for a win without stats', () => {
    for (const strikes of [1, 2, 3]) expect(starsFor(undefined, 'won', strikes)).toBe(2);
  });

  it('gives 0 for a loss and for every other reason, whatever the stats', () => {
    for (const strikes of [1, 2, 3]) {
      expect(starsFor(stats(3, 1), 'lost', strikes)).toBe(0);
      expect(starsFor(undefined, 'lost', strikes)).toBe(0);
      expect(starsFor(stats(3, 1), 'host-left', strikes)).toBe(0);
      expect(starsFor(stats(3, 1), 'player-left', strikes)).toBe(0);
      expect(starsFor(undefined, 'host-left', strikes)).toBe(0);
    }
  });
});

const make = (over: Partial<ResultsDeps> = {}): ResultsDeps => ({
  isHost: true,
  reason: 'won',
  stats: stats(2, 0.5),
  levelId: 3,
  strikes: 3,
  saveStars: vi.fn(),
  unlocked: () => [1, 2, 3, 4],
  onNext: vi.fn(),
  onRetry: vi.fn(),
  onLobby: vi.fn(),
  ...over,
});

const q = (root: HTMLElement, id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);

describe('createResults', () => {
  let root: HTMLElement;
  beforeEach(() => {
    setLang('en');
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  it('host sees the win text, accessible star text and three buttons', () => {
    createResults(root, make());
    expect(root.textContent).toContain(t('results.won'));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 3 }));
    expect(q(root, 'next')?.textContent).toBe(t('results.next'));
    expect(q(root, 'retry')?.textContent).toBe(t('results.retry'));
    expect(q(root, 'lobby')?.textContent).toBe(t('results.lobby'));
    expect(root.querySelectorAll('button')).toHaveLength(3);
    expect(root.textContent).not.toContain(t('results.waitHost'));
  });

  it('guest sees a Lobby button (and only that) plus the wait text', () => {
    const deps = make({ isHost: false });
    createResults(root, deps);
    expect(root.querySelectorAll('button')).toHaveLength(1);
    expect(q(root, 'lobby')?.textContent).toBe(t('results.lobby'));
    expect(q(root, 'next')).toBeNull();
    expect(q(root, 'retry')).toBeNull();
    expect(q(root, 'wait-host')?.textContent).toBe(t('results.waitHost'));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 3 }));
    (q(root, 'lobby') as HTMLButtonElement).click();
    expect(deps.onLobby).toHaveBeenCalledTimes(1);
  });

  it('guest after a loss also gets the Lobby button', () => {
    createResults(root, make({ isHost: false, reason: 'lost', stats: stats(0, 0) }));
    expect(q(root, 'lobby')).not.toBeNull();
    expect(root.querySelectorAll('button')).toHaveLength(1);
  });

  it('a 1-strike level can show 3 stars when no strike was used', () => {
    createResults(root, make({ strikes: 1, stats: stats(1, 0.5) }));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 3 }));
  });

  it('moves focus to the title when it appears', () => {
    createResults(root, make());
    expect(document.activeElement).toBe(root.querySelector('h1'));
    createResults(root, make({ reason: 'host-left', stats: undefined }));
    expect(document.activeElement).toBe(root.querySelector('h1'));
  });

  it('shows 2 stars for a win that misses the 3-star condition', () => {
    createResults(root, make({ stats: stats(1, 0.9) }));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 2 }));
    expect(q(root, 'stars')?.querySelectorAll('[data-filled="true"]')).toHaveLength(2);
  });

  it('a win saves the stars once, before the buttons exist, on the host and on a guest', () => {
    for (const isHost of [true, false]) {
      root.replaceChildren();
      const saveStars = vi.fn(() => {
        expect(root.querySelectorAll('button')).toHaveLength(0);
      });
      createResults(root, make({ isHost, saveStars }));
      expect(saveStars, String(isHost)).toHaveBeenCalledTimes(1);
      expect(saveStars, String(isHost)).toHaveBeenCalledWith(3, 3);
    }
  });

  it('a guest without stats saves 2 stars on a win', () => {
    const saveStars = vi.fn();
    createResults(root, make({ isHost: false, stats: undefined, saveStars }));
    expect(saveStars).toHaveBeenCalledWith(3, 2);
  });

  it('does not save for a loss or an error reason, host or guest', () => {
    for (const isHost of [true, false]) {
      for (const reason of ['lost', 'host-left', 'player-left'] as EndReason[]) {
        const saveStars = vi.fn();
        createResults(root, make({ isHost, reason, saveStars }));
        expect(saveStars, `${String(isHost)} ${reason}`).not.toHaveBeenCalled();
      }
    }
  });

  it('a loss shows the lost text and 0 stars; Next is locked unless the next level is unlocked', () => {
    createResults(root, make({ reason: 'lost', stats: stats(0, 0), unlocked: () => [1, 2, 3] }));
    expect(root.textContent).toContain(t('results.lost'));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 0 }));
    expect((q(root, 'next') as HTMLButtonElement).disabled).toBe(true);
    expect((q(root, 'retry') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Next is enabled when the next level is unlocked (after the save)', () => {
    createResults(root, make({ levelId: 3, unlocked: () => [1, 2, 3, 4] }));
    expect((q(root, 'next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('after the v0 last level there is no Next button; a win shows the all-done note, a loss does not', () => {
    expect(V0_MAX_LEVEL).toBe(10);
    createResults(root, make({ levelId: V0_MAX_LEVEL, unlocked: () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }));
    expect(q(root, 'next')).toBeNull();
    expect(q(root, 'retry')).not.toBeNull();
    expect(q(root, 'all-done')?.textContent).toBe(t('results.allDone'));
    createResults(root, make({ levelId: V0_MAX_LEVEL, reason: 'lost', stats: stats(0, 0) }));
    expect(q(root, 'next')).toBeNull();
    expect(q(root, 'all-done')).toBeNull();
    // level 9 still has its Next, and no note
    createResults(root, make({ levelId: V0_MAX_LEVEL - 1, unlocked: () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }));
    expect(q(root, 'next')).not.toBeNull();
    expect(q(root, 'all-done')).toBeNull();
  });

  it('a guest after the last level sees the all-done note and the Lobby button', () => {
    createResults(root, make({ isHost: false, levelId: V0_MAX_LEVEL }));
    expect(q(root, 'all-done')).not.toBeNull();
    expect(q(root, 'lobby')).not.toBeNull();
  });

  it('results.allDone exists in both languages', () => {
    expect(en['results.allDone']).toBeTruthy();
    expect(fr['results.allDone']).toBeTruthy();
  });

  it('the buttons call their handlers and are at least 44px by CSS contract', () => {
    const deps = make();
    createResults(root, deps);
    (q(root, 'next') as HTMLButtonElement).click();
    (q(root, 'retry') as HTMLButtonElement).click();
    (q(root, 'lobby') as HTMLButtonElement).click();
    expect(deps.onNext).toHaveBeenCalledTimes(1);
    expect(deps.onRetry).toHaveBeenCalledTimes(1);
    expect(deps.onLobby).toHaveBeenCalledTimes(1);
    for (const b of root.querySelectorAll('button')) expect(b.classList.contains('btn')).toBe(true);
  });

  it('host-left and player-left show the matching error and only a Lobby button, for host and guest', () => {
    for (const isHost of [true, false]) {
      for (const [reason, key] of [
        ['host-left', 'err.hostLeft'],
        ['player-left', 'err.playerLeft'],
      ] as [EndReason, string][]) {
        const deps = make({ isHost, reason, stats: undefined });
        createResults(root, deps);
        expect(q(root, 'error')?.textContent).toBe(t(key));
        expect(q(root, 'error')?.getAttribute('role')).toBe('alert');
        expect(root.querySelectorAll('button')).toHaveLength(1);
        expect(q(root, 'lobby')).not.toBeNull();
        expect(root.textContent).not.toContain(t('results.won'));
        (q(root, 'lobby') as HTMLButtonElement).click();
        expect(deps.onLobby).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('renders in the current language', () => {
    setLang('fr');
    createResults(root, make());
    expect(root.textContent).toContain(t('results.won'));
    expect(t('results.won')).not.toBe(en['results.won']);
  });

  it('destroy empties the root', () => {
    const h = createResults(root, make());
    h.destroy();
    expect(root.childNodes).toHaveLength(0);
  });
});
