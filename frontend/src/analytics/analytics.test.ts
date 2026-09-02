import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { currentMonth, isWithin, startOfMonth } from './period';
import {
  allBudgetStatuses,
  budgetStatus,
  isSpend,
  overallBudget,
  spendByCategory,
  totalSpend,
} from './budget';
import {
  detectRecurring,
  merchantLeaderboard,
  searchTransactions,
} from './insights';
import type { Transaction, TransactionCategory } from '../types/transaction';

/** 10 September 2026, local — 10 days elapsed, 21 remaining of 30. */
const NOW = new Date(2026, 8, 10, 12, 0, 0).getTime();

const base: Transaction = {
  id: 'a',
  amountMinor: 10000,
  title: 'Payment',
  category: 'Dining',
  paidTo: 'Swiggy',
  accountInfo: 'HDFC - 1234',
  transactionType: 'Debit',
  timestamp: new Date(2026, 8, 5, 12).toISOString(),
  source: 'SMS-parsed',
  channel: 'sms',
  refNo: null,
  accountTail: '1234',
  dedupeKey: 'k',
  rawPayload: null,
  status: 'complete',
  skippedCount: 0,
  lastPromptedAt: null,
  note: null,
  transcript: null,
  audioPath: null,
  updatedAt: '2026-09-01T12:00:00.000Z',
  deletedAt: null,
  syncedAt: null,
};

const make = (overrides: Partial<Transaction> & { id: string }): Transaction => ({
  ...base,
  ...overrides,
});

describe('period', () => {
  it('builds the current month with elapsed and remaining days', () => {
    const period = currentMonth(NOW);

    assert.equal(period.totalDays, 30); // September
    assert.equal(period.elapsedDays, 10);
    assert.equal(period.remainingDays, 21); // includes today
  });

  it('never reports zero remaining days', () => {
    // safeToSpend divides by this; on the last day the answer is "today",
    // not a division by zero.
    const lastDay = new Date(2026, 8, 30, 23, 0).getTime();
    assert.equal(currentMonth(lastDay).remainingDays, 1);
  });

  it('uses local month boundaries', () => {
    const period = currentMonth(NOW);
    assert.equal(period.startMs, startOfMonth(NOW));
    assert.equal(new Date(period.startMs).getDate(), 1);
  });

  it('excludes transactions from other months', () => {
    const period = currentMonth(NOW);
    assert.equal(isWithin(period, new Date(2026, 8, 15).toISOString()), true);
    assert.equal(isWithin(period, new Date(2026, 7, 31).toISOString()), false);
    assert.equal(isWithin(period, new Date(2026, 9, 1).toISOString()), false);
  });
});

describe('what counts as spending', () => {
  it('excludes credits', () => {
    assert.equal(isSpend(make({ id: 'a', transactionType: 'Credit' })), false);
  });

  it('excludes transactions the user ignored', () => {
    // Usually transfers to self — counting them inflates every total for
    // money that never left the user's control.
    assert.equal(isSpend(make({ id: 'a', status: 'ignored' })), false);
  });

  it('includes an ordinary debit still awaiting a note', () => {
    assert.equal(isSpend(make({ id: 'a', status: 'pending_note' })), true);
  });
});

describe('spend totals', () => {
  const period = currentMonth(NOW);
  const transactions = [
    make({ id: 'a', amountMinor: 50000, category: 'Dining' }),
    make({ id: 'b', amountMinor: 30000, category: 'Grocery' }),
    make({ id: 'c', amountMinor: 20000, category: 'Dining' }),
    make({ id: 'd', amountMinor: 99999, transactionType: 'Credit' }),
    make({ id: 'e', amountMinor: 88888, status: 'ignored' }),
    make({ id: 'f', amountMinor: 77777, timestamp: new Date(2026, 7, 5).toISOString() }),
  ];

  it('sums only in-period spend', () => {
    assert.equal(totalSpend(transactions, period), 100000);
  });

  it('groups by category', () => {
    assert.deepEqual(spendByCategory(transactions, period), {
      Dining: 70000,
      Grocery: 30000,
    });
  });
});

