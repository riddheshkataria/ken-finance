/**
 * Sync decisions: what to push, what to pull, and who wins a conflict.
 *
 * Deliberately free of any network code so every rule here is testable in
 * plain Node. Sync bugs are the worst kind in a finance app — they lose or
 * duplicate money that the user believes is recorded — and they are almost
 * impossible to reproduce once they only appear against a live server.
 *
 * The model is last-write-wins per row, on `updatedAt`. That is the right
 * trade for this app: one user, a small number of devices, and rows that are
 * almost never edited from two places at once. Field-level merging would add
 * real complexity to solve a problem this shape of data does not have.
 */
import type { Transaction } from '../types/transaction';

/** A row as the server stores it. Same shape; the server owns nothing extra. */
export type RemoteTransaction = Transaction;

export interface MergeResult {
  /** The row to keep locally. */
  resolved: Transaction;
  /** Why, for logging and tests. */
  reason: 'local-newer' | 'remote-newer' | 'identical' | 'local-only' | 'remote-only';
}

/**
 * Rows with local changes the server has not acknowledged.
 *
 * Tombstones are included: a delete is a change like any other, and excluding
 * it is exactly how a deleted row comes back from the dead on another device.
 */
export function selectDirty(transactions: readonly Transaction[]): Transaction[] {
  return transactions.filter(
    (transaction) =>
      transaction.syncedAt === null || transaction.updatedAt > transaction.syncedAt,
  );
}

/**
 * Resolves one row against its server counterpart.
 *
 * Ties go to the remote. An exact `updatedAt` tie means the same millisecond
 * on two clocks, which realistically means the two are the same write; picking
 * a side consistently keeps two devices from ping-ponging an identical row
 * back and forth forever.
 */
export function mergeOne(
  local: Transaction | undefined,
  remote: RemoteTransaction | undefined,
): MergeResult | null {
  if (!local && !remote) return null;

  if (local && !remote) {
    return { resolved: local, reason: 'local-only' };
  }

  if (!local && remote) {
    // Arrives already reconciled with the server.
    return {
      resolved: { ...remote, syncedAt: remote.updatedAt },
      reason: 'remote-only',
    };
  }

  // Both defined past this point.
  const localRow = local as Transaction;
  const remoteRow = remote as RemoteTransaction;

  if (localRow.updatedAt === remoteRow.updatedAt) {
    return {
      resolved: { ...localRow, syncedAt: remoteRow.updatedAt },
      reason: 'identical',
    };
  }

  if (localRow.updatedAt > remoteRow.updatedAt) {
    // Local wins, and stays dirty so it is pushed.
    return { resolved: localRow, reason: 'local-newer' };
  }

  return {
    resolved: { ...remoteRow, syncedAt: remoteRow.updatedAt },
    reason: 'remote-newer',
  };
}

export interface MergeAllResult {
  /** The full local set after merging. */
  transactions: Transaction[];
  /** Rows that still need pushing. */
  toPush: Transaction[];
  pulled: number;
  conflicts: number;
}

/**
 * Merges a batch of server rows into the local set.
 *
 * Matching is by `id`. Ids are generated locally and never reassigned by the
 * server, so they survive the round trip — which is also why the dedupe layer
 * has to be correct before sync: two ids for one payment become two permanent
 * rows on every device.
 */
export function mergeAll(
  local: readonly Transaction[],
  remote: readonly RemoteTransaction[],
): MergeAllResult {
  const localById = new Map(local.map((row) => [row.id, row]));
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

  const transactions: Transaction[] = [];
  let pulled = 0;
  let conflicts = 0;

  for (const id of allIds) {
    const result = mergeOne(localById.get(id), remoteById.get(id));
    if (!result) continue;

    if (result.reason === 'remote-only' || result.reason === 'remote-newer') {
      pulled += 1;
    }
    if (result.reason === 'remote-newer' || result.reason === 'local-newer') {
      // Both sides changed since the last sync.
      const localRow = localById.get(id);
      if (localRow && (localRow.syncedAt === null || localRow.updatedAt > localRow.syncedAt)) {
        conflicts += 1;
      }
    }

    transactions.push(result.resolved);
  }

  return {
    transactions,
    toPush: selectDirty(transactions),
    pulled,
    conflicts,
  };
}

/**
 * Marks rows as acknowledged by the server.
 *
 * `syncedAt` is set to the row's own `updatedAt`, not to "now". Using the
 * wall clock would mark a row clean that the user edited while the push was
 * in flight, and that edit would then never be sent — a silent data loss that
 * is very hard to trace back.
 */
export function markSynced(
  transactions: readonly Transaction[],
  pushedIds: ReadonlySet<string>,
  pushedUpdatedAt: ReadonlyMap<string, string>,
): Transaction[] {
  return transactions.map((transaction) => {
    if (!pushedIds.has(transaction.id)) return transaction;

    const pushedAt = pushedUpdatedAt.get(transaction.id);
    if (!pushedAt) return transaction;

    // The row changed again after the push was assembled — leave it dirty.
    if (transaction.updatedAt !== pushedAt) return transaction;

    return { ...transaction, syncedAt: pushedAt };
  });
}

/**
 * Tombstones old enough to drop entirely.
 *
 * A tombstone only needs to live long enough for every device to have seen
 * it. Keeping them forever grows the table without bound.
 */
export function selectPurgeableTombstones(
  transactions: readonly Transaction[],
  now: number,
  retentionMs: number = 90 * 24 * 60 * 60 * 1000,
): Transaction[] {
  return transactions.filter((transaction) => {
    if (transaction.deletedAt === null) return false;
    // Never drop a tombstone the server has not acknowledged, or the delete
    // is lost and the row returns on the next pull.
    if (transaction.syncedAt === null) return false;
    if (transaction.updatedAt > transaction.syncedAt) return false;

    return now - Date.parse(transaction.deletedAt) > retentionMs;
  });
}

/**
 * The watermark for the next pull.
 *
 * Taken from the newest row actually merged rather than the wall clock: a
 * device with a fast clock would otherwise skip past rows written in the gap
 * and never see them again.
 */
export function nextWatermark(
  transactions: readonly Transaction[],
  previous: string | null,
): string | null {
  let newest = previous;

  for (const transaction of transactions) {
    if (newest === null || transaction.updatedAt > newest) {
      newest = transaction.updatedAt;
    }
  }

  return newest;
}

/** Count of rows waiting to be pushed, for the UI. */
export function pendingPushCount(transactions: readonly Transaction[]): number {
  return selectDirty(transactions).length;
}
