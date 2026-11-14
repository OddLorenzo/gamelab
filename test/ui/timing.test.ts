import { describe, expect, it } from 'vitest';
import { timerDigitOf, formatClock } from '../../src/ui/timing';

describe('timerDigitOf (the displayed digit rule, same as the host: floor(ms/1000) % 10)', () => {
  const TABLE: [number, number][] = [
    [0, 0],
    [999, 0],
    [1000, 1],
    [1999, 1],
    [9000, 9],
    [9999, 9],
    [10_000, 0],
    [10_999, 0],
    [11_000, 1],
    [59_999, 9],
    [60_000, 0],
    [61_000, 1],
    [167_900, 7],
    [3_599_000, 9],
  ];
  it.each(TABLE)('%d ms -> %d', (ms, digit) => {
    expect(timerDigitOf(ms)).toBe(digit);
  });

  it('gives 0 for negative, NaN and infinite input', () => {
    expect(timerDigitOf(-1)).toBe(0);
    expect(timerDigitOf(-5000)).toBe(0);
    expect(timerDigitOf(NaN)).toBe(0);
    expect(timerDigitOf(Infinity)).toBe(0);
    expect(timerDigitOf(-Infinity)).toBe(0);
  });

  it('always returns an integer 0..9 and matches the host formula for positive input', () => {
    for (let ms = 0; ms < 200_000; ms += 777) {
      const d = timerDigitOf(ms);
      expect(Number.isInteger(d) && d >= 0 && d <= 9).toBe(true);
      expect(d).toBe(Math.floor(ms / 1000) % 10);
    }
  });

  it('is the last digit of the seconds shown by formatClock', () => {
    for (let ms = 0; ms < 200_000; ms += 313) {
      const shown = formatClock(ms);
      expect(Number(shown.at(-1))).toBe(timerDigitOf(ms));
    }
  });
});

describe('formatClock', () => {
  it('formats m:ss, flooring to the second', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(999)).toBe('0:00');
    expect(formatClock(1000)).toBe('0:01');
    expect(formatClock(9999)).toBe('0:09');
    expect(formatClock(59_999)).toBe('0:59');
    expect(formatClock(60_000)).toBe('1:00');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(167_900)).toBe('2:47');
    expect(formatClock(600_000)).toBe('10:00');
  });

  it('is never negative and never NaN', () => {
    expect(formatClock(-1)).toBe('0:00');
    expect(formatClock(-90_000)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(Infinity)).toBe('0:00');
  });
});
