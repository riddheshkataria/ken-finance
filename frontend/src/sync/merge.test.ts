import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  markSynced,
  mergeAll,
  mergeOne,
  selectDirty,
  selectPurgeableTombstones,
  nextWatermark,
  pendingPushCount,
} from './merge';
import type { Transaction } from '../types/transaction';

const T1 = '2026-09-01T10:00:00.000Z';
const T2 = '2026-09-01T11:00:00.000Z';
const T3 = '2026-09-01T12:00:00.000Z';

const base: Transaction = {
  id: 'a',
  amountMinor: 24000,
  title: 'Payment',
  category: 'Others',
  paidTo: 'Swiggy',
  accountInfo: 'HDFC - 1234',
  transactionType: 'Debit',
  timestamp: T1,
  source: 'SMS-parsed',
  channel: 'sms',
  refNo: '412345678901',
  accountTail: '1234',
  dedupeKey: 'ref:412345678901',
  rawPayload: null,
  status: 'pending_note',
  skippedCount: 0,
  lastPromptedAt: null,
  note: null,
  transcript: null,
  audioPath: null,
  updatedAt: T1,
  deletedAt: null,
  syncedAt: null,
};

const make = (overrides: Partial<Transaction>): Transaction => ({
  ...base,
  ...overrides,
});

describe('selectDirty', () => {
  it('selects a row that has never synced', () => {
    assert.equal(selectDirty([make({ syncedAt: null })]).length, 1);
  });

  it('selects a row edited since its last sync', () => {
    assert.equal(selectDirty([make({ updatedAt: T2, syncedAt: T1 })]).length, 1);
  });

  it('skips a row that is up to date', () => {
    assert.deepEqual(selectDirty([make({ updatedAt: T1, syncedAt: T1 })]), []);
  });

  it('includes tombstones', () => {
    // Excluding a delete is exactly how a deleted row comes back from the
    // dead on another device.
    const deleted = make({ deletedAt: T2, updatedAt: T2, syncedAt: T1 });
    assert.equal(selectDirty([deleted]).length, 1);
  });
});

describe('mergeOne', () => {
  it('keeps a row the server has never seen', () => {
    const result = mergeOne(make({}), undefined);
    assert.equal(result?.reason, 'local-only');
    assert.equal(result?.resolved.syncedAt, null, 'must stay dirty to be pushed');
  });

  it('accepts a row only the server has, already reconciled', () => {
    const result = mergeOne(undefined, make({ updatedAt: T2 }));

    assert.equal(result?.reason, 'remote-only');
    // Arrives clean; pushing it straight back would be pointless traffic.
    assert.equal(result?.resolved.syncedAt, T2);
  });

  it('local wins when it is newer, and stays dirty', () => {
    const local = make({ updatedAt: T3, note: 'team lunch', syncedAt: T1 });
    const remote = make({ updatedAt: T2, note: 'stale' });

    const result = mergeOne(local, remote);

    assert.equal(result?.reason, 'local-newer');
    assert.equal(result?.resolved.note, 'team lunch');
    assert.equal(result?.resolved.syncedAt, T1, 'must still be pushed');
  });

  it('remote wins when it is newer, and lands clean', () => {
    const local = make({ updatedAt: T1, note: 'stale', syncedAt: T1 });
    const remote = make({ updatedAt: T3, note: 'from the other phone' });

    const result = mergeOne(local, remote);

    assert.equal(result?.reason, 'remote-newer');
    assert.equal(result?.resolved.note, 'from the other phone');
    assert.equal(result?.resolved.syncedAt, T3);
  });

  it('breaks an exact tie toward remote, consistently', () => {
    // Two devices ping-ponging an identical row forever is the failure this
    // prevents.
    const result = mergeOne(make({ updatedAt: T2 }), make({ updatedAt: T2 }));

    assert.equal(result?.reason, 'identical');
    assert.equal(result?.resolved.syncedAt, T2);
  });

  it('propagates a remote delete over an older local row', () => {
    const local = make({ updatedAt: T1, syncedAt: T1 });
    const remote = make({ updatedAt: T3, deletedAt: T3 });

    const result = mergeOne(local, remote);

    assert.equal(result?.resolved.deletedAt, T3);
  });

  it('a local edit newer than a remote delete resurrects the row', () => {
    // Last-write-wins, applied honestly: the user edited it after the delete,
    // so the edit is the more recent intent.
    const local = make({ updatedAt: T3, note: 'actually keep this' });
    const remote = make({ updatedAt: T2, deletedAt: T2 });

    const result = mergeOne(local, remote);

    assert.equal(result?.reason, 'local-newer');
    assert.equal(result?.resolved.deletedAt, null);
  });
});

