/**
 * SQLite persistence.
 *
 * Deliberately thin: schema.ts owns what the data looks like, this file owns
 * the connection. Everything here degrades to a no-op when SQLite is
 * unavailable (web, or a test runner), so the app still runs in memory rather
 * than failing to start.
 *
 * The store remains the single in-memory source of truth (rules.md §3). This
 * is a write-through cache behind it, not a second store.
 */
import * as SQLite from 'expo-sqlite';
import type { Transaction } from '../types/transaction';
import {
  DELETE_ALL_MERCHANTS_SQL,
  DELETE_ALL_SQL,
  DELETE_TRANSACTION_SQL,
  MIGRATIONS,
  SELECT_ALL_SQL,
  SCHEMA_VERSION,
  UPSERT_TRANSACTION_SQL,
  SELECT_MERCHANTS_SQL,
  UPSERT_MERCHANT_SQL,
  fromRow,
  merchantFromRow,
  merchantToBindParams,
  toBindParams,
  type MerchantRow,
  type TransactionRow,
} from './schema';
import type { MerchantMemory } from '../merchants/lookup';

const DATABASE_NAME = 'ken-finance.db';

let database: SQLite.SQLiteDatabase | null = null;
let openFailed = false;

/**
 * Opens the database and applies any pending migrations.
 *
 * Safe to call repeatedly. If opening fails the app continues in memory —
 * losing persistence is bad, but refusing to start is worse, and the failure
 * is surfaced through isPersistenceAvailable() rather than swallowed.
 */
export async function initDatabase(): Promise<boolean> {
  if (database) return true;
  if (openFailed) return false;

  try {
    database = await SQLite.openDatabaseAsync(DATABASE_NAME);

    // Write-ahead logging: the capture path can write while the UI reads.
    await database.execAsync('PRAGMA journal_mode = WAL;');
    await database.execAsync('PRAGMA foreign_keys = ON;');

    await runMigrations(database);
    return true;
  } catch (error) {
    openFailed = true;
    database = null;
    console.warn('[ken] SQLite unavailable, running in memory only', error);
    return false;
  }
}

/**
 * Applies migrations from the database's current user_version forward.
 * Each migration runs inside a transaction so a failure cannot leave the
 * schema half-applied.
 */
async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  const result = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;',
  );
  const currentVersion = result?.user_version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  await db.withTransactionAsync(async () => {
    for (const migration of MIGRATIONS) {
      await db.execAsync(migration);
    }
  });

  // PRAGMA cannot be parameterised, and SCHEMA_VERSION is a module constant,
  // never user input.
  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

export function isPersistenceAvailable(): boolean {
  return database !== null;
}

/** Loads every stored transaction, newest first. */
export async function loadTransactions(): Promise<Transaction[]> {
  if (!database) return [];

  try {
    const rows = await database.getAllAsync<TransactionRow>(SELECT_ALL_SQL);
    return rows.map(fromRow);
  } catch (error) {
    console.warn('[ken] Failed to load transactions', error);
    return [];
  }
}

/** Inserts or updates one transaction. */
export async function saveTransaction(transaction: Transaction): Promise<void> {
  if (!database) return;

  try {
    await database.runAsync(
      UPSERT_TRANSACTION_SQL,
      toBindParams(transaction) as SQLite.SQLiteBindValue[],
    );
  } catch (error) {
    console.warn('[ken] Failed to save transaction', transaction.id, error);
  }
}

/**
 * Persists many transactions in one transaction block.
 * Used on bulk operations like reconcileAll, where a row-at-a-time write
 * would be both slow and non-atomic.
 */
export async function saveTransactions(
  transactions: readonly Transaction[],
): Promise<void> {
  if (!database || transactions.length === 0) return;

  const db = database;
  try {
    await db.withTransactionAsync(async () => {
      for (const transaction of transactions) {
        await db.runAsync(
          UPSERT_TRANSACTION_SQL,
          toBindParams(transaction) as SQLite.SQLiteBindValue[],
        );
      }
    });
  } catch (error) {
    console.warn('[ken] Failed to save transactions', error);
  }
}

export async function deleteTransaction(id: string): Promise<void> {
  if (!database) return;

  try {
    await database.runAsync(DELETE_TRANSACTION_SQL, [id]);
  } catch (error) {
    console.warn('[ken] Failed to delete transaction', id, error);
  }
}

/** Clears all stored transactions. Used by the dev reset action. */
export async function deleteAllTransactions(): Promise<void> {
  if (!database) return;

  try {
    await database.runAsync(DELETE_ALL_SQL);
  } catch (error) {
    console.warn('[ken] Failed to clear transactions', error);
  }
}

// --- Merchant memory -----------------------------------------------------

export async function loadMerchants(): Promise<MerchantMemory[]> {
  if (!database) return [];

  try {
    const rows = await database.getAllAsync<MerchantRow>(SELECT_MERCHANTS_SQL);
    return rows.map(merchantFromRow);
  } catch (error) {
    console.warn('[ken] Failed to load merchant memory', error);
    return [];
  }
}

export async function saveMerchant(memory: MerchantMemory): Promise<void> {
  if (!database) return;

  try {
    await database.runAsync(
      UPSERT_MERCHANT_SQL,
      merchantToBindParams(memory) as SQLite.SQLiteBindValue[],
    );
  } catch (error) {
    console.warn('[ken] Failed to save merchant memory', memory.key, error);
  }
}

export async function deleteAllMerchants(): Promise<void> {
  if (!database) return;

  try {
    await database.runAsync(DELETE_ALL_MERCHANTS_SQL);
  } catch (error) {
    console.warn('[ken] Failed to clear merchant memory', error);
  }
}

/** Test/dev hook: drops the cached handle so the next init reopens. */
export function resetDatabaseHandleForTesting(): void {
  database = null;
  openFailed = false;
}
