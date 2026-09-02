/**
 * Parse -> dedupe -> materialise, as one pure step.
 *
 * Kept free of store access so it can be exercised entirely from fixtures
 * (rules.md §4). The store applies the outcome; it does not decide it.
 */
import type { Transaction } from '../types/transaction';
import type { IngestionEvent, RejectionReason } from './types';
import { parseIngestionEvent } from './parseEvent';
import { buildDedupeKey, findDuplicate, mergeDuplicate } from './dedupe';

export type IngestionOutcome =
  | { kind: 'rejected'; reason: RejectionReason }
  /** The payment was already known; `merged` supersedes the stored record. */
  | { kind: 'duplicate'; merged: Transaction }
  | { kind: 'created'; transaction: Transaction };

/** Injectable so fixtures produce stable ids. */
export type IdFactory = () => string;

const defaultIdFactory: IdFactory = () =>
  `txn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Ingests one bank event against the transactions already known.
 *
 * New bank events always land as `pending_note`: the bank tells us what was
 * spent, and only the user can say why. That status is what puts the payment
 * into the widget queue.
 */
export function ingestEvent(
  event: IngestionEvent,
  existing: readonly Transaction[],
  idFactory: IdFactory = defaultIdFactory,
): IngestionOutcome {
  const parsed = parseIngestionEvent(event);
  if (!parsed.ok) {
    return { kind: 'rejected', reason: parsed.reason };
  }

  const duplicate = findDuplicate(parsed.event, existing);
  if (duplicate) {
    return { kind: 'duplicate', merged: mergeDuplicate(duplicate, parsed.event) };
  }

  return {
    kind: 'created',
    transaction: {
      id: idFactory(),
      amountMinor: parsed.event.amountMinor,
      title: parsed.event.title,
      category: parsed.event.category,
      paidTo: parsed.event.paidTo,
      accountInfo: parsed.event.accountInfo,
      transactionType: parsed.event.transactionType,
      timestamp: parsed.event.timestamp,
      source: parsed.event.source,
      channel: parsed.event.channel,
      refNo: parsed.event.refNo,
      accountTail: parsed.event.accountTail,
      dedupeKey: buildDedupeKey(parsed.event),
      rawPayload: parsed.event.rawPayload,
      status: 'pending_note',
      skippedCount: 0,
      lastPromptedAt: null,
      note: null,
      transcript: null,
      audioPath: null,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      // Never synced: this row is dirty and will be pushed on the next sync.
      syncedAt: null,
    },
  };
}
