export interface Progress {
  stars: Record<number, number>;
}

const STORAGE_KEY = 'mb.progress';
/** The engine supports 100 levels; version 0 ships (unlocks, saves) levels 1..10 only. */
export const V0_MAX_LEVEL = 10;

/** Used when localStorage is missing or throws: progress then lasts for this page load only. */
let memory: Progress = { stars: {} };

const validLevel = (id: number): boolean => Number.isInteger(id) && id >= 1 && id <= V0_MAX_LEVEL;
const validStars = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 3;

const copy = (p: Progress): Progress => ({ stars: { ...p.stars } });

function parse(raw: string | null): Progress | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { stars: {} };
  }
  const stars: Record<number, number> = {};
  const src = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { stars?: unknown }).stars : null;
  if (typeof src === 'object' && src !== null && !Array.isArray(src)) {
    for (const [key, value] of Object.entries(src)) {
      const id = Number(key);
      if (key.trim() !== '' && validLevel(id) && typeof value === 'number' && validStars(value)) stars[id] = value;
    }
  }
  return { stars };
}

export function loadProgress(): Progress {
  try {
    const stored = parse(localStorage.getItem(STORAGE_KEY));
    if (stored !== null) return stored;
    return copy(memory); // nothing stored (or storage empty): memory covers a failed earlier write
  } catch {
    return copy(memory);
  }
}

/** Best result wins: stars only ever increase. Invalid ids or star values change nothing. */
export function saveStars(levelId: number, stars: 0 | 1 | 2 | 3): Progress {
  const p = loadProgress();
  if (!validLevel(levelId) || !validStars(stars)) return p;
  if (stars > (p.stars[levelId] ?? 0)) p.stars[levelId] = stars;
  memory = copy(p);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // kept in memory only
  }
  return copy(p);
}

/** Level 1 is always open; level n opens once level n-1 has at least 1 star. */
export function unlockedLevels(p: Progress): number[] {
  const out: number[] = [];
  for (let n = 1; n <= V0_MAX_LEVEL; n++) if (n === 1 || (p.stars[n - 1] ?? 0) >= 1) out.push(n);
  return out;
}
