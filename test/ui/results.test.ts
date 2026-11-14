import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndReason, EndStats } from '../../src/net/protocol';
import { en, setLang, t } from '../../src/ui/i18n';
import { createResults, starsFor } from '../../src/ui/scenes/results';
import type { ResultsDeps } from '../../src/ui/scenes/results';

const stats = (strikesLeft: number, msLeftRatio: number): EndStats => ({ strikesLeft, msLeftRatio });

describe('starsFor', () => {
  it('gives 3 stars exactly at strikesLeft 2 and ratio 0.4', () => {
    expect(starsFor(stats(2, 0.4), 'won')).toBe(3);
    expect(starsFor(stats(3, 1), 'won')).toBe(3);
  });

  it('gives 2 stars just below either boundary', () => {
    expect(starsFor(stats(1, 1), 'won')).toBe(2);
    expect(starsFor(stats(2, 0.399), 'won')).toBe(2);
    expect(starsFor(stats(0, 0.01), 'won')).toBe(2);
  });

  it('gives 2 stars for a win without stats', () => {
    expect(starsFor(undefined, 'won')).toBe(2);
  });

  it('gives 0 for a loss and for every other reason, whatever the stats', () => {
    expect(starsFor(stats(3, 1), 'lost')).toBe(0);
    expect(starsFor(undefined, 'lost')).toBe(0);
    expect(starsFor(stats(3, 1), 'host-left')).toBe(0);
    expect(starsFor(stats(3, 1), 'player-left')).toBe(0);
    expect(starsFor(undefined, 'host-left')).toBe(0);
  });
});

const make = (over: Partial<ResultsDeps> = {}): ResultsDeps => ({
  isHost: true,
  reason: 'won',
  stats: stats(2, 0.5),
  levelId: 3,
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

  it('guest sees no buttons and the wait text', () => {
    createResults(root, make({ isHost: false }));
    expect(root.querySelectorAll('button')).toHaveLength(0);
    expect(q(root, 'wait-host')?.textContent).toBe(t('results.waitHost'));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 3 }));
  });

  it('shows 2 stars for a win that misses the 3-star condition', () => {
    createResults(root, make({ stats: stats(1, 0.9) }));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 2 }));
    expect(q(root, 'stars')?.querySelectorAll('[data-filled="true"]')).toHaveLength(2);
  });

  it('a win saves the stars once, for the host, before the buttons exist', () => {
    const saveStars = vi.fn(() => {
      expect(root.querySelectorAll('button')).toHaveLength(0);
    });
    createResults(root, make({ saveStars }));
    expect(saveStars).toHaveBeenCalledTimes(1);
    expect(saveStars).toHaveBeenCalledWith(3, 3);
  });

  it('does not save for a guest, for a loss, or for an error reason', () => {
    for (const [isHost, reason] of [
      [false, 'won'],
      [true, 'lost'],
      [true, 'host-left'],
      [true, 'player-left'],
    ] as [boolean, EndReason][]) {
      const saveStars = vi.fn();
      createResults(root, make({ isHost, reason, saveStars }));
      expect(saveStars, `${String(isHost)} ${reason}`).not.toHaveBeenCalled();
    }
  });

  it('a loss shows the lost text and 0 stars; Next is locked unless the next level is unlocked', () => {
    createResults(root, make({ reason: 'lost', stats: stats(0, 0), unlocked: () => [1, 2, 3] }));
    expect(root.textContent).toContain(t('results.lost'));
    expect(q(root, 'stars-text')?.textContent).toBe(t('results.stars', { count: 0 }));
    expect((q(root, 'next') as HTMLButtonElement).disabled).toBe(true);
    expect((q(root, 'retry') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Next is enabled when the next level is unlocked (after the save) and disabled at the top level', () => {
    createResults(root, make({ levelId: 3, unlocked: () => [1, 2, 3, 4] }));
    expect((q(root, 'next') as HTMLButtonElement).disabled).toBe(false);
    createResults(root, make({ levelId: 100, unlocked: () => [99, 100] }));
    expect((q(root, 'next') as HTMLButtonElement).disabled).toBe(true);
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
