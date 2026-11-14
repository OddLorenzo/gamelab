import type { EndReason, EndStats } from '../../net/protocol';
import { el } from '../dom';
import { t } from '../i18n';

export type Stars = 0 | 1 | 2 | 3;

const THREE_STARS_TIME_RATIO = 0.4;

/**
 * 3 stars: won with at most one strike used (strikesLeft >= max(1, strikes - 1), where `strikes`
 * is the level's strike budget) and at least 40% of the time left. Any other win (or a win
 * without stats): 2. Every other outcome: 0. The formula never grants 1 star; the type keeps it
 * for later.
 */
export function starsFor(stats: EndStats | undefined, reason: EndReason, strikes: number): Stars {
  if (reason !== 'won') return 0;
  if (stats !== undefined && stats.strikesLeft >= Math.max(1, strikes - 1) && stats.msLeftRatio >= THREE_STARS_TIME_RATIO) {
    return 3;
  }
  return 2;
}

export interface ResultsDeps {
  isHost: boolean;
  reason: EndReason;
  stats?: EndStats;
  levelId: number;
  /** The level's strike budget (LevelDef.strikes), for the 3-star rule. */
  strikes: number;
  /** Called once, for the host, on a win, before anything renders. */
  saveStars: (levelId: number, stars: Stars) => void;
  /** Unlocked level ids, read AFTER the save so a fresh win opens the next level. */
  unlocked: () => number[];
  onNext: () => void;
  onRetry: () => void;
  onLobby: () => void;
}

export interface ResultsHandle {
  destroy(): void;
}

const button = (testid: string, text: string, onClick: () => void, disabled = false): HTMLButtonElement => {
  const b = el('button', { cls: 'btn', text, testid, attrs: { type: 'button' } });
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
};

export function createResults(root: HTMLElement, deps: ResultsDeps): ResultsHandle {
  const { reason } = deps;
  const stars = starsFor(deps.stats, reason, deps.strikes);
  if (deps.isHost && reason === 'won') deps.saveStars(deps.levelId, stars);

  const page = el('main', { cls: 'scene results' });
  const heading = (text: string): HTMLElement => el('h1', { text, attrs: { tabindex: '-1' } });
  if (reason === 'host-left' || reason === 'player-left') {
    page.append(
      heading(t('app.title')),
      el('p', { cls: 'alert', testid: 'error', text: t(reason === 'host-left' ? 'err.hostLeft' : 'err.playerLeft'), attrs: { role: 'alert' } }),
      el('div', { cls: 'actions' }, [button('lobby', t('results.lobby'), deps.onLobby)]),
    );
  } else {
    const row = el('p', { cls: 'stars', testid: 'stars', attrs: { 'aria-hidden': 'true' } });
    for (let i = 1; i <= 3; i++) {
      const filled = i <= stars;
      row.append(el('span', { cls: filled ? 'star on' : 'star', text: filled ? '★' : '☆', attrs: { 'data-filled': String(filled) } }));
    }
    page.append(
      heading(t(reason === 'won' ? 'results.won' : 'results.lost')),
      row,
      el('p', { cls: 'stars-text', testid: 'stars-text', text: t('results.stars', { count: stars }) }),
    );
    if (deps.isHost) {
      const nextOpen = deps.unlocked().includes(deps.levelId + 1);
      page.append(
        el('div', { cls: 'actions' }, [
          button('next', t('results.next'), deps.onNext, !nextOpen),
          button('retry', t('results.retry'), deps.onRetry),
          button('lobby', t('results.lobby'), deps.onLobby),
        ]),
      );
    } else {
      page.append(el('p', { cls: 'hint', testid: 'wait-host', text: t('results.waitHost'), attrs: { role: 'status' } }));
    }
  }
  root.replaceChildren(page);
  page.querySelector('h1')?.focus(); // a new scene: keyboard and screen reader users start at the title

  return {
    destroy() {
      root.replaceChildren();
    },
  };
}