describe('mergeAll', () => {
  it('unions both sides without dropping or duplicating rows', () => {
    const local = [make({ id: 'a' }), make({ id: 'b' })];
    const remote = [make({ id: 'b', updatedAt: T3 }), make({ id: 'c', updatedAt: T2 })];

    const result = mergeAll(local, remote);

    assert.deepEqual(result.transactions.map((t) => t.id).sort(), ['a', 'b', 'c']);
  });

  it('reports what was pulled and what still needs pushing', () => {
    const local = [
      make({ id: 'a', updatedAt: T1, syncedAt: null }), // dirty, local only
      make({ id: 'b', updatedAt: T1, syncedAt: T1 }), // clean
    ];
    const remote = [
      make({ id: 'b', updatedAt: T3 }), // remote newer
      make({ id: 'c', updatedAt: T2 }), // new from server
    ];

    const result = mergeAll(local, remote);

    assert.equal(result.pulled, 2);
    assert.deepEqual(result.toPush.map((t) => t.id), ['a']);
  });

  it('counts a genuine conflict — both sides changed since last sync', () => {
    const local = [make({ id: 'a', updatedAt: T3, syncedAt: T1 })];
    const remote = [make({ id: 'a', updatedAt: T2 })];

    assert.equal(mergeAll(local, remote).conflicts, 1);
  });

  it('does not count a clean local row overwritten by remote as a conflict', () => {
    const local = [make({ id: 'a', updatedAt: T1, syncedAt: T1 })];
    const remote = [make({ id: 'a', updatedAt: T3 })];

    assert.equal(mergeAll(local, remote).conflicts, 0);
  });
});

describe('markSynced', () => {
  it('marks a pushed row clean', () => {
    const rows = [make({ id: 'a', updatedAt: T2, syncedAt: null })];
    const result = markSynced(rows, new Set(['a']), new Map([['a', T2]]));

    assert.equal(result[0].syncedAt, T2);
  });

  it('leaves a row dirty if it changed while the push was in flight', () => {
    // The user edited during the round trip. Marking it clean here would
    // silently drop that edit forever.
    const rows = [make({ id: 'a', updatedAt: T3, syncedAt: null })];
    const result = markSynced(rows, new Set(['a']), new Map([['a', T2]]));

    assert.equal(result[0].syncedAt, null);
  });

  it('does not touch rows that were not pushed', () => {
    const rows = [make({ id: 'a' }), make({ id: 'b' })];
    const result = markSynced(rows, new Set(['a']), new Map([['a', T1]]));

    assert.equal(result[1].syncedAt, null);
  });
});

describe('tombstone purging', () => {
  const NOW = Date.parse('2026-12-01T00:00:00.000Z');

  it('purges an old, fully synced tombstone', () => {
    const old = make({ deletedAt: T1, updatedAt: T1, syncedAt: T1 });
    assert.equal(selectPurgeableTombstones([old], NOW).length, 1);
  });

  it('keeps a tombstone the server has not acknowledged', () => {
    // Dropping it loses the delete, and the row returns on the next pull.
    const unsynced = make({ deletedAt: T1, updatedAt: T1, syncedAt: null });
    assert.deepEqual(selectPurgeableTombstones([unsynced], NOW), []);
  });

  it('keeps a recent tombstone', () => {
    const recent = make({
      deletedAt: '2026-11-28T00:00:00.000Z',
      updatedAt: '2026-11-28T00:00:00.000Z',
      syncedAt: '2026-11-28T00:00:00.000Z',
    });
    assert.deepEqual(selectPurgeableTombstones([recent], NOW), []);
  });

  it('never purges a live row', () => {
    assert.deepEqual(
      selectPurgeableTombstones([make({ syncedAt: T1, updatedAt: T1 })], NOW),
      [],
    );
  });
});

describe('the round trip does not lose an edit', () => {
  it('survives push, remote change, and pull', () => {
    // Device A notes a payment.
    let local = [make({ id: 'a', note: 'team lunch', updatedAt: T1, syncedAt: null })];

    // It is pushed and acknowledged.
    local = markSynced(local, new Set(['a']), new Map([['a', T1]]));
    assert.deepEqual(selectDirty(local), [], 'should be clean after push');

    // Device B recategorises the same payment later.
    const remote = [make({ id: 'a', note: 'team lunch', category: 'Dining', updatedAt: T2 })];

    const merged = mergeAll(local, remote);

    assert.equal(merged.transactions[0].category, 'Dining');
    assert.equal(merged.transactions[0].note, 'team lunch', 'note was lost');
    assert.deepEqual(merged.toPush, [], 'nothing left to push');
  });
});

describe('watermark', () => {
  it('advances to the newest row seen, not the wall clock', () => {
    // A device with a fast clock would otherwise skip past rows written in
    // the gap and never see them again.
    const rows = [
      make({ id: 'a', updatedAt: T1 }),
      make({ id: 'b', updatedAt: T3 }),
      make({ id: 'c', updatedAt: T2 }),
    ];

    assert.equal(nextWatermark(rows, null), T3);
  });

  it('never moves backwards', () => {
    assert.equal(nextWatermark([make({ updatedAt: T1 })], T3), T3);
  });

  it('keeps the previous watermark when nothing was merged', () => {
    assert.equal(nextWatermark([], T2), T2);
  });
});

describe('pendingPushCount', () => {
  it('counts only dirty rows', () => {
    const rows = [
      make({ id: 'a', updatedAt: T1, syncedAt: T1 }),
      make({ id: 'b', updatedAt: T2, syncedAt: T1 }),
      make({ id: 'c', syncedAt: null }),
    ];

    assert.equal(pendingPushCount(rows), 2);
  });
});