describe('budget status — the actionable numbers', () => {
  const period = currentMonth(NOW); // 10 of 30 days elapsed → 33% through

  it('flags overpacing before the budget is actually blown', () => {
    // ₹900 of a ₹1000 budget on the 10th. Not over budget, but the whole
    // point is to say so now rather than on the 30th.
    const status = budgetStatus('Dining', 100000, 90000, period);

    assert.equal(status.isOverBudget, false);
    assert.equal(status.isOverpacing, true);
  });

  it('does not flag steady spending', () => {
    // A third of the budget, a third of the way through the month.
    const status = budgetStatus('Dining', 100000, 33000, period);
    assert.equal(status.isOverpacing, false);
  });

  it('divides what is left across the days that remain', () => {
    // ₹700 left over 21 days = ₹33.33/day, floored to 3333 paise.
    const status = budgetStatus('Dining', 100000, 30000, period);
    assert.equal(status.safeToSpendTodayMinor, Math.floor(70000 / 21));
  });

  it('never suggests spending more than remains', () => {
    // Flooring matters: telling someone they can spend ₹1 more than they can
    // is the one rounding direction that actually costs them.
    const status = budgetStatus('Dining', 100000, 30000, period);
    assert.ok(status.safeToSpendTodayMinor * period.remainingDays <= 70000);
  });

  it('reports zero safe-to-spend when over budget', () => {
    const status = budgetStatus('Dining', 100000, 150000, period);

    assert.equal(status.isOverBudget, true);
    assert.equal(status.safeToSpendTodayMinor, 0);
    assert.equal(status.remainingMinor, -50000);
  });

  it('orders categories by how close to the limit they are', () => {
    const transactions = [
      make({ id: 'a', amountMinor: 90000, category: 'Dining' }),
      make({ id: 'b', amountMinor: 10000, category: 'Transport' }),
    ];
    const budgets: Partial<Record<TransactionCategory, number>> = {
      Dining: 100000,
      Transport: 100000,
    };

    const statuses = allBudgetStatuses(transactions, budgets, period);
    assert.deepEqual(statuses.map((s) => s.category), ['Dining', 'Transport']);
  });
});

describe('overall budget', () => {
  const period = currentMonth(NOW);

  it('counts only spend in budgeted categories', () => {
    // An unbudgeted category must not silently eat another's headroom.
    const transactions = [
      make({ id: 'a', amountMinor: 20000, category: 'Dining' }),
      make({ id: 'b', amountMinor: 500000, category: 'Rent' }),
    ];

    const overall = overallBudget(transactions, { Dining: 100000 }, period);

    assert.equal(overall.budgetMinor, 100000);
    assert.equal(overall.spentMinor, 20000);
    assert.equal(overall.safeToSpendTodayMinor, Math.floor(80000 / 21));
  });

  it('handles no budgets set without dividing by zero', () => {
    const overall = overallBudget([], {}, period);

    assert.equal(overall.budgetMinor, 0);
    assert.equal(overall.spentFraction, 0);
    assert.equal(overall.safeToSpendTodayMinor, 0);
  });
});

describe('merchant leaderboard', () => {
  it('groups the channel spellings of one merchant into a single row', () => {
    const period = currentMonth(NOW);
    const transactions = [
      make({ id: 'a', amountMinor: 30000, paidTo: 'swiggy@ybl' }),
      make({ id: 'b', amountMinor: 20000, paidTo: 'SWIGGY LIMITED' }),
      make({ id: 'c', amountMinor: 60000, paidTo: 'Uber India' }),
    ];

    const board = merchantLeaderboard(transactions, period);

    assert.equal(board.length, 2);
    assert.equal(board[0].displayName, 'Uber India');
    assert.equal(board[0].totalMinor, 60000);
    assert.equal(board[1].totalMinor, 50000);
    assert.equal(board[1].count, 2);
  });
});

