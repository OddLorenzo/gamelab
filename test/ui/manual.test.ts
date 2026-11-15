import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULES } from '../../src/core/bomb';
import { needsHold } from '../../src/core/modules/button';
import type { ButtonColor, ButtonLabel } from '../../src/core/modules/button';
import { computeTarget } from '../../src/core/modules/code';
import { SYMBOL_COLUMNS, tapOrder } from '../../src/core/modules/symbols';
import { correctIndex } from '../../src/core/modules/wires';
import type { Wire, WireColor } from '../../src/core/modules/wires';
import { createRng } from '../../src/core/rng';
import type { ManualEntry, ModuleKind } from '../../src/core/types';
import { glyphChar } from '../../src/ui/glyphs';
import { en, fr, setLang, t } from '../../src/ui/i18n';
import { createManual, manualText } from '../../src/ui/scenes/manual';

const KINDS: ModuleKind[] = ['wires', 'button', 'symbols', 'code'];
const entries = (): ManualEntry[] => KINDS.map((k) => MODULES[k].manual());

/* ---------------------------------------------------------------- strings */

describe('manual strings', () => {
  it('every key of every module manual() (title and rules) exists, non-empty, in fr and en', () => {
    for (const entry of entries()) {
      for (const key of [entry.titleKey, ...entry.rules]) {
        expect(en[key], `en ${key}`).toBeTruthy();
        expect(fr[key], `fr ${key}`).toBeTruthy();
        expect(en[key].trim(), `en ${key}`).not.toBe('');
      }
    }
  });

  it('has the scene keys and the five color names in both languages', () => {
    const keys = [
      'manual.empty',
      'manual.prev',
      'manual.next',
      'manual.column',
      ...(['red', 'blue', 'yellow', 'green', 'white'] as const).map((c) => `color.${c}`),
    ];
    for (const key of keys) {
      expect(en[key], `en ${key}`).toBeTruthy();
      expect(fr[key], `fr ${key}`).toBeTruthy();
    }
    expect(fr['color.red']).toBe('rouge');
    expect(en['color.red']).toBe('red');
  });

  it('every rule resolves with no placeholder left over once the color names are filled in', () => {
    for (const lang of ['fr', 'en'] as const) {
      setLang(lang);
      for (const entry of entries()) {
        for (const key of entry.rules) expect(manualText(key), `${lang} ${key}`).not.toMatch(/[{}]/);
      }
    }
    setLang('en');
  });

  it('the manual covers wires 3 to 6 (one rule per wire count), button 6 lines, symbols 4, code 5', () => {
    expect(MODULES.wires.manual().rules).toEqual([3, 4, 5, 6].map((n) => `manual.wires.rule.${n}`));
    expect(MODULES.button.manual().rules).toHaveLength(6);
    expect(MODULES.symbols.manual().rules).toHaveLength(4);
    expect(MODULES.code.manual().rules).toHaveLength(5);
  });
});

/* ---------------------------------------------------------------- semantic checks */

/** Lines of a rule string: line 0 is the lead-in, then "1. ...", "2. ..." in order. */
const numbered = (text: string): string[] => {
  const lines = text.split('\n');
  return lines.slice(1);
};

const COLORS: WireColor[] = ['red', 'blue', 'yellow', 'green', 'white'];
const cnt = (w: WireColor[], c: WireColor): number => w.filter((x) => x === c).length;
const kinds = (w: WireColor[]): number => new Set(w).size;
const once = (w: WireColor[]): number[] => w.flatMap((c, i) => (cnt(w, c) === 1 ? [i] : []));
const sameNeighbours = (w: WireColor[]): number[] => w.flatMap((c, i) => (i > 0 && c === w[i - 1] ? [i] : []));
const firstNotTopColor = (w: WireColor[]): number => w.findIndex((c) => c !== w[0]);

interface WireLine {
  applies: (w: WireColor[]) => boolean;
  cut: (w: WireColor[]) => number;
  /** fragments the French / English line must contain: its condition words and which wire it cuts */
  fr: string[];
  en: string[];
}

