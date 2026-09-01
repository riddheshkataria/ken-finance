/**
 * The pending-note queue.
 *
 * Payments the user has not yet explained form an ordered backlog worked down
 * one at a time. These are pure selectors over the transaction list — the
 * queue is derived, never stored as its own state (rules.md §3).
 */
import type { Transaction } from '../types/transaction';

/** Skips before an item stops being offered on the widget. */
export const MAX_SKIPS_BEFORE_REVIEW = 3;

/** Age at which an unanswered item stops being offered on the widget. */
export const QUEUE_ITEM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Oldest-first, with skipped items sunk to the back.
 *
 * Ordering is derived rather than stored: a persisted position drifts the
 * moment a late notification arrives out of order.
 */
export function selectPendingQueue(
  transactions: readonly Transaction[],
): Transaction[] {
  return transactions
    .filter((transaction) => transaction.status === 'pending_note')
    .sort((a, b) => {
      if (a.skippedCount !== b.skippedCount) {
        return a.skippedCount - b.skippedCount;
      }
      return Date.parse(a.timestamp) - Date.parse(b.timestamp);
    });
}

/** The item the widget should be showing right now. */
export function selectQueueHead(
  transactions: readonly Transaction[],
): Transaction | null {
  return selectPendingQueue(transactions)[0] ?? null;
}

export function selectQueueLength(transactions: readonly Transaction[]): number {
  return selectPendingQueue(transactions).length;
}

/**
 * The item to open when the user taps the mic.
 *
 * Tapping a notification jumps to that specific payment: it is fresh, and
 * forcing the user to first recall an older one is the exact friction this
 * app exists to remove. Tapping the widget starts at the head of the queue.
 */
export function selectCaptureTarget(
  transactions: readonly Transaction[],
  requestedId?: string,
): Transaction | null {
  if (requestedId) {
    const requested = transactions.find(
      (transaction) => transaction.id === requestedId && transaction.status === 'pending_note',
    );
    if (requested) return requested;
  }
  return selectQueueHead(transactions);
}

/**
 * Items that have aged out or been skipped too often.
 *
 * A queue the user cannot clear teaches them to ignore the widget entirely,
 * so these are retired out of the widget into an in-app review list.
 */
export function selectItemsToRetire(
  transactions: readonly Transaction[],
  now: number,
): Transaction[] {
  return transactions.filter(
    (transaction) =>
      transaction.status === 'pending_note' &&
      (transaction.skippedCount >= MAX_SKIPS_BEFORE_REVIEW ||
        now - Date.parse(transaction.timestamp) > QUEUE_ITEM_MAX_AGE_MS),
  );
}