describe('recurring detection', () => {
  const monthly = (id: string, month: number): Transaction =>
    make({
      id,
      amountMinor: 19900,
      paidTo: 'Netflix',
      category: 'Bills',
      timestamp: new Date(2026, month, 5, 12).toISOString(),
    });

  it('detects a monthly subscription', () => {
    const found = detectRecurring([monthly('a', 5), monthly('b', 6), monthly('c', 7)], new Date(2026, 8, 1).getTime());

    assert.equal(found.length, 1);
    assert.equal(found[0].displayName, 'Netflix');
    assert.equal(found[0].amountMinor, 19900);
    assert.ok(Math.abs(found[0].intervalDays - 30) <= 2);
  });

  it('needs three occurrences, not two', () => {
    // Two identical payments to one merchant is a coincidence often enough;
    // a false "you have a subscription" is worse than missing a real one.
    const found = detectRecurring([monthly('a', 6), monthly('b', 7)], NOW);
    assert.deepEqual(found, []);
  });

  it('ignores irregular repeat custom that happens to average out', () => {
    const irregular = [
      make({ id: 'a', amountMinor: 19900, paidTo: 'Chai Point', timestamp: new Date(2026, 5, 1).toISOString() }),
      make({ id: 'b', amountMinor: 19900, paidTo: 'Chai Point', timestamp: new Date(2026, 5, 3).toISOString() }),
      make({ id: 'c', amountMinor: 19900, paidTo: 'Chai Point', timestamp: new Date(2026, 7, 28).toISOString() }),
    ];

    assert.deepEqual(detectRecurring(irregular, NOW), []);
  });

  it('drops a subscription that stopped charging', () => {
    const stale = [monthly('a', 0), monthly('b', 1), monthly('c', 2)];
    // Six months after the last charge — cancelled, not live.
    assert.deepEqual(detectRecurring(stale, new Date(2026, 8, 1).getTime()), []);
  });

  it('separates different amounts to the same merchant', () => {
    const mixed = [
      ...[5, 6, 7].map((m) => monthly(`sub-${m}`, m)),
      make({ id: 'oneoff', amountMinor: 80000, paidTo: 'Netflix', timestamp: new Date(2026, 7, 20).toISOString() }),
    ];

    const found = detectRecurring(mixed, new Date(2026, 8, 1).getTime());
    assert.equal(found.length, 1);
    assert.equal(found[0].amountMinor, 19900);
  });
});

describe('transcript search — what the voice notes unlock', () => {
  const transactions = [
    make({ id: 'a', paidTo: 'Kamath Idli Hotel', note: 'client meeting with the Acme team' }),
    make({ id: 'b', paidTo: 'Swiggy', note: 'dinner at home' }),
    make({ id: 'c', paidTo: 'Uber', transcript: 'auto to the client meeting' }),
  ];

  it('finds payments by what the user said, not what the bank said', () => {
    // "client meeting" appears in no bank message anywhere.
    const results = searchTransactions(transactions, 'client meeting');
    assert.deepEqual(results.map((t) => t.id).sort(), ['a', 'c']);
  });

  it('searches the raw transcript as well as the edited note', () => {
    assert.deepEqual(searchTransactions(transactions, 'auto').map((t) => t.id), ['c']);
  });

  it('narrows as more terms are added', () => {
    assert.equal(searchTransactions(transactions, 'meeting').length, 2);
    assert.equal(searchTransactions(transactions, 'meeting acme').length, 1);
  });

  it('still matches merchant and category', () => {
    assert.deepEqual(searchTransactions(transactions, 'swiggy').map((t) => t.id), ['b']);
  });

  it('returns nothing for an empty query', () => {
    assert.deepEqual(searchTransactions(transactions, '   '), []);
  });
});