/** The manual sentences, as data, in the order the text lists them. First applicable line wins. */
const WIRE_TEXT: Record<number, WireLine[]> = {
  3: [
    { applies: (w) => w[0] === w[2], cut: () => 1, fr: ['fil du haut et le fil du bas ont la même couleur', 'coupe le fil du milieu'], en: ['top wire and the bottom wire have the same color', 'cut the middle wire'] },
    { applies: (w) => sameNeighbours(w).length > 0, cut: (w) => once(w)[0], fr: ['deux fils voisins ont la même couleur', "dont la couleur n'apparaît qu'une fois"], en: ['two neighboring wires have the same color', 'whose color is there only once'] },
    { applies: () => true, cut: (w) => w.indexOf([...w].sort((a, b) => COLORS.indexOf(a) - COLORS.indexOf(b))[0]), fr: ['Sinon', 'vient en premier dans cette liste : rouge, bleu, jaune, vert, blanc'], en: ['Otherwise', 'comes first in this list: red, blue, yellow, green, white'] },
  ],
  4: [
    { applies: (w) => w[1] === w[2], cut: () => 3, fr: ['deuxième et le troisième fil ont la même couleur', 'coupe le fil du bas'], en: ['second and the third wire have the same color', 'cut the bottom wire'] },
    { applies: (w) => w[0] === w[3], cut: () => 2, fr: ['fil du haut et le fil du bas ont la même couleur', 'coupe le troisième fil'], en: ['top wire and the bottom wire have the same color', 'cut the third wire'] },
    { applies: (w) => kinds(w) >= 3, cut: (w) => once(w)[0], fr: ['3 couleurs différentes ou plus', "le plus proche du haut dont la couleur n'apparaît qu'une fois"], en: ['3 or more different colors', 'nearest the top whose color is there only once'] },
    { applies: () => true, cut: firstNotTopColor, fr: ['Sinon', 'en descendant depuis le haut', "premier fil qui n'a pas la couleur du fil du haut"], en: ['Otherwise', 'going down from the top', 'first wire whose color is not the color of the top wire'] },
  ],
  5: [
    { applies: (w) => w[1] === w[3], cut: () => 2, fr: ['deuxième et le quatrième fil ont la même couleur', 'coupe le fil du milieu (le troisième)'], en: ['second and the fourth wire have the same color', 'cut the middle wire (the third)'] },
    { applies: (w) => kinds(w) >= 3, cut: (w) => once(w)[once(w).length - 1], fr: ['3 couleurs différentes ou plus', "le plus proche du bas dont la couleur n'apparaît qu'une fois"], en: ['3 or more different colors', 'nearest the bottom whose color is there only once'] },
    { applies: (w) => w[0] === w[4], cut: () => 0, fr: ['fil du haut et le fil du bas ont la même couleur', 'coupe le fil du haut'], en: ['top wire and the bottom wire have the same color', 'cut the top wire'] },
    { applies: () => true, cut: firstNotTopColor, fr: ['Sinon', 'en descendant depuis le haut', "premier fil qui n'a pas la couleur du fil du haut"], en: ['Otherwise', 'going down from the top', 'first wire whose color is not the color of the top wire'] },
  ],
  6: [
    {
      applies: (w) => sameNeighbours(w).length === 0,
      cut: (w) => {
        const most = Math.max(...w.map((c) => cnt(w, c)));
        return w.map((c, i) => (cnt(w, c) === most ? i : -1)).reduce((a, b) => Math.max(a, b));
      },
      fr: ["Aucun fil n'a la même couleur qu'un fil voisin", 'les couleurs qui apparaissent le plus de fois', 'le plus proche du bas qui a une de ces couleurs'],
      en: ['No wire has the same color as a neighboring wire', 'the colors that are there the most times', 'nearest the bottom that has one of those colors'],
    },
    { applies: (w) => kinds(w) % 2 === 1, cut: (w) => sameNeighbours(w)[0], fr: ['nombre de couleurs différentes est impair (1, 3 ou 5)', 'paire de fils voisins de même couleur la plus proche du haut', 'fil du bas de cette paire'], en: ['number of different colors is odd (1, 3 or 5)', 'pair of neighboring wires with the same color that is nearest the top', 'lower wire of that pair'] },
    { applies: (w) => once(w).length > 0, cut: (w) => 5 - once(w)[once(w).length - 1], fr: ["une couleur n'apparaît qu'une fois", 'le plus proche du bas', 'son fil miroir', 'comptée depuis le bas', 'premier et sixième, deuxième et cinquième, troisième et quatrième'], en: ['a color is there only once', 'nearest the bottom', 'its mirror wire', 'counted from the bottom', 'first and sixth, second and fifth, third and fourth'] },
    { applies: () => true, cut: () => 2, fr: ['Sinon', 'coupe le troisième fil'], en: ['Otherwise', 'cut the third wire'] },
  ],
};

