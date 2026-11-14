/**
 * Display character for each glyph id of the manual's symbol table (SYMBOL_COLUMNS, 20 ids).
 * Players describe a glyph by its NAME over voice, so each shape reads as its name as far as
 * plain system-font symbols allow, and no two shapes look alike (no two radial / sun / star
 * bursts, one star only). Plain text symbols from the Miscellaneous Symbols, Dingbats, Arrows,
 * Geometric Shapes, Greek and Cyrillic blocks. A few base characters also have a color-emoji
 * form (anchor, cloud, tree, gear, flame): those carry U+FE0E so every browser draws them as
 * text in the page font color. The ids come from src/core and never change; the shape may.
 */
export const GLYPH_CHARS: Record<string, string> = {
  flame: '♨\uFE0E', // hot springs: steam / heat
  spiral: '@', // a curl that winds inward
  crab: 'Ж', // Cyrillic zhe: a body with pincers and legs
  hand: '☞', // pointing hand
  anchor: '⚓\uFE0E',
  eye: '◉', // fisheye: ring and pupil
  crown: '♛', // chess queen
  moon: '☾', // crescent
  key: '⊸', // ring and shaft
  cloud: '☁\uFE0E',
  arrow: '➤',
  tree: '♣\uFE0E', // club: a crown on a trunk
  shell: '⌓', // segment: a scallop fan
  leaf: '❧', // rotated floral heart bullet: a leaf
  gear: '⚙\uFE0E', // cog
  bolt: '↯', // zigzag arrow
  drop: '▼', // downward point
  star: '★',
  bell: 'Ω', // omega: a bell outline
  wave: '≈',
};

/** The character for a glyph id, or `?` for an id that is not in the table. */
export function glyphChar(id: string): string {
  return Object.prototype.hasOwnProperty.call(GLYPH_CHARS, id) ? GLYPH_CHARS[id] : '?';
}

/** i18n key of a glyph's name. */
export const glyphNameKey = (id: string): string => `glyph.${id}`;
