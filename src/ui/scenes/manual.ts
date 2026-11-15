import type { ManualEntry } from '../../core/types';
import { SYMBOL_COLUMNS } from '../../core/modules/symbols';
import { el } from '../dom';
import { glyphChar, glyphNameKey } from '../glyphs';
import { t } from '../i18n';

const SWIPE_PX = 40;
const COLOR_IDS = ['red', 'blue', 'yellow', 'green', 'white', 'orange', 'teal', 'purple', 'pink'] as const;

/**
 * A manual string in the current language. Rule texts name colors with `{red}`, `{blue}`, ...
 * placeholders so the color words come from one place (`color.<id>`). Lines are separated by "\n".
 */
export function manualText(key: string): string {
  const vars: Record<string, string> = {};
  for (const c of COLOR_IDS) vars[c] = t(`color.${c}`);
  return t(key, vars);
}

export interface ManualHandle {
  destroy(): void;
}

const symbolTable = (): HTMLElement =>
  el(
    'ul',
    { cls: 'symbol-columns' },
    SYMBOL_COLUMNS.map((column, c) =>
      el('li', { cls: 'symbol-column', testid: 'symbol-column' }, [
        el('h3', { cls: 'symbol-column-title', text: t('manual.column', { n: c + 1 }) }),
        el(
          'ol',
          { cls: 'symbol-glyphs' },
          column.map((id) =>
            el('li', { cls: 'symbol-glyph', testid: 'symbol-glyph', attrs: { 'data-glyph': id } }, [
              el('span', { cls: 'glyph-char', text: glyphChar(id), attrs: { 'aria-hidden': 'true' } }),
              el('span', { cls: 'glyph-name', text: t(glyphNameKey(id)) }),
            ]),
          ),
        ),
      ]),
    ),
  );

/**
 * The mute player's manual: one page per entry, Prev/Next buttons, Left/Right arrow keys and a
 * horizontal swipe of 40 px or more. All text goes in through textContent.
 */
export function createManual(root: HTMLElement, entries: ManualEntry[]): ManualHandle {
  if (entries.length === 0) {
    root.replaceChildren(
      el('main', { cls: 'scene manual' }, [
        el('p', { cls: 'hint', testid: 'manual-empty', text: t('manual.empty'), attrs: { role: 'status' } }),
      ]),
    );
    return {
      destroy() {
        root.replaceChildren();
      },
    };
  }

  let index = 0;
  const title = el('h2', { cls: 'manual-title', testid: 'manual-title', attrs: { 'aria-live': 'polite' } });
  const body = el('div', { cls: 'manual-body' });
  const page = el('div', { cls: 'manual-page', testid: 'manual-page' }, [title, body]);
  const prev = el('button', {
    cls: 'btn manual-nav-btn',
    text: '‹',
    testid: 'manual-prev',
    attrs: { type: 'button', 'aria-label': t('manual.prev') },
  });
  const next = el('button', {
    cls: 'btn manual-nav-btn',
    text: '›',
    testid: 'manual-next',
    attrs: { type: 'button', 'aria-label': t('manual.next') },
  });
  const indicator = el('span', { cls: 'manual-indicator', testid: 'manual-indicator' });
  const nav = el('nav', { cls: 'manual-nav' }, [prev, indicator, next]);
  const main = el('main', { cls: 'scene manual' }, [page, nav]);

  const render = (): void => {
    const entry = entries[index];
    title.textContent = t(entry.titleKey);
    body.replaceChildren(
      ...entry.rules.map((rule) => el('p', { cls: 'manual-rule', testid: 'manual-rule', text: manualText(rule) })),
      ...(entry.kind === 'symbols' ? [symbolTable()] : []),
    );
    indicator.textContent = `${index + 1}/${entries.length}`;
    prev.disabled = index === 0;
    next.disabled = index === entries.length - 1;
  };

  const go = (delta: number): void => {
    const to = index + delta;
    if (to < 0 || to >= entries.length) return;
    index = to;
    render();
    // a button that just became disabled loses focus: hand it to the other one
    if (prev.disabled && document.activeElement === prev) next.focus();
    else if (next.disabled && document.activeElement === next) prev.focus();
  };

  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'ArrowRight') go(1);
    else if (ev.key === 'ArrowLeft') go(-1);
  };
  document.addEventListener('keydown', onKey);

  let swipeFrom: number | null = null;
  page.addEventListener('pointerdown', (ev) => {
    swipeFrom = (ev as MouseEvent).clientX;
  });
  page.addEventListener('pointercancel', () => {
    swipeFrom = null;
  });
  page.addEventListener('pointerup', (ev) => {
    if (swipeFrom === null) return;
    const dx = (ev as MouseEvent).clientX - swipeFrom;
    swipeFrom = null;
    if (dx <= -SWIPE_PX) go(1);
    else if (dx >= SWIPE_PX) go(-1);
  });

  render();
  root.replaceChildren(main);

  return {
    destroy() {
      document.removeEventListener('keydown', onKey);
      root.replaceChildren();
    },
  };
}