const layouts = (n: number): WireColor[][] => {
  let acc: WireColor[][] = [[]];
  for (let i = 0; i < n; i++) acc = acc.flatMap((p) => COLORS.map((c) => [...p, c]));
  return acc;
};

describe('wires text says cut wires still count (correctIndex reads every wire, cut or not)', () => {
  it.each([3, 4, 5, 6])('%d wires: the lead-in says it in English and in French', (n) => {
    const key = `manual.wires.rule.${n}`;
    expect(en[key].split('\n')[0]).toContain('Cut wires still count.');
    expect(fr[key].split('\n')[0]).toContain('Les fils coupés comptent toujours.');
  });

  it('the cut flag really does not change the answer (so the text is right to say so)', () => {
    const colors: WireColor[] = ['white', 'red', 'blue', 'yellow'];
    for (const cutAt of [0, 1, 2, 3]) {
      const open: Wire[] = colors.map((color) => ({ color, cut: false }));
      const cut: Wire[] = colors.map((color, i) => ({ color, cut: i === cutAt }));
      expect(correctIndex(cut)).toBe(correctIndex(open));
    }
  });
});

describe('manual text equals the wires rule code', () => {
  for (const n of [3, 4, 5, 6]) {
    it(`${n} wires: the first line the text says applies is correctIndex, for every one of the ${5 ** n} layouts`, () => {
      const lines = WIRE_TEXT[n];
      for (const layout of layouts(n)) {
        const first = lines.find((l) => l.applies(layout));
        expect(first, layout.join(',')).toBeDefined();
        const wires: Wire[] = layout.map((color) => ({ color, cut: false }));
        expect(first?.cut(layout), layout.join(',')).toBe(correctIndex(wires));
      }
    });

    for (const lang of ['fr', 'en'] as const) {
      it(`${n} wires (${lang}): the text lists the same lines, in the same order, with the same words`, () => {
        setLang(lang);
        const text = manualText(`manual.wires.rule.${n}`);
        const lines = numbered(text);
        expect(lines).toHaveLength(WIRE_TEXT[n].length);
        for (const [i, line] of lines.entries()) {
          expect(line.startsWith(`${i + 1}. `), `${lang} ${n} line ${i + 1}`).toBe(true);
          const frags = WIRE_TEXT[n][i][lang];
          for (const frag of frags) expect(line.toLowerCase(), `${lang} ${n} line ${i + 1}`).toContain(frag.toLowerCase());
        }
        setLang('en');
      });
    }

    it(`${n} wires: the lead-in names the wire count and that wires are counted from the top`, () => {
      for (const lang of ['fr', 'en'] as const) {
        setLang(lang);
        const lead = manualText(`manual.wires.rule.${n}`).split('\n')[0];
        expect(lead).toContain(String(n));
        expect(lead.toLowerCase()).toContain(lang === 'fr' ? 'haut' : 'top');
      }
      setLang('en');
    });
  }
});

