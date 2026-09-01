import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseIngestionEvent } from './parseEvent';
import { ingestEvent } from './ingest';
import { findDuplicate } from './dedupe';
import { parseAmountToPaise, formatINR } from '../utils/money';
import {
  selectPendingQueue,
  selectQueueHead,
  selectCaptureTarget,
  selectItemsToRetire,
} from '../store/queue';
import type { Transaction } from '../types/transaction';
import {
  DUPLICATE_PAIR,
  FIXED_NOW,
  PARSE_CASES,
  REJECT_CASES,
} from './__fixtures__/events';

describe('money', () => {
  it('parses amounts without floating point drift', () => {
    // parseFloat("1234.55") * 100 === 123454.99999999999
    assert.equal(parseAmountToPaise('1,234.55'), 123455);
    assert.equal(parseAmountToPaise('240'), 24000);
    assert.equal(parseAmountToPaise('240.5'), 24050); // .5 is 50 paise, not 5
    assert.equal(parseAmountToPaise('₹1,00,000.99'), 10000099);
  });

  it('rejects non-amounts', () => {
    assert.equal(parseAmountToPaise('abc'), null);
    assert.equal(parseAmountToPaise('0'), null);
    assert.equal(parseAmountToPaise(''), null);
  });

  it('formats paise for display', () => {
    assert.equal(formatINR(24000), '₹240');
    assert.equal(formatINR(24050), '₹240.50');
    assert.equal(formatINR(10000099), '₹1,00,000.99');
  });
});

describe('parsing real message shapes', () => {
  for (const testCase of PARSE_CASES) {
    it(testCase.name, () => {
      const result = parseIngestionEvent(testCase.event);
      assert.equal(result.ok, true, `expected a parse, got rejection`);
      if (!result.ok) return;

      assert.equal(result.event.amountMinor, testCase.expect.amountMinor);
      assert.equal(result.event.transactionType, testCase.expect.transactionType);

      if (testCase.expect.paidTo !== undefined) {
        assert.equal(result.event.paidTo, testCase.expect.paidTo);
      }
      if (testCase.expect.accountTail !== undefined) {
        assert.equal(result.event.accountTail, testCase.expect.accountTail);
      }
      if (testCase.expect.refNo !== undefined) {
        assert.equal(result.event.refNo, testCase.expect.refNo);
      }
      if (testCase.expect.category !== undefined) {
        assert.equal(result.event.category, testCase.expect.category);
      }
    });
  }
});

describe('rejecting non-transactions', () => {
  for (const testCase of REJECT_CASES) {
    it(testCase.name, () => {
      const result = parseIngestionEvent(testCase.event);
      assert.equal(result.ok, false, 'expected rejection, got a transaction');
      if (result.ok) return;
      assert.equal(result.reason, testCase.reason);
    });
  }
});

