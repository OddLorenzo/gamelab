import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fresh = async () => {
  vi.resetModules();
  return import('../../src/ui/progress');
};

describe('progress', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts with only level 1 unlocked', async () => {
    const { loadProgress, unlockedLevels } = await fresh();
    expect(loadProgress()).toEqual({ stars: {} });
    expect(unlockedLevels(loadProgress())).toEqual([1]);
  });

  it('unlocks level n exactly when level n-1 has at least 1 star', async () => {
    const { unlockedLevels } = await fresh();
    expect(unlockedLevels({ stars: { 1: 2 } })).toEqual([1, 2]);
    expect(unlockedLevels({ stars: { 1: 0 } })).toEqual([1]);
    // 2 has no star: 3 stays locked even though 3 itself has stars; 4 opens through 3
    expect(unlockedLevels({ stars: { 1: 2, 2: 0, 3: 3 } })).toEqual([1, 2, 4]);
    expect(unlockedLevels({ stars: { 99: 1 } })).toEqual([1, 100]);
  });

  it('saveStars returns and persists the progress', async () => {
    const { saveStars, unlockedLevels } = await fresh();
    const p = saveStars(1, 2);
    expect(p.stars[1]).toBe(2);
    expect(unlockedLevels(p)).toEqual([1, 2]);
    expect(JSON.parse(localStorage.getItem('mb.progress') ?? 'null')).toEqual({ stars: { 1: 2 } });
    const again = await fresh();
    expect(again.loadProgress()).toEqual({ stars: { 1: 2 } });
  });

  it('only ever increases stars (best result kept)', async () => {
    const { saveStars } = await fresh();
    saveStars(3, 3);
    expect(saveStars(3, 2).stars[3]).toBe(3);
    expect(saveStars(3, 0).stars[3]).toBe(3);
    saveStars(4, 2);
    expect(saveStars(4, 3).stars[4]).toBe(3);
  });

  it('ignores invalid level ids', async () => {
    const { saveStars, loadProgress } = await fresh();
    for (const bad of [0, -1, 101, 1.5, Number.NaN, Infinity]) saveStars(bad, 3);
    expect(loadProgress()).toEqual({ stars: {} });
  });

  it('ignores invalid star values', async () => {
    const { saveStars, loadProgress } = await fresh();
    saveStars(1, 4 as unknown as 3);
    saveStars(1, -1 as unknown as 0);
    saveStars(1, 1.5 as unknown as 1);
    expect(loadProgress()).toEqual({ stars: {} });
  });

  it('ignores corrupted JSON', async () => {
    const { loadProgress } = await fresh();
    for (const raw of ['not json', '', 'null', '[]', '{"stars":[1,2]}', '{"stars":"x"}', '42']) {
      localStorage.setItem('mb.progress', raw);
      expect(loadProgress()).toEqual({ stars: {} });
    }
  });

  it('drops invalid entries but keeps the valid ones', async () => {
    const { loadProgress } = await fresh();
    localStorage.setItem(
      'mb.progress',
      JSON.stringify({ stars: { 1: 9, abc: 2, 0: 3, 2: 2, 101: 1, 3: 1.5, 4: 'x', 5: 3 } }),
    );
    expect(loadProgress()).toEqual({ stars: { 2: 2, 5: 3 } });
  });

  it('works when storage reads throw', async () => {
    const { loadProgress, saveStars } = await fresh();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadProgress()).toEqual({ stars: {} });
    expect(() => saveStars(1, 2)).not.toThrow();
  });

  it('keeps progress in memory when storage writes throw', async () => {
    const { loadProgress, saveStars, unlockedLevels } = await fresh();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const p = saveStars(1, 3);
    expect(p.stars[1]).toBe(3);
    expect(unlockedLevels(loadProgress())).toEqual([1, 2]);
  });

  it('works when localStorage itself is missing or throws on access', async () => {
    const { loadProgress, saveStars } = await fresh();
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadProgress()).toEqual({ stars: {} });
    expect(saveStars(2, 2).stars[2]).toBe(2);
    expect(loadProgress().stars[2]).toBe(2);
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', undefined);
    expect(() => loadProgress()).not.toThrow();
    expect(() => saveStars(1, 1)).not.toThrow();
  });

  it('returns copies: mutating a result does not change the stored progress', async () => {
    const { saveStars, loadProgress } = await fresh();
    const p = saveStars(1, 2);
    p.stars[1] = 0;
    expect(loadProgress().stars[1]).toBe(2);
  });
});
