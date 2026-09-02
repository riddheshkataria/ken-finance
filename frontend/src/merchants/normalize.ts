/**
 * Merchant name normalisation.
 *
 * The same shop reaches us in wildly different forms depending on the channel:
 *
 *   swiggy@ybl              (bank SMS, VPA)
 *   UPI/SWGY*ORDER/123456   (bank SMS, machine-readable)
 *   SWIGGY LIMITED          (card statement style)
 *   Swiggy                  (GPay notification)
 *
 * All four must collapse to one key so that categorising Swiggy once applies
 * to every future Swiggy, whichever channel reported it.
 *
 * The hard constraint pulling the other way: **do not over-normalise.**
 * "Swiggy" and "Swiggy Instamart" are different businesses in different
 * categories (Dining vs Grocery), and merging them would silently miscategorise
 * every grocery order. Descriptive words are therefore preserved; only legal
 * suffixes and payment-rail noise are stripped.
 *
 * Pure — no I/O, no state (rules.md §4).
 */

/**
 * Corporate suffixes that carry no meaning for categorisation.
 * Ordered longest-first so "private limited" is removed before "limited".
 */
const LEGAL_SUFFIXES: readonly string[] = [
  'private limited',
  'pvt limited',
  'private ltd',
  'pvt ltd',
  'pvt.ltd',
  'limited',
  'llp',
  'ltd',
  'inc',
  'corp',
];

/**
 * Payment-rail prefixes. These identify the pipe the money travelled through,
 * not who was paid.
 */
const RAIL_PREFIXES: readonly string[] = [
  'upi',
  'pos',
  'atm',
  'neft',
  'imps',
  'rtgs',
  'ach',
  'mmt',
  'bil',
  'inf',
];

/**
 * Extracts the human-meaningful part of a VPA.
 * `swiggy@ybl` -> `swiggy`, `rahul.sharma@oksbi` -> `rahul.sharma`
 */
export function stripVpaDomain(value: string): string {
  const atIndex = value.indexOf('@');
  return atIndex > 0 ? value.slice(0, atIndex) : value;
}

/**
 * Normalises a raw merchant string into a stable lookup key.
 *
 * Returns an empty string when nothing meaningful survives — the caller must
 * treat that as "no merchant" rather than storing it, or every unparseable
 * payment would share one memory entry and poison each other's category.
 */
export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return '';

  let value = stripVpaDomain(raw.trim().toLowerCase());

  // Machine-readable bank descriptors: "UPI/SWGY*ORDER/123456".
  // Segments are split on / and * and the longest alphabetic one is kept —
  // that is reliably the merchant, while the others are rails and refs.
  if (/[/*]/.test(value)) {
    const segments = value
      .split(/[/*]/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .filter((segment) => !RAIL_PREFIXES.includes(segment))
      // Drop anything that is mostly digits — reference numbers, dates.
      .filter((segment) => !/^\d/.test(segment) && /[a-z]{3,}/.test(segment));

    if (segments.length > 0) {
      value = segments.reduce((longest, segment) =>
        segment.length > longest.length ? segment : longest,
      );
    }
  }

  // Punctuation to spaces, so "blue-tokai" and "blue tokai" agree.
  value = value.replace(/[._\-,'"()&+]/g, ' ');

  // Trailing reference digits: "swiggy 123456" -> "swiggy". Standalone digit
  // runs of 4+ are refs; shorter ones may be part of a name ("café 21").
  value = value.replace(/\b\d{4,}\b/g, ' ');

  value = value.replace(/\s+/g, ' ').trim();

  // Legal suffixes, only at the end — a leading "ltd" would be part of a name.
  for (const suffix of LEGAL_SUFFIXES) {
    if (value.endsWith(` ${suffix}`)) {
      value = value.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }

  // Leading rail prefix left over from a non-delimited descriptor.
  const firstWord = value.split(' ')[0];
  if (RAIL_PREFIXES.includes(firstWord) && value.includes(' ')) {
    value = value.slice(firstWord.length).trim();
  }

  // A key of only digits or a single character carries no signal.
  if (/^\d*$/.test(value) || value.length < 2) return '';

  return value;
}

/**
 * Display form of a merchant: title-cased, but acronyms left alone.
 * `swiggy` -> `Swiggy`, `hdfc` -> `HDFC`
 */
export function displayMerchant(normalized: string): string {
  if (!normalized) return 'Unknown merchant';

  return normalized
    .split(' ')
    .map((word) => {
      // Short all-consonant words are almost always acronyms (hdfc, kfc, bmtc).
      if (word.length <= 4 && !/[aeiou]/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}
