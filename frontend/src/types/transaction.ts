/**
 * Core transaction types for Ken Finance.
 * See rules.md §1 (money), §2 (types) and §5 (reconciliation) before editing.
 */

/**
 * Closed set of 8 categories. Adding one means updating this enum, the
 * category pills UI and the LLM prompt taxonomy together (rules.md §2).
 */
export type TransactionCategory =
  | 'Dining'
  | 'Grocery'
  | 'Transport'
  | 'Rent'
  | 'Bills'
  | 'P2P Transfer'
  | 'Investment'
  | 'Others';

export type TransactionType = 'Debit' | 'Credit';

/** How the record came to exist, and whether it has since been merged. */
export type TransactionSource =
  | 'Voice-only'
  | 'SMS-parsed'
  | 'Notification-parsed'
  | 'Merged'
  | 'Manual';

/** Which ingestion channel produced the underlying bank event. */
export type IngestionChannel = 'sms' | 'notification' | 'voice' | 'manual';

/**
 * Position in the pending-note workflow.
 * - pending_note: bank event captured, user has not said what it was for
 * - complete:     has a note/category the user confirmed
 * - ignored:      deliberately not worth a note (ATM, transfer to self)
 * - needs_review: skipped too often or aged out of the widget queue
 */
export type TransactionStatus =
  | 'pending_note'
  | 'complete'
  | 'ignored'
  | 'needs_review';

export interface Transaction {
  id: string;

  /** Integer paise. NEVER rupees, never a float. rules.md §1. */
  amountMinor: number;

  title: string;
  category: TransactionCategory;
  paidTo: string;
  accountInfo: string;
  transactionType: TransactionType;

  /** ISO 8601. When the payment happened, per the bank where available. */
  timestamp: string;

  source: TransactionSource;
  channel: IngestionChannel;

  /** Bank reference / UPI RRN. The primary dedupe signal when present. */
  refNo: string | null;

  /** Last 3-4 digits of the account, used for the fallback dedupe key. */
  accountTail: string | null;

  /** Stable identity for this real-world payment. See ingestion/dedupe.ts. */
  dedupeKey: string;

  /** Original message text. Kept forever so parser bugs stay fixable (rules.md §4). */
  rawPayload: string | null;

  status: TransactionStatus;

  /** Times the user skipped this in the queue; sinks it down the order. */
  skippedCount: number;

  lastPromptedAt: string | null;

  /** The user's own words about this payment. */
  note: string | null;

  /** Raw speech-to-text output, before any editing. */
  transcript: string | null;

  /** Local file path of the recording, so the user can replay and correct. */
  audioPath: string | null;

  // --- Sync metadata ---

  /** ISO. Bumped on every local mutation; the basis for conflict resolution. */
  updatedAt: string;

  /**
   * Soft delete. A hard delete cannot be synced — the row simply vanishes
   * locally and the server, having never heard about it, pushes it straight
   * back on the next pull. A tombstone is the only thing that propagates.
   */
  deletedAt: string | null;

  /**
   * When this row was last confirmed on the server. `null` means it has never
   * synced. A row is dirty when `syncedAt` is null or older than `updatedAt` —
   * derived rather than stored, so the two cannot drift apart.
   */
  syncedAt: string | null;
}

/** True when a row has local changes the server has not acknowledged. */
export function isDirty(transaction: Transaction): boolean {
  if (transaction.syncedAt === null) return true;
  return transaction.updatedAt > transaction.syncedAt;
}

/** True when a row should be shown to the user. */
export function isVisible(transaction: Transaction): boolean {
  return transaction.deletedAt === null;
}

/**
 * Fields a parser can produce from a bank event. Everything the parser cannot
 * determine with confidence is absent rather than guessed (rules.md §4).
 */
export type ParsedBankEvent = Pick<
  Transaction,
  | 'amountMinor'
  | 'transactionType'
  | 'paidTo'
  | 'accountInfo'
  | 'accountTail'
  | 'refNo'
  | 'timestamp'
  | 'category'
  | 'title'
  | 'channel'
  | 'source'
  | 'rawPayload'
>;

/** True when the record's financial data came from a bank, not the user. */
export function isBankSourced(source: TransactionSource): boolean {
  return (
    source === 'SMS-parsed' ||
    source === 'Notification-parsed' ||
    source === 'Merged'
  );
}

/** True when the record is awaiting a voice note from the user. */
export function isAwaitingNote(transaction: Transaction): boolean {
  return transaction.status === 'pending_note';
}
