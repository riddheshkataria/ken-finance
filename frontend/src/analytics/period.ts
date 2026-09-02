/**
 * Budget periods.
 *
 * Everything here works in the device's local timezone deliberately. A budget
 * month is a human calendar month as the user experiences it — if their
 * 31 January spending landed in February because the boundary was computed in
 * UTC, the numbers would be wrong in a way that is very hard to explain.
 *
 * Pure — `now` is always an argument so tests are deterministic (rules.md §4).
 */

export interface Period {
  /** Inclusive start, local midnight. */
  startMs: number;
  /** Exclusive end, local midnight of the next period. */
  endMs: number;
  /** Days in the period. */
  totalDays: number;
  /** Days elapsed including today, so day 1 of the month is 1, never 0. */
  elapsedDays: number;
  /** Days left including today. Always at least 1. */
  remainingDays: number;
}

/** Local midnight at the start of the month containing `now`. */
export function startOfMonth(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/** Local midnight at the start of the following month. */
export function startOfNextMonth(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

/**
 * Builds the current monthly period.
 *
 * `remainingDays` never drops below 1: it is a divisor for safe-to-spend, and
 * on the last day of the month the honest answer is "you have today", not a
 * division by zero.
 */
export function currentMonth(now: number): Period {
  const startMs = startOfMonth(now);
  const endMs = startOfNextMonth(now);

  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.round((endMs - startMs) / dayMs);

  const today = new Date(now);
  const elapsedDays = today.getDate();
  const remainingDays = Math.max(1, totalDays - elapsedDays + 1);

  return { startMs, endMs, totalDays, elapsedDays, remainingDays };
}

/** True when a transaction's ISO timestamp falls inside the period. */
export function isWithin(period: Period, isoTimestamp: string): boolean {
  const time = Date.parse(isoTimestamp);
  if (Number.isNaN(time)) return false;
  return time >= period.startMs && time < period.endMs;
}

/** Human label for a period, e.g. "September 2026". */
export function periodLabel(period: Period): string {
  return new Date(period.startMs).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
}
