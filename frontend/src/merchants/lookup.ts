/**
 * Category resolution: three tiers, cheapest and most trustworthy first.
 *
 *   1. What the user told us     — always wins, never overridden
 *   2. The shipped dictionary    — sensible default so day one is not blank
 *   3. Nothing                   — return null; the caller falls back to the
 *                                  keyword guess, or later to the LLM
 *
 * Tier 1 existing at all is the point of this module: categorising Swiggy once
 * should mean never categorising Swiggy again. That alone removes most of the
 * tedium the app exists to solve, without a single API call.
 *
 * Pure — the store owns the memory and passes it in (rules.md §4).
 */
import type { TransactionCategory } from '../types/transaction';
import { AMBIGUOUS_PREFIXES, MERCHANT_DICTIONARY } from './dictionary';
import { normalizeMerchant } from './normalize';

/** What the user has taught us about one merchant. */
export interface MerchantMemory {
  /** Normalised lookup key, from `normalizeMerchant`. */
  key: string;
  /** Best display form seen so far. */
  displayName: string;
  category: TransactionCategory;
  /** How many times this mapping has been confirmed. */
  seenCount: number;
  updatedAt: string;
}

export type MerchantMemoryMap = Readonly<Record<string, MerchantMemory>>;

export type CategorySource = 'user-memory' | 'dictionary' | 'none';

export interface CategoryResolution {
  category: TransactionCategory | null;
  source: CategorySource;
  /** The normalised key used, so callers can store it alongside. */
  key: string;
}

/**
 * Resolves a category for a raw merchant string.
 *
 * Returns `null` rather than guessing when nothing matches, so the caller can
 * fall back deliberately (rules.md §4).
 */
export function resolveCategory(
  rawMerchant: string | null | undefined,
  memory: MerchantMemoryMap,
): CategoryResolution {
  const key = normalizeMerchant(rawMerchant);
  if (!key) return { category: null, source: 'none', key: '' };

  // Tier 1 — the user's own correction. Exact match only: inferring from a
  // partial match risks applying a correction to a merchant they never saw.
  const remembered = memory[key];
  if (remembered) {
    return { category: remembered.category, source: 'user-memory', key };
  }

  // Tier 2a — exact dictionary hit.
  const exact = MERCHANT_DICTIONARY[key];
  if (exact) return { category: exact, source: 'dictionary', key };

  // Tier 2b — the raw name often carries extra words the dictionary does not
  // ("swiggy instamart bangalore"). Match the longest dictionary entry that
  // appears as a whole-word run, so more specific entries beat general ones.
  const match = findLongestDictionaryMatch(key);
  if (match) return { category: match, source: 'dictionary', key };

  return { category: null, source: 'none', key };
}

/**
 * Finds the most specific dictionary entry contained in the key.
 *
 * Longest-first is what keeps "swiggy instamart" resolving to Grocery rather
 * than Dining. A bare ambiguous prefix is refused outright: if the key is
 * exactly "swiggy" we would have hit the exact match above, so reaching here
 * with only a prefix match means the rest of the name is unrecognised, and
 * guessing from the prefix is how Instamart gets filed as a restaurant.
 */
function findLongestDictionaryMatch(key: string): TransactionCategory | null {
  const keyWords = key.split(' ');

  let best: { entry: string; category: TransactionCategory } | null = null;

  for (const [entry, category] of Object.entries(MERCHANT_DICTIONARY)) {
    if (!containsWholeWordRun(keyWords, entry.split(' '))) continue;
    if (AMBIGUOUS_PREFIXES.has(entry) && entry !== key) continue;

    if (!best || entry.length > best.entry.length) {
      best = { entry, category };
    }
  }

  return best?.category ?? null;
}

/** True when `needle` appears in `haystack` as a consecutive whole-word run. */
function containsWholeWordRun(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  return false;
}

/**
 * Records what the user decided, returning the updated memory.
 *
 * Immutable so it can back a Zustand slice directly (rules.md §3).
 * A merchant with no usable key is dropped rather than stored under "" —
 * otherwise every unparseable payment would share one entry and overwrite
 * each other's category.
 */
export function learnMerchant(
  memory: MerchantMemoryMap,
  rawMerchant: string | null | undefined,
  category: TransactionCategory,
  now: string = new Date().toISOString(),
): MerchantMemoryMap {
  const key = normalizeMerchant(rawMerchant);
  if (!key) return memory;

  const existing = memory[key];

  return {
    ...memory,
    [key]: {
      key,
      // Keep the longest display name seen — it is usually the most
      // informative ("Swiggy Instamart" over "Swiggy").
      displayName:
        existing && existing.displayName.length >= (rawMerchant?.length ?? 0)
          ? existing.displayName
          : (rawMerchant ?? key),
      category,
      seenCount: (existing?.seenCount ?? 0) + 1,
      updatedAt: now,
    },
  };
}
