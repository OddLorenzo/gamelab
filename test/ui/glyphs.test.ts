import { describe, expect, it } from 'vitest';
import { SYMBOL_COLUMNS } from '../../src/core/modules/symbols';
import { en, fr } from '../../src/ui/i18n';
import { GLYPH_CHARS, glyphChar } from '../../src/ui/glyphs';

/**
 * Hand-written review table: the char each glyph id must show and the shape family it belongs to.
 * Two glyphs of one family look alike at small size, so a family has at most 2 members and its
 * members never share a column. U+FE0E pins a symbol to text (not color emoji) presentation.
 */
const SHAPES: Record<string, { char: string; family: string }> = {
  flame: { char: '♨\uFE0E', family: 'steam' },
  spiral: { char: '@', family: 'curl' },
  crab: { char: 'Ж', family: 'cross' },
  hand: { char: '☞', family: 'hand' },
  anchor: { char: '⚓\uFE0E', family: 'hook' },
  eye: { char: '◉', family: 'circle' },
  crown: { char: '♛', family: 'piece' },
  moon: { char: '☾', family: 'crescent' },
  key: { char: '⊸', family: 'lollipop' },
  cloud: { char: '☁\uFE0E', family: 'cloud' },
  arrow: { char: '➤', family: 'arrow' },
  tree: { char: '♣\uFE0E', family: 'clover' },
  shell: { char: '⌓', family: 'arc' },
  leaf: { char: '❧', family: 'leaf' },
  gear: { char: '⚙\uFE0E', family: 'gear' },
  bolt: { char: '↯', family: 'zigzag' },
  drop: { char: '▼', family: 'triangle' },
  star: { char: '★', family: 'star' },
  bell: { char: 'Ω', family: 'arch' },
  wave: { char: '≈', family: 'wave' },
};
const SHAPE_FAMILY: Record<string, string> = Object.fromEntries(Object.entries(SHAPES).map(([id, v]) => [id, v.family]));

const IDS = [...new Set(SYMBOL_COLUMNS.flat())];

describe('glyphs', () => {
  it('SYMBOL_COLUMNS uses 20 distinct glyph ids', () => {
    expect(IDS).toHaveLength(20);
  });

  it('maps every glyph id of SYMBOL_COLUMNS to a char, and nothing else', () => {
    expect(Object.keys(GLYPH_CHARS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) expect(GLYPH_CHARS[id], id).toBeTruthy();
  });

  it('uses a distinct char per glyph', () => {
    const chars = IDS.map((id) => GLYPH_CHARS[id]);
    expect(new Set(chars).size).toBe(chars.length);
  });

  it('every char is one symbol: a single code point, or one code point plus the text selector U+FE0E; never a color emoji', () => {
    for (const id of IDS) {
      const c = GLYPH_CHARS[id];
      const base = c.replace(/\uFE0E$/u, '');
      expect([...base], id).toHaveLength(1);
      expect(c, id).not.toMatch(/[\uFE00-\uFE0D\uFE0F\u200D]/u);
      // an emoji-capable code point is only allowed when pinned to text presentation
      if (/\p{Emoji}/u.test(base)) expect(c.endsWith('\uFE0E'), id).toBe(true);
    }
  });

  it('no char is a plain letter-like digit or a keycap: the table never reads as text', () => {
    for (const id of IDS) expect(GLYPH_CHARS[id], id).not.toMatch(/^[0-9#*]$/u);
  });

  it('glyphChar returns the mapped char and a visible fallback for an unknown id', () => {
    for (const id of IDS) expect(glyphChar(id)).toBe(GLYPH_CHARS[id]);
    expect(glyphChar('nope')).toBe('?');
    expect(glyphChar('toString')).toBe('?');
  });

  it('every glyph id has a name glyph.<id> in fr and en, and the names are distinct per language', () => {
    for (const id of IDS) {
      expect(en[`glyph.${id}`], `en ${id}`).toBeTruthy();
      expect(fr[`glyph.${id}`], `fr ${id}`).toBeTruthy();
    }
    expect(new Set(IDS.map((id) => en[`glyph.${id}`])).size).toBe(20);
    expect(new Set(IDS.map((id) => fr[`glyph.${id}`])).size).toBe(20);
  });

  it('the review table covers exactly the glyph ids and GLYPH_CHARS shows exactly the reviewed chars', () => {
    expect(Object.keys(SHAPES).sort()).toEqual([...IDS].sort());
    for (const id of IDS) expect(GLYPH_CHARS[id], id).toBe(SHAPES[id].char);
  });

  it('no shape family has more than 2 members, and at most one glyph is star-like', () => {
    const count = new Map<string, string[]>();
    for (const id of IDS) count.set(SHAPE_FAMILY[id], [...(count.get(SHAPE_FAMILY[id]) ?? []), id]);
    for (const [family, ids] of count) expect(ids.length, family + ': ' + ids.join(',')).toBeLessThanOrEqual(2);
    expect(count.get('star') ?? []).toHaveLength(1);
  });

  it('two glyphs of the same family never share a column of SYMBOL_COLUMNS', () => {
    for (const [c, column] of SYMBOL_COLUMNS.entries()) {
      const seen = new Map<string, string>();
      for (const id of column) {
        const family = SHAPE_FAMILY[id];
        const other = seen.get(family);
        expect(other === undefined || other === id, 'column ' + (c + 1) + ': ' + id + ' looks like ' + String(other)).toBe(true);
        seen.set(family, id);
      }
    }
  });
});
