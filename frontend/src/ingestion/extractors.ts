/**
 * Pure field extractors shared by both ingestion channels.
 *
 * Every function here is pure and takes any time reference as an argument, so
 * fixtures are deterministic (rules.md §4). A field that cannot be determined
 * confidently returns null — never a guess.
 */
import { parseAmountToPaise } from '../utils/money';
import type { TransactionCategory, TransactionType } from '../types/transaction';
import type { RejectionReason } from './types';

/** Bank sender headers, matched against the DLT header portion of the sender. */
export const BANK_HEADER_PATTERNS: readonly RegExp[] = [
  /HDFC/i, /SBI/i, /ICICI/i, /AXIS/i, /KOTAK/i, /PNB/i, /BOB/i,
  /CANARA/i, /CANBNK/i, /UNIONB/i, /IDFC/i, /INDUS/i, /YESBNK/i,
  /RBL/i, /PAYTM/i, /AMEX/i, /CITI/i, /FEDERAL/i, /HSBC/i, /SCBANK/i,
  /CENTBK/i, /IOB/i, /UBI/i, /AUBNK/i, /BANDHAN/i,
];

/**
 * Android packages whose notifications may describe a payment.
 * Messaging apps are included because a bank SMS surfaces as a notification
 * from the default SMS app, which lets us read it even if SMS permission is
 * unavailable or revoked.
 */
export const NOTIFICATION_PACKAGE_ALLOWLIST: readonly string[] = [
  'com.google.android.apps.nbu.paisa.user', // Google Pay India
  'com.phonepe.app',
  'net.one97.paytm',
  'in.amazon.mShop.android.shopping',       // Amazon Pay
  'com.dreamplug.androidapp',               // CRED
  'org.npci.upi.ppbl',                      // BHIM UPI
  'com.navi.finance',                       // Navi
  'money.fi.app',                           // Fi Money
  'money.jupiter',                          // Jupiter
  'indwin.c3.shareapp',                     // Slice
  'com.supermoney.app',                     // Super.money
  'com.google.android.apps.messaging',      // Google Messages (carries bank SMS)
  'com.samsung.android.messaging',
  'com.android.mms',
];

// --- Rejection ---------------------------------------------------------

const OTP_PATTERN = /\b(?:otp|one[\s-]?time\s+password|verification\s+code|do\s+not\s+share)\b/i;
const PROMO_PATTERN = /\b(?:pre[\s-]?approved|apply\s+now|avail\s+(?:a\s+)?loan|instant\s+loan|offer\s+valid|limited\s+period|click\s+here|lowest\s+interest|upgrade\s+your\s+card)\b/i;
const FAILED_PATTERN = /\b(?:failed|declined|unsuccessful|reversed|could\s+not\s+be\s+processed)\b/i;
const REQUEST_PATTERN = /\b(?:has\s+requested|is\s+requesting|collect\s+request|payment\s+request|requesting\s+money|approve\s+to\s+pay)\b/i;
const FUTURE_PATTERN = /\b(?:will\s+be\s+debited|will\s+be\s+deducted|is\s+due|scheduled\s+for)\b/i;
const MOVEMENT_PATTERN = /\b(?:debited|credited|spent|withdrawn|paid|sent|received|transferred|purchase)\b/i;
const BALANCE_PATTERN = /\b(?:avl|available|avbl)\.?\s*(?:bal|balance)\b/i;

/**
 * Decides whether an event describes a completed money movement.
 * Returns a reason when the event must be discarded, or null to continue.
 *
 * Order matters: OTP and promotional messages frequently also mention an
 * amount, so they are checked before the "does it look financial" test.
 */
export function findRejectionReason(text: string): RejectionReason | null {
  if (!text.trim()) return 'not-financial';

  if (OTP_PATTERN.test(text)) return 'otp';
  if (PROMO_PATTERN.test(text)) return 'promotional';
  if (REQUEST_PATTERN.test(text)) return 'payment-request';
  if (FAILED_PATTERN.test(text)) return 'failed-or-reversed';
  if (FUTURE_PATTERN.test(text)) return 'future-dated';

  if (!MOVEMENT_PATTERN.test(text)) {
    // "Avl Bal Rs.12,345" with no movement verb is a balance alert.
    return BALANCE_PATTERN.test(text) ? 'balance-only' : 'not-financial';
  }

  return null;
}

// --- Amount ------------------------------------------------------------

/**
 * Extracts the transaction amount in paise.
 *
 * Balance figures are stripped first, because "debited by Rs.240. Avl Bal
 * Rs.11,760" contains two amounts and taking the wrong one is silent and
 * catastrophic. Anchoring on a currency marker also stops reference numbers
 * and account digits being read as the amount.
 */
