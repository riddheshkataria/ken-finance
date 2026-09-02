import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIGRATIONS,
  TRANSACTION_COLUMNS,
  UPSERT_TRANSACTION_SQL,
  fromRow,
  toBindParams,
  toRow,
} from './schema';
import { selectPendingQueue } from './queue';
import type { Transaction } from '../types/transaction';

const sample: Transaction = {
  id: 'txn_1',
  amountMinor: 24050,
  title: 'Payment to Swiggy',
  category: 'Dining',
  paidTo: 'Swiggy',
  accountInfo: 'HDFC - 1234',
  transactionType: 'Debit',
  timestamp: '2026-09-01T12:00:00.000Z',
  source: 'SMS-parsed',
  channel: 'sms',
  refNo: '412345678901',
  accountTail: '1234',
  dedupeKey: 'ref:412345678901',
  rawPayload: 'Sent Rs.240.50 From HDFC Bank A/C x1234 To SWIGGY',
  status: 'pending_note',
  skippedCount: 2,
  lastPromptedAt: '2026-09-01T12:05:00.000Z',
  note: null,
  transcript: null,
  audioPath: null,
  updatedAt: '2026-09-01T12:00:00.000Z',
  deletedAt: null,
  syncedAt: null,
};

describe('row mapping', () => {
  it('round-trips every field unchanged', () => {
    const restored = fromRow(toRow(sample));
    assert.deepEqual(restored, sample);
  });

  it('preserves nulls as nulls rather than strings', () => {
    const restored = fromRow(toRow(sample));
    assert.equal(restored.note, null);
    assert.equal(restored.transcript, null);
    assert.equal(restored.audioPath, null);
  });

  it('round-trips a fully populated record', () => {
    const complete: Transaction = {
      ...sample,
      status: 'complete',
      note: 'Team lunch, reimbursable',
      transcript: 'team lunch reimbursable',
      audioPath: '/data/user/0/app/files/note_1.m4a',
      updatedAt: '2026-09-01T12:00:00.000Z',
      deletedAt: null,
      syncedAt: null,
      source: 'Merged',
      channel: 'notification',
    };
    assert.deepEqual(fromRow(toRow(complete)), complete);
  });

  it('keeps money an integer through the round trip', () => {
    const restored = fromRow(toRow(sample));
    assert.equal(restored.amountMinor, 24050);
    assert.equal(Number.isInteger(restored.amountMinor), true);
  });

  it('truncates a float that reached the column by some other path', () => {
    // SQLite is dynamically typed, so an INTEGER column will happily hold a
    // float. Reading it back as one would silently poison every total.
    const poisoned = { ...toRow(sample), amount_minor: 24050.9999 };
    assert.equal(fromRow(poisoned).amountMinor, 24050);
  });

  it('binds parameters in the same order as the column list', () => {
    const params = toBindParams(sample);
    assert.equal(params.length, TRANSACTION_COLUMNS.length);

    // Spot-check the positions most likely to be silently transposed.
    assert.equal(params[TRANSACTION_COLUMNS.indexOf('id')], 'txn_1');
    assert.equal(params[TRANSACTION_COLUMNS.indexOf('amount_minor')], 24050);
    assert.equal(
      params[TRANSACTION_COLUMNS.indexOf('dedupe_key')],
      'ref:412345678901',
    );
    assert.equal(params[TRANSACTION_COLUMNS.indexOf('skipped_count')], 2);
  });

  it('binds undefined as null', () => {
    // A field the parser omitted must become SQL NULL, not the string
    // "undefined", which would then read back as a truthy value.
    const partial = { ...sample, refNo: undefined as unknown as null };
    const params = toBindParams(partial);
    assert.equal(params[TRANSACTION_COLUMNS.indexOf('ref_no')], null);
  });
});

describe('schema', () => {
  it('declares amount as INTEGER, never REAL', () => {
    const ddl = MIGRATIONS.join('\n');
    assert.match(ddl, /amount_minor\s+INTEGER\s+NOT NULL/);
    assert.doesNotMatch(ddl, /amount_minor\s+REAL/);
  });

  it('enforces dedupe at the database level, not just in app logic', () => {
    assert.match(MIGRATIONS.join('\n'), /dedupe_key\s+TEXT\s+NOT NULL UNIQUE/);
  });

  it('indexes the columns the queue and history actually filter on', () => {
    const ddl = MIGRATIONS.join('\n');
    assert.match(ddl, /idx_transactions_status/);
    assert.match(ddl, /idx_transactions_timestamp/);
  });

  it('upserts so re-ingesting a merged payment updates rather than fails', () => {
    assert.match(UPSERT_TRANSACTION_SQL, /ON CONFLICT\(id\) DO UPDATE SET/);
    // id must not be in the SET clause — it is the conflict target.
    assert.doesNotMatch(UPSERT_TRANSACTION_SQL, /\n\s+id = excluded\.id/);
  });
});

describe('queue survives a reload', () => {
  it('rebuilds the same order from restored rows', () => {
    const transactions: Transaction[] = [
      { ...sample, id: 'a', timestamp: '2026-09-01T10:00:00.000Z', skippedCount: 0 },
      { ...sample, id: 'b', timestamp: '2026-09-01T09:00:00.000Z', skippedCount: 0 },
      { ...sample, id: 'c', timestamp: '2026-09-01T08:00:00.000Z', skippedCount: 5 },
    ];

    const before = selectPendingQueue(transactions).map((t) => t.id);
    const after = selectPendingQueue(
      transactions.map((t) => fromRow(toRow(t))),
    ).map((t) => t.id);

    assert.deepEqual(after, before);
    assert.deepEqual(after, ['b', 'a', 'c']);
  });
});
