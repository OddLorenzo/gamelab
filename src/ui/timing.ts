const secondsLeft = (msLeft: number): number => (Number.isFinite(msLeft) && msLeft > 0 ? Math.floor(msLeft / 1000) : 0);

/**
 * The digit the timer shows in the units place of its seconds: floor(msLeft / 1000) % 10.
 * This is the SAME rule the host applies when it injects `timerDigit` into a button release
 * (ruling R1), so what the deaf player reads is what the game checks. Negative, NaN and infinite
 * input give 0.
 */
export function timerDigitOf(msLeft: number): number {
  return secondsLeft(msLeft) % 10;
}

/** `m:ss`, floored to the second, never negative: 167900 -> "2:47". */
export function formatClock(msLeft: number): string {
  const total = secondsLeft(msLeft);
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds}`;
}