export function extractAmountMinor(text: string): number | null {
  const withoutBalance = text.replace(
    /\b(?:avl|available|avbl)\.?\s*(?:bal|balance)\b[^.]*?(?:rs\.?|inr|₹)\s*[\d,]+(?:\.\d{1,2})?/gi,
    ' ',
  );

  const patterns: readonly RegExp[] = [
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|inr|₹)/i,
    // SBI and a few others omit the currency entirely: "debited by 1250.0".
    // Anchoring on the movement verb keeps account and reference digits out.
    /\b(?:debited|credited|spent|paid|withdrawn|transferred)\s+(?:by|for|with|of)?\s*([\d,]+(?:\.\d{1,2})?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = withoutBalance.match(pattern);
    if (match && match[1]) {
      const minor = parseAmountToPaise(match[1]);
      if (minor !== null) return minor;
    }
  }

  return null;
}

// --- Direction ---------------------------------------------------------

const CREDIT_PATTERN = /\b(?:credited|received|refund(?:ed)?|cashback|deposited|added\s+to)\b/i;

/**
 * Debit is the default because an expense wrongly logged as income distorts
 * budgets in the direction users are least likely to notice.
 */
export function extractTransactionType(text: string): TransactionType {
  return CREDIT_PATTERN.test(text) ? 'Credit' : 'Debit';
}

// --- Reference number --------------------------------------------------

/**
 * Extracts the bank reference / UPI RRN — the primary dedupe signal.
 * Matches: "Ref 123456789012", "UPI Ref no 123456789012", "Refno:123456789012"
 */
