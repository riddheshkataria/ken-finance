/**
 * Write-through persistence for the transaction store.
 *
 * Implemented as a diff between successive states rather than a save call
 * inside every action. Two reasons: the store keeps exactly one definition of
 * each mutation (rules.md §3), and any action added later is persisted
 * automatically instead of silently not being saved — the kind of omission
 * nobody notices until data is already lost.
 *
 * The storage functions are injected rather than imported so this file stays
 * free of expo-sqlite and the diff logic is testable in plain Node.
 */
import type { Transaction } from '../types/transaction';

export interface PersistenceSink {
  saveTransactions(transactions: readonly Transaction[]): Promise<void>;
  deleteTransaction(id: string): Promise<void>;
}

/**
 * Persists whatever changed between two transaction lists.
 *
 * Relies on the store's immutable updates (rules.md §3): an unchanged
 * transaction keeps its object identity, so a reference comparison finds the
 * changed rows without deep-equality checks on every one.
 */
export async function persistDiff(
  previous: readonly Transaction[],
  next: readonly Transaction[],
  sink: PersistenceSink,
): Promise<void> {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextIds = new Set(next.map((item) => item.id));

  const changed = next.filter((item) => previousById.get(item.id) !== item);
  if (changed.length > 0) {
    await sink.saveTransactions(changed);
  }

  for (const item of previous) {
    if (!nextIds.has(item.id)) {
      await sink.deleteTransaction(item.id);
    }
  }
}
