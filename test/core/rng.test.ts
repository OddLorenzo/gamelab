import { describe, it, expect } from 'vitest';
import { createRng } from '../../src/core/rng';

describe('createRng', () => {
  it('yields the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('yields different values for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('next() stays in [0,1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int(6) stays in [0,5] over 1000 draws', () => {
    const rng = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('pick returns a member of the list', () => {
    const rng = createRng(99);
    const items = ['a', 'b', 'c', 'd'] as const;
    for (let i = 0; i < 100; i++) {
      expect(items).toContain(rng.pick(items));
    }
  });
});