describe('manual text equals the button rule code', () => {
  type Action = 'tap' | 'hold';
  const LINES: { applies: (c: ButtonColor, l: ButtonLabel) => boolean; action: Action; fr: string[]; en: string[] }[] = [
    { applies: (c, l) => c === 'white' && l === 'ABORT', action: 'tap', fr: ['bouton blanc', 'ABORT', 'appui bref'], en: ['white button', 'ABORT', 'tap'] },
    { applies: (c) => c === 'blue', action: 'hold', fr: ['bouton bleu', 'appui long'], en: ['blue button', 'hold'] },
    { applies: (_c, l) => l === 'ABORT', action: 'hold', fr: ['ABORT', 'appui long'], en: ['ABORT', 'hold'] },
    { applies: (c, l) => c === 'yellow' && l === 'PRESS', action: 'hold', fr: ['bouton jaune', 'PRESS', 'appui long'], en: ['yellow button', 'PRESS', 'hold'] },
    { applies: () => true, action: 'tap', fr: ['Tout le reste', 'appui bref'], en: ['Anything else', 'tap'] },
  ];

  it('the first line that applies gives needsHold, for all 12 color and label pairs', () => {
    for (const c of ['red', 'blue', 'yellow', 'white'] as const) {
      for (const l of ['HOLD', 'PRESS', 'ABORT'] as const) {
        const first = LINES.find((x) => x.applies(c, l));
        expect(first?.action === 'hold', `${c}/${l}`).toBe(needsHold(c, l));
      }
    }
  });

  for (const lang of ['fr', 'en'] as const) {
    it(`rules 1 to 5 (${lang}) carry the five lines in order, each with its words`, () => {
      setLang(lang);
      const rules = [1, 2, 3, 4, 5].map((n) => manualText(`manual.button.rule.${n}`));
      const lines = [numbered(rules[0])[0], ...rules.slice(1)];
      expect(lines).toHaveLength(5);
      for (const [i, line] of lines.entries()) {
        expect(line.startsWith(`${i + 1}. `), `${lang} line ${i + 1}`).toBe(true);
        for (const frag of LINES[i][lang]) expect(line.toLowerCase(), `${lang} line ${i + 1}`).toContain(frag.toLowerCase());
      }
      setLang('en');
    });

    it(`rule 6 (${lang}) states the tap and hold gestures and the digit rule`, () => {
      setLang(lang);
      const rule = manualText('manual.button.rule.6');
      if (lang === 'en') {
        expect(rule.toLowerCase()).toContain('tap');
        expect(rule).toContain('hold');
        expect(rule).toContain('last digit of the seconds');
        expect(rule).toContain('digit on the button');
        expect(rule).toContain('seconds of the timer end in 7');
        expect(rule).not.toContain('while the timer shows');
        expect(rule).toContain('too long');
      } else {
        expect(rule.toLowerCase()).toContain('appui bref');
        expect(rule.toLowerCase()).toContain('appui long');
        expect(rule).toContain('dernier chiffre des secondes');
        expect(rule).toContain('chiffre du bouton');
        expect(rule).toContain('se terminent par 7');
        expect(rule).not.toContain('quand le minuteur affiche');
        expect(rule).toContain('trop longtemps');
      }
      setLang('en');
    });
  }
});