export function extractRefNo(text: string): string | null {
  const patterns: readonly RegExp[] = [
    /(?:upi\s*)?ref(?:erence)?\s*(?:no\.?|num(?:ber)?|#)?\s*[:.\s-]?\s*(\d{6,20})/i,
    /\brrn\s*[:.\s-]?\s*(\d{6,20})/i,
    /\btxn\s*(?:id|no\.?)\s*[:.\s-]?\s*([A-Za-z0-9]{6,24})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }

  return null;
}

// --- Account -----------------------------------------------------------

/** Extracts the masked account tail, e.g. "A/C x1234" -> "1234". */
export function extractAccountTail(text: string): string | null {
  const patterns: readonly RegExp[] = [
    /(?:a\/c|acct|acc(?:ount)?|card)\s*(?:no\.?)?\s*[*xX.\s-]{0,4}(\d{3,4})\b/i,
    /\b[*xX]{2,}\s?(\d{3,4})\b/,
    /\bending\s+(?:with|in)\s+(\d{3,4})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }

  return null;
}

const BANK_NAMES: readonly (readonly [RegExp, string])[] = [
  [/HDFC/i, 'HDFC'], [/SBI/i, 'SBI'], [/ICICI/i, 'ICICI'], [/AXIS/i, 'AXIS'],
  [/KOTAK/i, 'KOTAK'], [/IDFC/i, 'IDFC'], [/PNB/i, 'PNB'], [/BOB/i, 'BOB'],
  [/PAYTM/i, 'Paytm'], [/YES/i, 'Yes Bank'], [/INDUS/i, 'IndusInd'],
  [/RBL/i, 'RBL'], [/AMEX/i, 'Amex'], [/FEDERAL/i, 'Federal'],
];

export function extractBankName(origin: string, body: string): string | null {
  for (const entry of BANK_NAMES) {
    if (entry[0].test(origin) || entry[0].test(body)) return entry[1];
  }
  return null;
}

/** Human-readable account label, e.g. "HDFC - 4392". */
export function buildAccountInfo(origin: string, body: string): string {
  const bank = extractBankName(origin, body);
  const tail = extractAccountTail(body);

  if (bank && tail) return `${bank} - ${tail}`;
  if (bank) return `${bank} Account`;
  if (tail) return `Account - ${tail}`;
  return 'Unknown Account';
}

// --- Merchant ----------------------------------------------------------

const MERCHANT_STOPWORDS: ReadonlySet<string> = new Set([
  'your', 'the', 'account', 'vpa', 'card', 'bank', 'upi', 'atm', 'a/c',
  'you', 'this', 'that', 'and', 'for', 'via',
]);

/**
 * Extracts the merchant or counterparty.
 *
 * Returns null rather than a placeholder when nothing is confidently found —
 * the UI shows "Unknown" and the user's voice note fills the gap. A wrong
 * merchant is far worse than a missing one (rules.md §4).
 */
export function extractPaidTo(text: string): string | null {
  // A VPA is the most reliable signal: "to VPA swiggy@icici"
  const vpa = text.match(/(?:to|from)\s+(?:vpa\s+)?([a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,})/i);
  if (vpa && vpa[1]) return vpa[1].trim();

  const patterns: readonly RegExp[] = [
    // "You paid ₹240 to Swiggy" — UPI app notifications, the cleanest source
    /\b(?:paid|sent)\s+(?:₹|rs\.?|inr)?\s*[\d,.]+\s+to\s+([A-Za-z0-9&.'\s-]{2,40}?)(?=\s*(?:$|[.,]|on|via|ref|using))/i,
    // "trf to SWIGGY Refno" / "to SWIGGY on 01/09/26"
    /\b(?:trf\s+to|transfer(?:red)?\s+to|paid\s+to|sent\s+to|to)\s+([A-Za-z0-9&.'\s-]{2,40}?)(?=\s+(?:on|via|ref|refno|upi|avl|avbl|bal|dated)\b|[.,]|$)/i,
    // "at STARBUCKS on"
    /\bat\s+([A-Za-z0-9&.'\s-]{2,40}?)(?=\s+(?:on|via|ref|upi|avl|bal)\b|[.,]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;

    const candidate = match[1].replace(/[.,;:_\-\s]+$/, '').trim();
    if (
      candidate.length > 1 &&
      !MERCHANT_STOPWORDS.has(candidate.toLowerCase()) &&
      // Pure digits are almost always a reference number, not a merchant.
      !/^\d+$/.test(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

// --- Category ----------------------------------------------------------

const CATEGORY_RULES: readonly (readonly [RegExp, TransactionCategory])[] = [
  [/swiggy|zomato|starbucks|mcdonald|domino|kfc|cafe|coffee|restaurant|food|burger|pizza|bakery|barbeque|chai/i, 'Dining'],
  [/instamart|blinkit|zepto|bigbasket|dmart|supermarket|grocer|kirana|milk|reliance\s?fresh/i, 'Grocery'],
  [/uber|ola|rapido|cab|petrol|fuel|metro|irctc|fastag|toll|parking|indigo|redbus|auto/i, 'Transport'],
  [/\brent\b|landlord|society\s+maintenance|brokerage/i, 'Rent'],
  [/electricity|bescom|tata\s?power|airtel|jio|recharge|dth|broadband|gas\s+bill|water\s+bill|insurance|premium/i, 'Bills'],
  [/zerodha|groww|upstox|angelone|mutual\s?fund|\bsip\b|smallcase|\bnps\b/i, 'Investment'],
];

/**
 * Best-effort category from merchant text. Only a first guess — merchant
 * memory and the user's voice note override it downstream.
 */
export function inferCategory(
  paidTo: string | null,
  text: string,
  transactionType: TransactionType,
): TransactionCategory {
  if (transactionType === 'Credit') return 'P2P Transfer';

  const haystack = `${paidTo ?? ''} ${text}`;
  for (const entry of CATEGORY_RULES) {
    if (entry[0].test(haystack)) return entry[1];
  }

  // A VPA that matched no merchant rule is usually a person, not a business.
  if (paidTo && paidTo.includes('@')) return 'P2P Transfer';

  return 'Others';
}

// --- Timestamp ---------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parses a date written in the message body, falling back to the observation
 * time. Banks write dates in the user's local timezone, and a two-digit year
 * is interpreted as 2000-2099.
 *
 * Handles: "01/09/26", "01-09-2026", "01Sep26", "01-Sep-26"
 */
export function extractTimestamp(text: string, receivedAt: number): string {
  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numeric) {
    const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
    const parsed = new Date(year, Number(numeric[2]) - 1, Number(numeric[1]));
    if (!Number.isNaN(parsed.getTime())) {
      return alignToObservedTime(parsed, receivedAt);
    }
  }

  const alpha = text.match(/\b(\d{1,2})[\s-]?([A-Za-z]{3})[\s-]?(\d{2,4})\b/);
  if (alpha) {
    const month = MONTHS[alpha[2].toLowerCase()];
    if (month !== undefined) {
      const year = Number(alpha[3].length === 2 ? `20${alpha[3]}` : alpha[3]);
      const parsed = new Date(year, month, Number(alpha[1]));
      if (!Number.isNaN(parsed.getTime())) {
        return alignToObservedTime(parsed, receivedAt);
      }
    }
  }

  return new Date(receivedAt).toISOString();
}

/**
 * Bank messages carry a date but rarely a usable time. When the parsed date
 * is the same day we observed the message, keep the observation time — the
 * ±10 minute reconciliation window against a voice note depends on it.
 */
function alignToObservedTime(parsedDate: Date, receivedAt: number): string {
  const observed = new Date(receivedAt);
  const sameDay =
    parsedDate.getFullYear() === observed.getFullYear() &&
    parsedDate.getMonth() === observed.getMonth() &&
    parsedDate.getDate() === observed.getDate();

  return sameDay ? observed.toISOString() : parsedDate.toISOString();
}
