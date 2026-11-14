import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS } from '../../src/core/levels';
import { en, fr, getLang, setLang, t } from '../../src/ui/i18n';

const REQUIRED = [
  'app.title',
  'lobby.create',
  'lobby.join',
  'lobby.codeLabel',
  'lobby.codePlaceholder',
  'lobby.seats',
  'lobby.waiting',
  'lobby.start',
  'lobby.waitHost',
  'lobby.level',
  'level.n',
  'lobby.lang',
  'lobby.footerVersion',
  'lobby.privacy',
  'err.full',
  'err.noRoom',
  'err.network',
  'err.playerLeft',
  'err.hostLeft',
  'results.won',
  'results.lost',
  'results.stars',
  'results.next',
  'results.retry',
  'results.lobby',
  'results.waitHost',
  'role.blind',
  'role.deaf',
  'role.mute',
  'ui.mic.denied',
  'game.waiting',
  'game.player',
  'game.emoteFrom',
  'game.title',
  'game.canvas.blind',
  'game.canvas.deaf',
  ...SETTINGS,
];

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n tables', () => {
  it('en and fr have exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });

  it('has every required key, non-empty, in both languages', () => {
    for (const key of REQUIRED) {
      expect(en[key], `en ${key}`).toBeTruthy();
      expect(fr[key], `fr ${key}`).toBeTruthy();
    }
  });

  it('uses the same {placeholders} in both languages for every key', () => {
    for (const key of Object.keys(en)) {
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('has no borrowed brand wording', () => {
    for (const text of [...Object.values(en), ...Object.values(fr)]) {
      expect(text.toLowerCase()).not.toContain('bombanana');
    }
  });

  it('the fr copy really differs from en for the player-facing strings', () => {
    expect(fr['lobby.create']).not.toBe(en['lobby.create']);
    expect(fr['err.full']).not.toBe(en['err.full']);
  });
});

describe('t() and setLang()', () => {
  beforeEach(() => {
    localStorage.clear();
    setLang('en');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the key for an unknown key', () => {
    expect(t('missing.key')).toBe('missing.key');
  });

  it('does not leak Object.prototype members as translations', () => {
    expect(t('toString')).toBe('toString');
    expect(t('constructor')).toBe('constructor');
    expect(t('__proto__')).toBe('__proto__');
  });

  it('interpolates {name} placeholders', () => {
    expect(t('level.n', { n: 7 })).toBe(en['level.n'].replace('{n}', '7'));
    expect(t('level.n', { n: 7 })).toContain('7');
    expect(t('level.n', { n: 7 })).not.toContain('{n}');
  });

  it('leaves a placeholder without a matching var untouched', () => {
    expect(t('level.n')).toBe(en['level.n']);
    expect(t('level.n', { other: 1 })).toBe(en['level.n']);
  });

  it('does not re-expand placeholders inside a substituted value or treat $ specially', () => {
    expect(t('level.n', { n: '{n}$&' })).toBe(en['level.n'].replace('{n}', () => '{n}$&'));
  });

  it('switches output with setLang', () => {
    setLang('fr');
    expect(getLang()).toBe('fr');
    expect(t('lobby.create')).toBe(fr['lobby.create']);
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t('lobby.create')).toBe(en['lobby.create']);
  });

  it('persists the choice in localStorage', () => {
    setLang('fr');
    expect(localStorage.getItem('mb.lang')).toBe('fr');
  });

  it('keeps working when storage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => setLang('fr')).not.toThrow();
    expect(t('lobby.create')).toBe(fr['lobby.create']);
  });

  it('sets the document language', () => {
    setLang('fr');
    expect(document.documentElement.lang).toBe('fr');
  });
});

describe('default language', () => {
  const load = async (language: string, stored?: string, throwing = false) => {
    vi.resetModules();
    localStorage.clear();
    if (stored !== undefined) localStorage.setItem('mb.lang', stored);
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language);
    if (throwing) {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
    }
    return import('../../src/ui/i18n');
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in fr for fr-FR and fr', async () => {
    expect((await load('fr-FR')).getLang()).toBe('fr');
    expect((await load('fr')).getLang()).toBe('fr');
  });

  it('starts in en for any other browser language', async () => {
    expect((await load('en-US')).getLang()).toBe('en');
    expect((await load('de-DE')).getLang()).toBe('en');
  });

  it('a stored choice wins over the browser language', async () => {
    expect((await load('en-US', 'fr')).getLang()).toBe('fr');
    expect((await load('fr-FR', 'en')).getLang()).toBe('en');
  });

  it('ignores a stored value that is not a language, and a throwing storage', async () => {
    expect((await load('fr-FR', 'klingon')).getLang()).toBe('fr');
    expect((await load('fr-FR', undefined, true)).getLang()).toBe('fr');
  });

  it('t() uses the detected default', async () => {
    const mod = await load('fr-FR');
    expect(mod.t('lobby.create')).toBe(mod.fr['lobby.create']);
  });
});
