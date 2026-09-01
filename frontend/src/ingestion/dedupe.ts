/**
 * Deduplication for dual-channel ingestion.
 *
 * With SMS and notification listeners both active, a single payment produces
 * two or three events: the UPI app's notification, the bank's SMS, and the
 * notification the messaging app posts for that same SMS. Double-counting
 * destroys trust in every number in the app, so this is the load-bearing
 * safety net for running both sources at once (rules.md §5).
 */
import type { ParsedBankEvent, Transaction } from '../types/transaction';

/**
 * How far apart two records of the same payment can be observed.
 * A bank SMS routinely lags the UPI app notification by a minute or more,
 * so this is deliberately wider than it looks like it needs to be.
 */
export const DEDUPE_WINDOW_MS = 180_000; // 3 minutes

/**
 * Builds the stable identity of a real-world payment.
 *
 * A reference number is authoritative when present. Without one the key is
 * intentionally coarse (day-level, not second-level) so that two events
 * seconds apart cannot land in different buckets; `findDuplicate` does the
 * precise time-window comparison.
 */
export function buildDedupeKey(event: ParsedBankEvent): string {
  if (event.refNo) {
    return `ref:${event.refNo}`;
  }

  const day = event.timestamp.slice(0, 10); // YYYY-MM-DD
  const tail = event.accountTail ?? 'na';
  return `amt:${event.amountMinor}|acct:${tail}|day:${day}`;
}

/** True when two account tails cannot be proven different. */
function tailsCompatible(a: string | null, b: string | null): boolean {
  // A UPI app notification usually omits the account tail entirely, so a
  // missing tail must not block a match against the bank's SMS.
  if (a === null || b === null) return true;
  return a === b;
}

/**
 * Finds an already-stored transaction describing the same payment.
 * Returns null when the candidate is genuinely new.
 */
export function findDuplicate(
  candidate: ParsedBankEvent,
  existing: readonly Transaction[],
  windowMs: number = DEDUPE_WINDOW_MS,
): Transaction | null {
  const candidateTime = Date.parse(candidate.timestamp);

  for (const transaction of existing) {
    // Reference numbers are authoritative: same ref means same payment,
    // regardless of how far apart the two channels reported it.
    if (candidate.refNo && transaction.refNo && candidate.refNo === transaction.refNo) {
      return transaction;
    }

    if (transaction.amountMinor !== candidate.amountMinor) continue;
    if (transaction.transactionType !== candidate.transactionType) continue;
    if (!tailsCompatible(candidate.accountTail, transaction.accountTail)) continue;

    const delta = Math.abs(Date.parse(transaction.timestamp) - candidateTime);
    if (delta <= windowMs) {
      return transaction;
    }
  }

  return null;
}

/**
 * Merges a duplicate event into the record already stored.
 *
 * Field-by-field the better source wins rather than one record replacing the
 * other: UPI apps carry clean merchant names ("Swiggy"), banks carry the
 * reference number and account tail ("UPI/SWGY*ORDER/123456", "x1234").
 * Anything the user has already said about the payment is never overwritten.
 */
export function mergeDuplicate(
  existing: Transaction,
  incoming: ParsedBankEvent,
): Transaction {
  const incomingHasRealMerchant = incoming.paidTo !== 'Unknown merchant';
  const existingHasRealMerchant = existing.paidTo !== 'Unknown merchant';

  // Prefer a notification's merchant name over a bank's machine-readable one,
  // but never over a name the user has already corrected or spoken.
  const preferIncomingMerchant =
    incomingHasRealMerchant &&
    (!existingHasRealMerchant ||
      (incoming.channel === 'notification' && existing.channel === 'sms' && existing.note === null));

  return {
    ...existing,
    paidTo: preferIncomingMerchant ? incoming.paidTo : existing.paidTo,
    // The bank is the source of truth for these, whichever channel supplied them.
    refNo: existing.refNo ?? incoming.refNo,
    accountTail: existing.accountTail ?? incoming.accountTail,
    accountInfo:
      existing.accountInfo === 'Unknown Account' ? incoming.accountInfo : existing.accountInfo,
    // Keep the earlier observation — it is closer to when the payment happened.
    timestamp:
      Date.parse(incoming.timestamp) < Date.parse(existing.timestamp)
        ? incoming.timestamp
        : existing.timestamp,
    dedupeKey: existing.refNo ?? incoming.refNo
      ? `ref:${existing.refNo ?? incoming.refNo}`
      : existing.dedupeKey,
    // Retain both raw messages so either parser can be debugged later.
    rawPayload:
      existing.rawPayload && incoming.rawPayload && existing.rawPayload !== incoming.rawPayload
        ? `${existing.rawPayload}\n---\n${incoming.rawPayload}`
        : existing.rawPayload ?? incoming.rawPayload,
  };
}