describe('manual text equals the symbols rule code', () => {
  it('the table the page shows is SYMBOL_COLUMNS: six columns of seven, and every 4 glyphs of a column fit that one column only', () => {
    expect(SYMBOL_COLUMNS).toHaveLength(6);
    for (const col of SYMBOL_COLUMNS) expect(col).toHaveLength(7);
    const col = SYMBOL_COLUMNS[2];
    const shown = [col[5], col[0], col[3], col[1]];
    expect(tapOrder(shown)).toEqual([1, 3, 2, 0]);
  });

  for (const lang of ['fr', 'en'] as const) {
    it(`(${lang}) the four rules: 2 by 2 reading order, one column, top to bottom, wrong tap restarts`, () => {
      setLang(lang);
      const r = [1, 2, 3, 4].map((n) => manualText(`manual.symbols.rule.${n}`));
      const f =
        lang === 'fr'
          ? [['2 sur 2', 'en haut à gauche', 'en haut à droite', 'en bas à gauche', 'en bas à droite'], ['unique colonne', '4 symboles'], ['de haut en bas'], ['toute la séquence depuis le début', '4e']]
          : [['2 by 2', 'top left', 'top right', 'bottom left', 'bottom right'], ['one column', '4 symbols'], ['top to bottom'], ['whole sequence again from the beginning', '4th']];
      for (const [i, frags] of f.entries()) for (const frag of frags) expect(r[i], `${lang} rule ${i + 1}`).toContain(frag);
      // the reading order is the slot order: slot 0 top left ... slot 3 bottom right
      const order = lang === 'fr' ? ['en haut à gauche', 'en haut à droite', 'en bas à gauche', 'en bas à droite'] : ['top left', 'top right', 'bottom left', 'bottom right'];
      const positions = order.map((s) => r[0].indexOf(s));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      setLang('en');
    });
  }
});

describe('manual text equals the code rule code', () => {
  const chars = [...'K7B3M9'];
  const value = (ch: string): number => (ch >= '0' && ch <= '9' ? Number(ch) : ch.charCodeAt(0) - 64);
  const values = chars.map(value);
  const sum = values.reduce((a, b) => a + b, 0);

  it('the worked example serial really gives the code the text states', () => {
    expect(values).toEqual([11, 7, 2, 3, 13, 9]);
    expect(sum).toBe(45);
    expect(computeTarget('K7B3M9')).toBe('6276');
  });

  for (const lang of ['fr', 'en'] as const) {
    it(`(${lang}) the worked example repeats every step of computeTarget`, () => {
      setLang(lang);
      const text = manualText('manual.code.rule.4');
      expect(text).toContain('K7B3M9');
      expect(text).toContain(values.join(', '));
      expect(text).toContain(`S = ${sum}`);
      const target = computeTarget('K7B3M9');
      for (let i = 0; i < 4; i++) {
        const total = sum + (i + 1) * values[i] + 3 * i;
        expect(total % 10).toBe(Number(target[i]));
        const so = lang === 'en' ? 'so' : 'donc';
        expect(text, `${lang} digit ${i + 1}`).toContain(`${sum} + ${i + 1}×${values[i]} + ${3 * i} = ${total}, ${so} ${target[i]}.`);
      }
      expect(text).toContain(target);
      setLang('en');
    });

    it(`(${lang}) the formula steps name the value rule, the sum, n, 3 times (n-1) and the last digit`, () => {
      setLang(lang);
      const [r1, r2, r3, , r5] = [1, 2, 3, 4, 5].map((n) => manualText(`manual.code.rule.${n}`));
      if (lang === 'en') {
        expect(r1).toContain('6 characters');
        expect(r1).toContain('A=1');
        expect(r1).toContain('Z=26');
        expect(r2).toContain('S');
        expect(r3).toContain('n times');
        expect(r3).toContain('3 times (n minus 1)');
        expect(r3).toContain('last digit');
        expect(r5.toLowerCase()).toContain('strike');
      } else {
        expect(r1).toContain('6 caractères');
        expect(r1).toContain('A=1');
        expect(r1).toContain('Z=26');
        expect(r2).toContain('S');
        expect(r3).toContain('n fois');
        expect(r3).toContain('3 fois (n moins 1)');
        expect(r3).toContain('dernier chiffre');
      }
      setLang('en');
    });
  }

  it('every serial the game can make is covered: the example formula equals computeTarget for 200 random serials', () => {
    const rng = createRng(11);
    const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    for (let k = 0; k < 200; k++) {
      let serial = '';
      for (let i = 0; i < 6; i++) serial += ALPHABET[rng.int(ALPHABET.length)];
      const vs = [...serial].map(value);
      const s = vs.reduce((a, b) => a + b, 0);
      const out = [0, 1, 2, 3].map((i) => (s + (i + 1) * vs[i] + 3 * i) % 10).join('');
      expect(out, serial).toBe(computeTarget(serial));
    }
  });
});

