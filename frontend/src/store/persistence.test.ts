import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { persistDiff, type PersistenceSink } from './persistence';
import type { Transaction } from '../types/transaction';

const base: Transaction = {
  id: 'a',
  amountMinor: 24000,
  title: 'Payment',
  category: 'Others',
  paidTo: 'Someone',
  accountInfo: 'HDFC - 1234',
  transactionType: 'Debit',
  timestamp: '2026-09-01T12:00:00.000Z',
  source: 'SMS-parsed',
  channel: 'sms',
  refNo: null,
  accountTail: '1234',
  dedupeKey: 'k-a',
  rawPayload: null,
  status: 'pending_note',
  skippedCount: 0,
  lastPromptedAt: null,
  note: null,
  transcript: null,
  audioPath: null,
};

const make = (id: string): Transaction => ({ ...base, id, dedupeKey: `k-${id}` });

let saved: Transaction[][];
let deleted: string[];
let sink: PersistenceSink;

beforeEach(() => {
  saved = [];
  deleted = [];
  sink = {
    saveTransactions: async (transactions) => {
      saved.push([...transactions]);
    },
    deleteTransaction: async (id) => {
      deleted.push(id);
    },
  };
});

describe('persistDiff', () => {
  it('saves a newly added transaction', async () => {
    const a = make('a');
    await persistDiff([], [a], sink);

    assert.deepEqual(saved.flat().map((t) => t.id), ['a']);
    assert.deepEqual(deleted, []);
  });

  it('writes nothing when nothing changed', async () => {
    const a = make('a');
    // Same object identities on both sides — the store's immutable updates
    // guarantee this for untouched rows.
    await persistDiff([a], [a], sink);

    assert.deepEqual(saved, []);
    assert.deepEqual(deleted, []);
  });

  it('saves only the transaction that actually changed', async () => {
    const a = make('a');
    const b = make('b');
    const updatedB: Transaction = { ...b, note: 'team lunch', status: 'complete' };

    await persistDiff([a, b], [a, updatedB], sink);

    assert.deepEqual(saved.flat().map((t) => t.id), ['b']);
  });

  it('deletes a transaction that disappeared', async () => {
    const a = make('a');
    const b = make('b');

    await persistDiff([a, b], [a], sink);

    assert.deepEqual(deleted, ['b']);
    assert.deepEqual(saved, []);
  });

  it('handles a replacement in place, as reconciliation produces', async () => {
    // Merging a voice note into a bank record swaps one row for another with
    // the same id; that must be a save, not a delete plus insert.
    const voice = make('a');
    const merged: Transaction = { ...voice, source: 'Merged', status: 'complete' };

    await persistDiff([voice], [merged], sink);

    assert.deepEqual(saved.flat().map((t) => t.id), ['a']);
    assert.deepEqual(deleted, []);
  });

  it('handles simultaneous add and remove', async () => {
    await persistDiff([make('a')], [make('b')], sink);

    assert.deepEqual(saved.flat().map((t) => t.id), ['b']);
    assert.deepEqual(deleted, ['a']);
  });

  it('batches multiple changes into one save call', async () => {
    const a = make('a');
    const b = make('b');

    await persistDiff([], [a, b], sink);

    // One round trip, not one per row — bulk operations like reconcileAll
    // would otherwise issue a write per transaction.
    assert.equal(saved.length, 1);
    assert.equal(saved[0].length, 2);
  });
});