describe('dedupe across both channels', () => {
  const ids = (() => {
    let n = 0;
    return () => `txn_${++n}`;
  })();

  it('collapses the same payment seen on notification and SMS', () => {
    const first = ingestEvent(DUPLICATE_PAIR.notification, [], ids);
    assert.equal(first.kind, 'created');
    if (first.kind !== 'created') return;

    const second = ingestEvent(DUPLICATE_PAIR.sms, [first.transaction], ids);
    assert.equal(
      second.kind,
      'duplicate',
      'a single payment produced two transactions',
    );
  });

  it('keeps the UPI app merchant name and adopts the bank reference', () => {
    const first = ingestEvent(DUPLICATE_PAIR.notification, [], ids);
    if (first.kind !== 'created') throw new Error('setup failed');

    // The notification has the clean name but no ref; the SMS has the ref.
    assert.equal(first.transaction.paidTo, 'Swiggy');
    assert.equal(first.transaction.refNo, null);

    const second = ingestEvent(DUPLICATE_PAIR.sms, [first.transaction], ids);
    if (second.kind !== 'duplicate') throw new Error('expected duplicate');

    assert.equal(second.merged.paidTo, 'Swiggy', 'lost the clean merchant name');
    assert.equal(second.merged.refNo, '412345678901', 'did not adopt the ref');
  });

  it('does not merge two genuinely different payments of the same amount', () => {
    const first = ingestEvent(DUPLICATE_PAIR.sms, [], ids);
    if (first.kind !== 'created') throw new Error('setup failed');

    // Same amount, same account, but four hours later.
    const later = {
      ...DUPLICATE_PAIR.sms,
      body: DUPLICATE_PAIR.sms.body.replace('412345678901', '999999999999'),
      receivedAt: FIXED_NOW + 4 * 60 * 60 * 1000,
    };

    const second = ingestEvent(later, [first.transaction], ids);
    assert.equal(second.kind, 'created', 'wrongly merged two separate payments');
  });

  it('treats a matching reference number as authoritative regardless of time', () => {
    const first = ingestEvent(DUPLICATE_PAIR.sms, [], ids);
    if (first.kind !== 'created') throw new Error('setup failed');

    const muchLater = { ...DUPLICATE_PAIR.sms, receivedAt: FIXED_NOW + 86_400_000 };
    const duplicate = findDuplicate(
      {
        amountMinor: 24000,
        transactionType: 'Debit',
        paidTo: 'SWIGGY',
        accountInfo: 'HDFC - 1234',
        accountTail: '1234',
        refNo: '412345678901',
        timestamp: new Date(muchLater.receivedAt).toISOString(),
        category: 'Dining',
        title: 'Payment to SWIGGY',
        channel: 'sms',
        source: 'SMS-parsed',
        rawPayload: null,
      },
      [first.transaction],
    );

    assert.notEqual(duplicate, null, 'ignored a matching reference number');
  });
});

describe('pending-note queue', () => {
  const base: Omit<Transaction, 'id' | 'timestamp' | 'skippedCount' | 'status'> = {
    amountMinor: 24000,
    title: 'Payment',
    category: 'Others',
    paidTo: 'Someone',
    accountInfo: 'HDFC - 1234',
    transactionType: 'Debit',
    source: 'SMS-parsed',
    channel: 'sms',
    refNo: null,
    accountTail: '1234',
    dedupeKey: 'k',
    rawPayload: null,
    lastPromptedAt: null,
    note: null,
    transcript: null,
    audioPath: null,
  };

  const make = (
    id: string,
    minutesAgo: number,
    skippedCount = 0,
    status: Transaction['status'] = 'pending_note',
  ): Transaction => ({
    ...base,
    id,
    skippedCount,
    status,
    timestamp: new Date(FIXED_NOW - minutesAgo * 60_000).toISOString(),
  });

  it('orders oldest first', () => {
    const queue = selectPendingQueue([make('new', 1), make('old', 60), make('mid', 30)]);
    assert.deepEqual(
      queue.map((t) => t.id),
      ['old', 'mid', 'new'],
    );
  });

  it('sinks skipped items behind unskipped ones', () => {
    const queue = selectPendingQueue([make('skipped', 120, 1), make('fresh', 5, 0)]);
    assert.equal(queue[0].id, 'fresh', 'a skipped item blocked the queue');
  });

  it('excludes completed and ignored transactions', () => {
    const queue = selectPendingQueue([
      make('pending', 10),
      make('done', 10, 0, 'complete'),
      make('ignored', 10, 0, 'ignored'),
    ]);
    assert.deepEqual(queue.map((t) => t.id), ['pending']);
  });

  it('notification taps jump to the fresh payment, widget taps take the head', () => {
    const transactions = [make('old', 120), make('justPaid', 1)];

    assert.equal(selectQueueHead(transactions)?.id, 'old');
    assert.equal(
      selectCaptureTarget(transactions, 'justPaid')?.id,
      'justPaid',
      'notification tap should open the payment it came from',
    );
    assert.equal(selectCaptureTarget(transactions)?.id, 'old');
  });

  it('retires items skipped too often or aged out', () => {
    const stale = selectItemsToRetire(
      [make('skippedOut', 10, 3), make('tooOld', 60 * 24 * 8), make('fine', 10, 1)],
      FIXED_NOW,
    );

    assert.deepEqual(stale.map((t) => t.id).sort(), ['skippedOut', 'tooOld']);
  });
});
