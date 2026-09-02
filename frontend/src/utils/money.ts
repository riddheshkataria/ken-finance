/**
 * Money handling for Ken Finance.
 *
 * Every monetary value in this app is an integer number of **paise**.
 * See rules.md §1 — floats silently corrupt totals (0.1 + 0.2 !== 0.3) and
 * the damage is unrecoverable once real transactions exist.
 *
 * Convert at the UI boundary only, using the helpers in this file.
 */

/** ₹1 expressed in paise. */
export const PAISE_PER_RUPEE = 100;

/**
 * Converts a rupee value to integer paise.
 * Only use at the boundary where a human types rupees into the UI.
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE_PER_RUPEE);
}

/** Converts integer paise back to rupees, for display or charting only. */
export function paiseToRupees(minor: number): number {
  return minor / PAISE_PER_RUPEE;
}

/**
 * Parses a raw amount string from an SMS or notification into integer paise.
 *
 * Deliberately avoids parseFloat: `parseFloat("1234.55") * 100` yields
 * 123454.99999999999, which rounds to the wrong paise value often enough to
 * matter. Splitting on the decimal point keeps the arithmetic exact.
 *
 * Accepts: "1,234.55" | "1234" | "₹240.00" | "240.5"
 * Returns null when the input is not a positive amount.
 */
export function parseAmountToPaise(raw: string): number | null {
  if (!raw) return null;

  // Strip currency symbols, whitespace and thousands separators.
  const cleaned = raw.replace(/[₹,\s]|(?:rs\.?|inr)/gi, '');
  const match = cleaned.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;

  const whole = Number(match[1]);
  // "240.5" means 50 paise, not 5 — pad to exactly two digits.
  const fraction = match[2] ? Number(match[2].padEnd(2, '0')) : 0;

  const minor = whole * PAISE_PER_RUPEE + fraction;
  return minor > 0 ? minor : null;
}

/**
 * Formats integer paise as an Indian-locale currency string.
 * Drops the decimals on whole-rupee amounts, which is how amounts are
 * written on receipts and in bank SMS ("₹240", not "₹240.00").
 */
export function formatINR(minor: number, options?: { alwaysShowPaise?: boolean }): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / PAISE_PER_RUPEE);
  const fraction = abs % PAISE_PER_RUPEE;

  const showPaise = options?.alwaysShowPaise === true || fraction !== 0;

  // en-IN grouping is 2,2,3 (lakh/crore), which Intl handles correctly.
  const wholeFormatted = whole.toLocaleString('en-IN');
  const body = showPaise
    ? `${wholeFormatted}.${String(fraction).padStart(2, '0')}`
    : wholeFormatted;

  return `${negative ? '-' : ''}₹${body}`;
}

/** Sums a list of paise values. Present so callers never hand-roll float math. */
export function sumPaise(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
