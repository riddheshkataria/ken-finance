/**
 * Supabase transport.
 *
 * Deliberately thin — every decision about what to push, pull, or keep in a
 * conflict lives in merge.ts, which is testable without a server. This file
 * only moves rows and maps column names.
 *
 * Everything degrades to a no-op when Supabase is not configured, so the app
 * is fully usable offline and without an account. Sync is an enhancement.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Transaction } from '../types/transaction';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

let client: SupabaseClient | null = null;

export function isSyncConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

export function getSupabase(): SupabaseClient | null {
  if (!isSyncConfigured()) return null;

  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // The session must outlive the process, or the user re-authenticates
        // on every cold start.
        storage: AsyncStorage,
        persistSession: true,
        autoRefreshToken: true,
        // No URL session detection: there is no browser redirect in a native
        // app, and leaving it on causes spurious parsing on startup.
        detectSessionInUrl: false,
      },
    });
  }

  return client;
}

/** Server row shape. snake_case, and `timestamp` is `occurred_at`. */
interface RemoteRow {
  id: string;
  user_id: string;
  amount_minor: number;
  title: string;
  category: string;
  paid_to: string;
  account_info: string;
  transaction_type: string;
  occurred_at: string;
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
  updated_at: string;
  deleted_at: string | null;
}

function toRemote(transaction: Transaction, userId: string): RemoteRow {
  return {
    id: transaction.id,
    user_id: userId,
    amount_minor: transaction.amountMinor,
    title: transaction.title,
    category: transaction.category,
    paid_to: transaction.paidTo,
    account_info: transaction.accountInfo,
    transaction_type: transaction.transactionType,
    occurred_at: transaction.timestamp,
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
    updated_at: transaction.updatedAt,
    deleted_at: transaction.deletedAt,
  };
}

function fromRemote(row: RemoteRow): Transaction {
  return {
    id: row.id,
    // Trunc for the same reason as the local mapping: a float that reached
    // the column by any other path must not poison totals here.
    amountMinor: Math.trunc(row.amount_minor),
    title: row.title,
    category: row.category as Transaction['category'],
    paidTo: row.paid_to,
    accountInfo: row.account_info,
    transactionType: row.transaction_type as Transaction['transactionType'],
    timestamp: row.occurred_at,
    source: row.source as Transaction['source'],
    channel: row.channel as Transaction['channel'],
    refNo: row.ref_no,
    accountTail: row.account_tail,
    dedupeKey: row.dedupe_key,
    rawPayload: row.raw_payload,
    status: row.status as Transaction['status'],
    skippedCount: row.skipped_count,
    lastPromptedAt: row.last_prompted_at,
    note: row.note,
    transcript: row.transcript,
    audioPath: row.audio_path,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    // Filled in by the merge layer; the server does not track per-device sync.
    syncedAt: null,
  };
}

export async function getUserId(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Pulls rows changed since `since`.
 *
 * Tombstones are included deliberately — a delete only reaches other devices
 * as a row with `deleted_at` set.
 */
export async function pullTransactions(
  since: string | null,
): Promise<Transaction[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  try {
    let query = supabase.from('transactions').select('*');
    if (since) query = query.gt('updated_at', since);

    const { data, error } = await query;
    if (error || !data) return [];

    return (data as RemoteRow[]).map(fromRemote);
  } catch {
    return [];
  }
}

/**
 * Pushes rows, returning the ids the server accepted.
 *
 * Only accepted ids are returned so the caller marks exactly those clean —
 * assuming success on a partial failure would silently drop the rest.
 */
export async function pushTransactions(
  transactions: readonly Transaction[],
): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase || transactions.length === 0) return [];

  const userId = await getUserId();
  if (!userId) return [];

  try {
    const { data, error } = await supabase
      .from('transactions')
      .upsert(
        transactions.map((transaction) => toRemote(transaction, userId)),
        { onConflict: 'id' },
      )
      .select('id');

    if (error || !data) return [];

    return (data as { id: string }[]).map((row) => row.id);
  } catch {
    return [];
  }
}

// --- Auth ------------------------------------------------------------------

/** Sends a one-time code to a phone number in E.164 form (+919876543210). */
export async function sendOtp(phone: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const { error } = await supabase.auth.signInWithOtp({ phone });
  return !error;
}

export async function verifyOtp(phone: string, token: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const { error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });
  return !error;
}

export async function signOut(): Promise<void> {
  await getSupabase()?.auth.signOut();
}
