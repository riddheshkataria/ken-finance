/**
 * The paid tier of categorisation.
 *
 * Only reached when user memory and the shipped dictionary have both missed.
 * Everything here is built around calling it as rarely as possible:
 *
 *  - callers must filter to `source: 'none'` first (see `selectNeedingLlm`)
 *  - requests are batched, so twenty transactions cost one round trip
 *  - high-confidence answers are written back into merchant memory, so the
 *    same merchant is never sent twice
 *
 * The signal that makes this worth paying for is the user's voice note:
 * "chai with the team" is unambiguous to a model and invisible to a regex.
 */
import type { Transaction, TransactionCategory } from '../types/transaction';
import { resolveCategory, type MerchantMemoryMap } from './lookup';

/** Must match the backend's MAX_BATCH_SIZE. */
export const MAX_BATCH_SIZE = 50;

const VALID_CATEGORIES: ReadonlySet<string> = new Set<TransactionCategory>([
  'Dining',
  'Grocery',
  'Transport',
  'Rent',
  'Bills',
  'P2P Transfer',
  'Investment',
  'Others',
]);

export type Confidence = 'high' | 'medium' | 'low';

export interface CategorySuggestion {
  id: string;
  category: TransactionCategory;
  confidence: Confidence;
}

/**
 * Selects only the transactions the free tiers could not categorise.
 *
 * This is the cost control. Calling the API for a transaction that merchant
 * memory already knows is pure waste, and at scale it is the difference
 * between pennies and a real bill.
 */
export function selectNeedingLlm(
  transactions: readonly Transaction[],
  memory: MerchantMemoryMap,
): Transaction[] {
  return transactions.filter((transaction) => {
    // Already answered by the user, directly or through memory.
    if (transaction.status === 'ignored') return false;
    if (resolveCategory(transaction.paidTo, memory).source !== 'none') {
      return false;
    }
    // A note is the whole reason the model can do better than the regex. With
    // no note and no known merchant, it has nothing the parser did not have.
    return Boolean(transaction.note || transaction.transcript);
  });
}

/**
 * Validates one suggestion from the server.
 *
 * The backend's category list is a separate copy of the enum, so a drift
 * between them must degrade to "uncategorised" rather than writing a category
 * the app does not understand (rules.md §2).
 */
function parseSuggestion(value: unknown): CategorySuggestion | null {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Record<string, unknown>;
  const { id, category, confidence } = candidate;

  if (typeof id !== 'string' || typeof category !== 'string') return null;
  if (!VALID_CATEGORIES.has(category)) return null;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    return null;
  }

  return { id, category: category as TransactionCategory, confidence };
}

export interface CategorizerOptions {
  /** Base URL of the Express API. */
  baseUrl: string;
  signal?: AbortSignal;
}

/**
 * Requests categories for a batch.
 *
 * Returns [] on any failure — a missing category is an inconvenience the user
 * resolves with one tap, while a thrown error here would break ingestion.
 */
export async function requestCategories(
  transactions: readonly Transaction[],
  options: CategorizerOptions,
): Promise<CategorySuggestion[]> {
  if (transactions.length === 0) return [];

  const batch = transactions.slice(0, MAX_BATCH_SIZE);

  try {
    const response = await fetch(`${options.baseUrl}/api/categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        // Only what categorisation needs. No account tails, no reference
        // numbers, no raw message text (rules.md §9).
        items: batch.map((transaction) => ({
          id: transaction.id,
          merchant: transaction.paidTo,
          amountMinor: transaction.amountMinor,
          transactionType: transaction.transactionType,
          note: transaction.note ?? transaction.transcript,
        })),
      }),
    });

    // 503 means categorisation is simply not configured — expected, not an
    // error worth surfacing.
    if (!response.ok) return [];

    const body: unknown = await response.json();
    const results = (body as { results?: unknown })?.results;
    if (!Array.isArray(results)) return [];

    return results
      .map(parseSuggestion)
      .filter((suggestion): suggestion is CategorySuggestion => suggestion !== null);
  } catch {
    return [];
  }
}

/**
 * Whether a suggestion should be written back into merchant memory.
 *
 * Only high-confidence ones. Remembering a guess would let a single model
 * mistake apply itself to every future payment to that merchant — and because
 * memory outranks the dictionary, it would also override a correct shipped
 * answer. A user correction always overwrites whatever is remembered.
 */
export function shouldRemember(suggestion: CategorySuggestion): boolean {
  return suggestion.confidence === 'high';
}
