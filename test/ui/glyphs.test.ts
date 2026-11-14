import { describe, expect, it } from 'vitest';
import { SYMBOL_COLUMNS } from '../../src/core/modules/symbols';
import { en, fr } from '../../src/ui/i18n';
import { GLYPH_CHARS, glyphChar } from '../../src/ui/glyphs';

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

  it('every char is a single code point, not an emoji and carries no variation selector', () => {
    for (const id of IDS) {
      const c = GLYPH_CHARS[id];
      expect([...c], id).toHaveLength(1);
      expect(c, id).not.toMatch(/\p{Emoji}/u);
      expect(c, id).not.toMatch(/[\uFE00-\uFE0F\u200D]/u);
    }
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
});
