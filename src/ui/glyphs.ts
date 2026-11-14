/**
 * Display character for each glyph id of the manual's symbol table (SYMBOL_COLUMNS, 20 ids).
 * Plain text symbols from the Geometric Shapes, Miscellaneous Symbols, Dingbats and Arrows
 * blocks, one code point each, none of them an emoji, so every browser draws them as text in
 * the page font colour with no variation selector. The ids are only names: the shape does not
 * have to look like its name, it has to be distinct from the 19 others. The accessible name of
 * a glyph is the i18n key `glyph.<id>`.
 */
export const GLYPH_CHARS: Record<string, string> = {
  flame: '☼',
  spiral: '❃',
  crab: '⋈',
  hand: '☞',
  anchor: '‡',
  eye: '◉',
  crown: '♛',
  moon: '☾',
  key: '⊶',
  cloud: '◐',
  arrow: '➤',
  tree: '⋔',
  shell: '❁',
  leaf: '❧',
  gear: '✹',
  bolt: '↯',
  drop: '▼',
  star: '★',
  bell: '♪',
  wave: '≈',
};

/** The character for a glyph id, or `?` for an id that is not in the table. */
export function glyphChar(id: string): string {
  return Object.prototype.hasOwnProperty.call(GLYPH_CHARS, id) ? GLYPH_CHARS[id] : '?';
}

/** i18n key of a glyph's name. */
export const glyphNameKey = (id: string): string => `glyph.${id}`;