/* ---------------------------------------------------------------- scene */

const q = (root: ParentNode, testid: string): HTMLElement => {
  const node = root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (node === null) throw new Error(`no ${testid}`);
  return node;
};
const qa = (root: ParentNode, testid: string): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];

const fire = (target: EventTarget, type: string, clientX = 0): void => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
};
const arrow = (k: 'ArrowLeft' | 'ArrowRight'): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
};

describe('createManual', () => {
  let root: HTMLElement;
  beforeEach(() => {
    setLang('en');
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const title = (): string => q(root, 'manual-title').textContent ?? '';
  const indicator = (): string => q(root, 'manual-indicator').textContent ?? '';
  const prev = (): HTMLButtonElement => q(root, 'manual-prev') as HTMLButtonElement;
  const next = (): HTMLButtonElement => q(root, 'manual-next') as HTMLButtonElement;

  it('renders one page per entry: title, the indicator n/total, and the rules of that entry', () => {
    createManual(root, entries());
    expect(title()).toBe(t('manual.wires.title'));
    expect(indicator()).toBe('1/4');
    const rules = qa(root, 'manual-rule');
    expect(rules).toHaveLength(4);
    expect(rules[0].textContent).toBe(manualText('manual.wires.rule.3'));
    next().click();
    expect(title()).toBe(t('manual.button.title'));
    expect(indicator()).toBe('2/4');
    expect(qa(root, 'manual-rule')).toHaveLength(6);
    next().click();
    next().click();
    expect(title()).toBe(t('manual.code.title'));
    expect(indicator()).toBe('4/4');
    expect(qa(root, 'manual-rule')).toHaveLength(5);
  });

  it('has Prev and Next buttons of at least 44 px, labelled, disabled at the ends', () => {
    createManual(root, entries());
    for (const b of [prev(), next()]) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.type).toBe('button');
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.classList.contains('btn')).toBe(true);
    }
    expect(prev().getAttribute('aria-label')).toBe(en['manual.prev']);
    expect(next().getAttribute('aria-label')).toBe(en['manual.next']);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    next().click();
    expect(prev().disabled).toBe(false);
    next().click();
    next().click();
    expect(next().disabled).toBe(true);
    next().click();
    expect(indicator()).toBe('4/4');
    prev().click();
    expect(indicator()).toBe('3/4');
  });

  it('puts aria-live polite on the page title and shows the title as plain text', () => {
    createManual(root, entries());
    expect(q(root, 'manual-title').getAttribute('aria-live')).toBe('polite');
  });

  it('a single entry has both buttons disabled', () => {
    createManual(root, [MODULES.code.manual()]);
    expect(indicator()).toBe('1/1');
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);
  });

  it('ArrowRight and ArrowLeft turn the page and stop at the ends', () => {
    createManual(root, entries());
    arrow('ArrowLeft');
    expect(indicator()).toBe('1/4');
    arrow('ArrowRight');
    expect(indicator()).toBe('2/4');
    arrow('ArrowRight');
    arrow('ArrowRight');
    arrow('ArrowRight');
    expect(indicator()).toBe('4/4');
    arrow('ArrowLeft');
    expect(indicator()).toBe('3/4');
  });

  it('swipes: left by 40 px goes next, right by 40 px goes previous, 39 px does nothing', () => {
    createManual(root, entries());
    const page = q(root, 'manual-page');
    fire(page, 'pointerdown', 200);
    fire(page, 'pointerup', 161);
    expect(indicator()).toBe('1/4');
    fire(page, 'pointerdown', 200);
    fire(page, 'pointerup', 160);
    expect(indicator()).toBe('2/4');
    fire(page, 'pointerdown', 100);
    fire(page, 'pointerup', 139);
    expect(indicator()).toBe('2/4');
    fire(page, 'pointerdown', 100);
    fire(page, 'pointerup', 140);
    expect(indicator()).toBe('1/4');
  });

  it('a swipe cannot go past the ends, and a cancelled or unmatched pointer gesture does nothing', () => {
    createManual(root, entries());
    const page = q(root, 'manual-page');
    fire(page, 'pointerdown', 100);
    fire(page, 'pointerup', 300);
    expect(indicator()).toBe('1/4');
    fire(page, 'pointerup', 0); // no matching pointerdown
    expect(indicator()).toBe('1/4');
    fire(page, 'pointerdown', 300);
    fire(page, 'pointercancel', 0);
    fire(page, 'pointerup', 0);
    expect(indicator()).toBe('1/4');
  });

  it('the symbols page renders all six columns with seven glyphs each, from SYMBOL_COLUMNS', () => {
    createManual(root, [MODULES.symbols.manual()]);
    const cols = qa(root, 'symbol-column');
    expect(cols).toHaveLength(6);
    for (const [c, col] of cols.entries()) {
      const cells = [...col.querySelectorAll<HTMLElement>('[data-testid="symbol-glyph"]')];
      expect(cells).toHaveLength(7);
      expect(cells.map((n) => n.dataset['glyph'])).toEqual([...SYMBOL_COLUMNS[c]]);
      for (const [i, cell] of cells.entries()) {
        const id = SYMBOL_COLUMNS[c][i];
        expect(cell.textContent).toContain(glyphChar(id));
        expect(cell.textContent).toContain(en[`glyph.${id}`]);
        expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toBe(glyphChar(id));
      }
    }
  });

  it('the other pages do not render the symbol table', () => {
    createManual(root, [MODULES.wires.manual(), MODULES.button.manual(), MODULES.code.manual()]);
    for (let i = 0; i < 3; i++) {
      expect(qa(root, 'symbol-column')).toHaveLength(0);
      next().click();
    }
  });

  it('renders in French when the language is French', () => {
    setLang('fr');
    createManual(root, [MODULES.code.manual()]);
    expect(title()).toBe(fr['manual.code.title']);
    expect(prev().getAttribute('aria-label')).toBe(fr['manual.prev']);
  });

  it('an empty list shows a friendly message and no navigation', () => {
    createManual(root, []);
    expect(q(root, 'manual-empty').textContent).toBe(en['manual.empty']);
    expect(root.querySelector('[data-testid="manual-prev"]')).toBeNull();
    expect(root.querySelector('[data-testid="manual-next"]')).toBeNull();
    arrow('ArrowRight');
    expect(q(root, 'manual-empty')).toBeDefined();
  });

  it('hostile text is shown as text and never becomes markup', () => {
    const hostile: ManualEntry = {
      kind: 'wires',
      titleKey: '<img src=x onerror=alert(1)>',
      rules: ['<script>alert(1)</script>', '<b>bold</b>{red}'],
    };
    createManual(root, [hostile]);
    expect(root.querySelector('img, script, b')).toBeNull();
    expect(title()).toBe('<img src=x onerror=alert(1)>');
    const rules = qa(root, 'manual-rule');
    expect(rules[0].textContent).toBe('<script>alert(1)</script>');
    expect(rules[1].textContent).toBe('<b>bold</b>{red}');
  });

  it('destroy removes the page and the keyboard listener', () => {
    const removed = vi.spyOn(document, 'removeEventListener');
    const handle = createManual(root, entries());
    handle.destroy();
    expect(root.children).toHaveLength(0);
    expect(removed.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
    expect(() => handle.destroy()).not.toThrow();
  });

  it('after destroy the arrow keys no longer touch a detached page', () => {
    const handle = createManual(root, entries());
    const ind = q(root, 'manual-indicator');
    handle.destroy();
    arrow('ArrowRight');
    expect(ind.textContent).toBe('1/4');
  });
});
