/**
 * SQLite schema and row mapping.
 *
 * Kept free of expo-sqlite so every mapping rule is testable in plain Node —
 * the round trip is where persistence bugs actually live (a paise value
 * silently becoming a float, a null becoming the string "null"), and those
 * are exactly the bugs that are unrecoverable once real data exists.
 *
 * database.ts owns the connection; this file owns what the data looks like.
 */
import type {
  IngestionChannel,
  Transaction,
  TransactionCategory,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../types/transaction';

/** Bumped whenever MIGRATIONS gains an entry. */
export const SCHEMA_VERSION = 1;

/**
 * Ordered migrations, applied by PRAGMA user_version.
 *
 * Never edit a migration that has shipped — add a new one. An edited
 * migration silently leaves already-installed devices on a different schema
 * from new ones, and nothing surfaces the difference until a query fails.
 */
export const MIGRATIONS: readonly string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS transactions (
    id             TEXT    PRIMARY KEY NOT NULL,
    -- Integer paise. INTEGER, never REAL: SQLite would happily store a float
    -- here and the corruption would be invisible until totals drifted.
    amount_minor   INTEGER NOT NULL,
    title          TEXT    NOT NULL,
    category       TEXT    NOT NULL,
    paid_to        TEXT    NOT NULL,
    account_info   TEXT    NOT NULL,
    transaction_type TEXT  NOT NULL,
    timestamp      TEXT    NOT NULL,
    source         TEXT    NOT NULL,
    channel        TEXT    NOT NULL,
    ref_no         TEXT,
    account_tail   TEXT,
    -- The database itself refuses a double-counted payment, so a bug in the
    -- app-level dedupe cannot corrupt history.
    dedupe_key     TEXT    NOT NULL UNIQUE,
    raw_payload    TEXT,
    status         TEXT    NOT NULL,
    skipped_count  INTEGER NOT NULL DEFAULT 0,
    last_prompted_at TEXT,
    note           TEXT,
    transcript     TEXT,
    audio_path     TEXT
  );
  `,
  // The queue filters on status constantly, and history sorts by time.
  `CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp DESC);`,
];

/** A row exactly as SQLite stores it. */
export interface TransactionRow {
  id: string;
  amount_minor: number;
  title: string;
  category: string;
  paid_to: string;
  account_info: string;
  transaction_type: string;
  timestamp: string;
  source: string;
  channel: string;
  ref_no: string | null;
  account_tail: string | null;
  dedupe_key: string;
  raw_payload: string | null;
  status: string;
  skipped_count: number;
  last_prompted_at: string | null;
  note: string | null;
  transcript: string | null;
  audio_path: string | null;
}

export const TRANSACTION_COLUMNS = [
  'id',
  'amount_minor',
  'title',
  'category',
  'paid_to',
  'account_info',
  'transaction_type',
  'timestamp',
  'source',
  'channel',
  'ref_no',
  'account_tail',
  'dedupe_key',
  'raw_payload',
  'status',
  'skipped_count',
  'last_prompted_at',
  'note',
  'transcript',
  'audio_path',
] as const;

/**
 * Upsert rather than insert: the same payment can be re-ingested (a merge
 * updating an existing row), and ON CONFLICT keeps that idempotent.
 */
export const UPSERT_TRANSACTION_SQL = `
INSERT INTO transactions (${TRANSACTION_COLUMNS.join(', ')})
VALUES (${TRANSACTION_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT(id) DO UPDATE SET
  ${TRANSACTION_COLUMNS.filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`)
    .join(',\n  ')};
`;

export const SELECT_ALL_SQL =
  'SELECT * FROM transactions ORDER BY timestamp DESC;';

export const DELETE_TRANSACTION_SQL = 'DELETE FROM transactions WHERE id = ?;';

export const DELETE_ALL_SQL = 'DELETE FROM transactions;';

/**
 * Converts a transaction into positional bind parameters.
 *
 * Order must match TRANSACTION_COLUMNS exactly — that coupling is why both
 * live in this file and why the round-trip test exists.
 */
export function toRow(transaction: Transaction): TransactionRow {
  return {
    id: transaction.id,
    amount_minor: transaction.amountMinor,
    title: transaction.title,
    category: transaction.category,
    paid_to: transaction.paidTo,
    account_info: transaction.accountInfo,
    transaction_type: transaction.transactionType,
    timestamp: transaction.timestamp,
    source: transaction.source,
    channel: transaction.channel,
    ref_no: transaction.refNo,
    account_tail: transaction.accountTail,
    dedupe_key: transaction.dedupeKey,
    raw_payload: transaction.rawPayload,
    status: transaction.status,
    skipped_count: transaction.skippedCount,
    last_prompted_at: transaction.lastPromptedAt,
    note: transaction.note,
    transcript: transaction.transcript,
    audio_path: transaction.audioPath,
  };
}

export function toBindParams(transaction: Transaction): unknown[] {
  const row = toRow(transaction) as unknown as Record<string, unknown>;
  return TRANSACTION_COLUMNS.map((column) => row[column] ?? null);
}

/**
 * Converts a stored row back into a Transaction.
 *
 * Amounts are re-floored on the way out. SQLite is dynamically typed: if a
 * float ever reaches amount_minor through a path that bypasses toRow, it
 * comes back as a float and silently poisons every total downstream. This is
 * the cheapest place to stop that.
 */
export function fromRow(row: TransactionRow): Transaction {
  return {
    id: row.id,
    amountMinor: Math.trunc(row.amount_minor),
    title: row.title,
    category: row.category as TransactionCategory,
    paidTo: row.paid_to,
    accountInfo: row.account_info,
    transactionType: row.transaction_type as TransactionType,
    timestamp: row.timestamp,
    source: row.source as TransactionSource,
    channel: row.channel as IngestionChannel,
    refNo: row.ref_no,
    accountTail: row.account_tail,
    dedupeKey: row.dedupe_key,
    rawPayload: row.raw_payload,
    status: row.status as TransactionStatus,
    skippedCount: row.skipped_count,
    lastPromptedAt: row.last_prompted_at,
    note: row.note,
    transcript: row.transcript,
    audioPath: row.audio_path,
  };
}
