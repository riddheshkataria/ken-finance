/**
 * The single entry point for turning a bank event into a transaction.
 *
 * Both channels funnel through `parseIngestionEvent` so there is exactly one
 * parsing path to test and fix (rules.md §4). Nothing else in the app may
 * parse a payment.
 */
import type { ParsedBankEvent } from '../types/transaction';
import type { IngestionEvent, IngestionResult } from './types';
import {
  BANK_HEADER_PATTERNS,
  NOTIFICATION_PACKAGE_ALLOWLIST,
  buildAccountInfo,
  extractAccountTail,
  extractAmountMinor,
  extractPaidTo,
  extractRefNo,
  extractTimestamp,
  extractTransactionType,
  findRejectionReason,
  inferCategory,
} from './extractors';

/**
 * Whether an SMS looks like it came from a financial institution.
 * Falls back to body heuristics because some banks send from masked or
 * rotating headers that no allowlist can keep up with.
 */
export function isBankSms(sender: string, body: string): boolean {
  if (sender) {
    for (const pattern of BANK_HEADER_PATTERNS) {
      if (pattern.test(sender)) return true;
    }
  }

  const looksFinancial = /(?:debited|credited|spent|withdrawn|sent\s+rs|a\/c|vpa|upi\s*ref)/i.test(body);
  const mentionsCurrency = /(?:rs\.?|inr|₹)\s*[\d,]+/i.test(body);
  return looksFinancial && mentionsCurrency;
}

/** Whether a notification came from an app that can describe a payment. */
export function isPaymentNotificationPackage(packageName: string): boolean {
  return NOTIFICATION_PACKAGE_ALLOWLIST.includes(packageName);
}

/**
 * Notifications split the useful text across title and body — Google Pay puts
 * the amount in the title ("₹240") and the merchant in the body. Parsing the
 * concatenation avoids two near-identical code paths.
 */
function textOf(event: IngestionEvent): string {
  return event.title ? `${event.title}. ${event.body}` : event.body;
}

/**
 * Parses a normalised ingestion event into a bank transaction.
 * Returns a tagged result so callers — and fixtures — can assert on exactly
 * why an event was discarded.
 */
export function parseIngestionEvent(event: IngestionEvent): IngestionResult {
  const text = textOf(event);

  if (event.channel === 'sms' && !isBankSms(event.origin, event.body)) {
    return { ok: false, reason: 'not-financial' };
  }

  if (event.channel === 'notification' && !isPaymentNotificationPackage(event.origin)) {
    return { ok: false, reason: 'not-financial' };
  }

  const rejection = findRejectionReason(text);
  if (rejection) {
    return { ok: false, reason: rejection };
  }

  const amountMinor = extractAmountMinor(text);
  if (amountMinor === null) {
    return { ok: false, reason: 'no-amount' };
  }

  const transactionType = extractTransactionType(text);
  const paidTo = extractPaidTo(text);
  const category = inferCategory(paidTo, text, transactionType);

  // A missing merchant is surfaced honestly rather than invented; the user's
  // voice note is what fills this in.
  const displayName = paidTo ?? 'Unknown merchant';

  return {
    ok: true,
    event: {
      amountMinor,
      transactionType,
      paidTo: displayName,
      accountInfo: buildAccountInfo(event.origin, text),
      accountTail: extractAccountTail(text),
      refNo: extractRefNo(text),
      timestamp: extractTimestamp(text, event.receivedAt),
      category,
      title:
        transactionType === 'Credit'
          ? `Received from ${displayName}`
          : `Payment to ${displayName}`,
      channel: event.channel,
      source: event.channel === 'sms' ? 'SMS-parsed' : 'Notification-parsed',
      rawPayload: text,
    } satisfies ParsedBankEvent,
  };
}
