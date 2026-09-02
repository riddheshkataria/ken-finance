/**
 * Merchant leaderboard, recurring-payment detection, and transcript search.
 *
 * Transcript search is the one thing here that no other tracker can do,
 * because no other tracker has the user's own words attached to each payment.
 * "What did I spend on client meetings?" is answerable only because the note
 * exists.
 *
 * Pure — `now` is always an argument (rules.md §4).
 */
import type { Transaction } from '../types/transaction';
import { normalizeMerchant, displayMerchant } from '../merchants/normalize';
import { isSpend } from './budget';
import { isWithin, type Period } from './period';

export interface MerchantTotal {
  key: string;
  displayName: string;
  totalMinor: number;
  count: number;
}

/**
 * Where the money actually went, biggest first.
 *
 * Grouped by normalised key so the four channel spellings of one merchant
 * appear as one row rather than four — the same reason merchant memory works.
 */
export function merchantLeaderboard(
  transactions: readonly Transaction[],
  period: Period,
  limit = 10,
): MerchantTotal[] {
  const totals = new Map<string, MerchantTotal>();

  for (const transaction of transactions) {
    if (!isSpend(transaction)) continue;
    if (!isWithin(period, transaction.timestamp)) continue;

    const key = normalizeMerchant(transaction.paidTo);
    if (!key) continue;

    const existing = totals.get(key);
    if (existing) {
      existing.totalMinor += transaction.amountMinor;
      existing.count += 1;
    } else {
      totals.set(key, {
        key,
        displayName: displayMerchant(key),
        totalMinor: transaction.amountMinor,
        count: 1,
      });
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, limit);
}

export interface RecurringPayment {
  key: string;
  displayName: string;
  amountMinor: number;
  /** Average gap between payments, in days. */
  intervalDays: number;
  occurrences: number;
  lastSeen: string;
  /** Projected next charge, ISO. */
  nextExpected: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Detects subscriptions: same merchant, near-identical amount, regular gap.
 *
 * Requires three occurrences, not two. Two payments of the same amount to the
 * same merchant is a coincidence often enough — two coffees in a fortnight
 * would otherwise be reported as a subscription, and a false "you have a
 * recurring charge" is worse than missing a real one.
 */
export function detectRecurring(
  transactions: readonly Transaction[],
  now: number,
): RecurringPayment[] {
  const groups = new Map<string, Transaction[]>();

  for (const transaction of transactions) {
    if (!isSpend(transaction)) continue;

    const merchantKey = normalizeMerchant(transaction.paidTo);
    if (!merchantKey) continue;

    // Bucket by amount as well as merchant: a ₹199 subscription and a ₹800
    // one-off to the same merchant are different things.
    const key = `${merchantKey}|${transaction.amountMinor}`;
    const group = groups.get(key);
    if (group) group.push(transaction);
    else groups.set(key, [transaction]);
  }

  const recurring: RecurringPayment[] = [];

  for (const [key, group] of groups) {
    if (group.length < 3) continue;

    const times = group
      .map((transaction) => Date.parse(transaction.timestamp))
      .filter((time) => !Number.isNaN(time))
      .sort((a, b) => a - b);

    if (times.length < 3) continue;

    const gaps: number[] = [];
    for (let index = 1; index < times.length; index += 1) {
      gaps.push(times[index] - times[index - 1]);
    }

    const averageGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const intervalDays = Math.round(averageGap / DAY_MS);

    // Weekly through quarterly. Tighter than that is ordinary repeat custom,
    // wider and the average stops meaning anything.
    if (intervalDays < 6 || intervalDays > 95) continue;

    // Gaps must actually be regular. A merchant visited randomly can average
    // out to 30 days without being a subscription.
    const maxDeviation = Math.max(
      ...gaps.map((gap) => Math.abs(gap - averageGap)),
    );
    if (maxDeviation > averageGap * 0.35) continue;

    const merchantKey = key.split('|')[0];
    const lastTime = times[times.length - 1];

    // A charge long past due is a cancelled subscription, not a live one.
    if (now - lastTime > averageGap * 2.5) continue;

    recurring.push({
      key: merchantKey,
      displayName: displayMerchant(merchantKey),
      amountMinor: group[0].amountMinor,
      intervalDays,
      occurrences: times.length,
      lastSeen: new Date(lastTime).toISOString(),
      nextExpected: new Date(lastTime + averageGap).toISOString(),
    });
  }

  return recurring.sort((a, b) => b.amountMinor - a.amountMinor);
}

/**
 * Searches the user's own words alongside merchant and title.
 *
 * The transcript is the point: "client meeting" will not appear in any bank
 * message, only in what the user said at the time of paying.
 */
export function searchTransactions(
  transactions: readonly Transaction[],
  query: string,
): Transaction[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  if (terms.length === 0) return [];

  return transactions.filter((transaction) => {
    if (transaction.deletedAt !== null) return false;

    const haystack = [
      transaction.note,
      transaction.transcript,
      transaction.title,
      transaction.paidTo,
      transaction.category,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLowerCase();

    // Every term must appear — narrowing as the user types is more useful
    // than an OR that widens the result set with each extra word.
    return terms.every((term) => haystack.includes(term));
  });
}

/** Total spend across a set of transactions, in paise. */
export function sumSpend(transactions: readonly Transaction[]): number {
  return transactions.reduce(
    (total, transaction) =>
      isSpend(transaction) ? total + transaction.amountMinor : total,
    0,
  );
}
