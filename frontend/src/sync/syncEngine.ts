/**
 * Sync orchestration: pull, merge, push, mark clean.
 *
 * The order matters. Pulling before pushing means a conflict is resolved with
 * both versions in hand, and the winner is pushed in the same pass. Pushing
 * first would send a row that is about to lose a conflict, causing a second
 * round trip and a window where the server holds a value no device agrees
 * with.
 */
import type { Transaction } from '../types/transaction';
import { markSynced, mergeAll } from './merge';
import {
  getUserId,
  isSyncConfigured,
  pullTransactions,
  pushTransactions,
} from './supabaseClient';

export interface SyncOutcome {
  ran: boolean;
  /** Why sync did not run, when `ran` is false. */
  skipped?: 'not-configured' | 'not-signed-in' | 'already-running';
  pulled: number;
  pushed: number;
  conflicts: number;
  transactions: Transaction[];
}

/** Guards against overlapping runs, which would double-push the same rows. */
let running = false;

export function isSyncRunning(): boolean {
  return running;
}

/**
 * Runs one full sync cycle against the given local rows.
 *
 * Returns the merged set rather than writing it — the store applies the
 * result, so this stays a pure-ish orchestration step over the transport.
 */
export async function runSync(
  local: readonly Transaction[],
  lastPulledAt: string | null,
): Promise<SyncOutcome> {
  const unchanged = {
    pulled: 0,
    pushed: 0,
    conflicts: 0,
    transactions: [...local],
  };

  if (!isSyncConfigured()) {
    return { ran: false, skipped: 'not-configured', ...unchanged };
  }

  if (running) {
    return { ran: false, skipped: 'already-running', ...unchanged };
  }

  const userId = await getUserId();
  if (!userId) {
    return { ran: false, skipped: 'not-signed-in', ...unchanged };
  }

  running = true;
  try {
    // 1. Pull everything changed since the last successful sync.
    const remote = await pullTransactions(lastPulledAt);

    // 2. Resolve. This is the only place a winner is decided.
    const merged = mergeAll(local, remote);

    // 3. Push whatever is still dirty after the merge.
    const toPush = merged.toPush;
    const acceptedIds = await pushTransactions(toPush);

    // 4. Mark clean — only the ids the server actually accepted, and only at
    // the updatedAt that was pushed, so an edit made mid-flight stays dirty.
    const pushedUpdatedAt = new Map(
      toPush.map((transaction) => [transaction.id, transaction.updatedAt]),
    );
    const transactions = markSynced(
      merged.transactions,
      new Set(acceptedIds),
      pushedUpdatedAt,
    );

    return {
      ran: true,
      pulled: merged.pulled,
      pushed: acceptedIds.length,
      conflicts: merged.conflicts,
      transactions,
    };
  } catch {
    // Never let a sync failure surface as a crash; the next cycle retries.
    return { ran: false, ...unchanged };
  } finally {
    running = false;
  }
}

// nextWatermark and pendingPushCount live in merge.ts: they are pure, and
// keeping them here would make them unreachable from tests, since this module
// pulls in the Supabase transport and its React Native dependencies.
export { nextWatermark, pendingPushCount } from './merge';
