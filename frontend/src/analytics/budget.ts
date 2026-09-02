/**
 * Budget maths.
 *
 * The framing that matters: "you spent ₹4,200" is a fact the user already
 * knows. "You are 70% through the month and 90% through the food budget" is
 * something they can act on. Every function here exists to produce the second
 * kind of number.
 *
 * All amounts are integer paise (rules.md §1). Divisions floor rather than
 * round, so a "safe to spend" figure is never optimistic — telling someone
 * they can spend ₹1 more than they can is the one rounding direction that
 * actually costs them.
 */
import type { Transaction, TransactionCategory } from '../types/transaction';
import { isWithin, type Period } from './period';

export interface Budget {
  category: TransactionCategory;
  /** Integer paise per month. */
  amountMinor: number;
}

export type BudgetMap = Readonly<Partial<Record<TransactionCategory, number>>>;

/**
 * Whether a transaction counts as spending.
 *
 * Credits are money in, not out. Ignored transactions were explicitly set
 * aside by the user — usually transfers to self, which would otherwise
 * inflate every total for money that never left their control.
 */
export function isSpend(transaction: Transaction): boolean {
  return (
    transaction.transactionType === 'Debit' && transaction.status !== 'ignored'
  );
}

/** Total spend in the period, in paise. */
export function totalSpend(
  transactions: readonly Transaction[],
  period: Period,
): number {
  return transactions.reduce(
    (total, transaction) =>
      isSpend(transaction) && isWithin(period, transaction.timestamp)
        ? total + transaction.amountMinor
        : total,
    0,
  );
}

/** Spend per category in the period, in paise. */
export function spendByCategory(
  transactions: readonly Transaction[],
  period: Period,
): Partial<Record<TransactionCategory, number>> {
  const totals: Partial<Record<TransactionCategory, number>> = {};

  for (const transaction of transactions) {
    if (!isSpend(transaction)) continue;
    if (!isWithin(period, transaction.timestamp)) continue;

    totals[transaction.category] =
      (totals[transaction.category] ?? 0) + transaction.amountMinor;
  }

  return totals;
}

export interface BudgetStatus {
  category: TransactionCategory;
  budgetMinor: number;
  spentMinor: number;
  remainingMinor: number;
  /** 0..1+, where >1 means over budget. */
  spentFraction: number;
  /** 0..1, how far through the month we are. */
  periodFraction: number;
  /**
   * Spending faster than the month is passing. This is the actionable
   * signal — being at 90% of the food budget is fine on the 28th and a
   * problem on the 10th.
   */
  isOverpacing: boolean;
  isOverBudget: boolean;
  /** Floor of remaining / remaining days, in paise. Never negative. */
  safeToSpendTodayMinor: number;
}

export function budgetStatus(
  category: TransactionCategory,
  budgetMinor: number,
  spentMinor: number,
  period: Period,
): BudgetStatus {
  const remainingMinor = budgetMinor - spentMinor;
  const spentFraction = budgetMinor > 0 ? spentMinor / budgetMinor : 0;
  const periodFraction = period.elapsedDays / period.totalDays;

  return {
    category,
    budgetMinor,
    spentMinor,
    remainingMinor,
    spentFraction,
    periodFraction,
    // A small tolerance keeps a normal day's spending from flagging the
    // moment it crosses the straight line.
    isOverpacing: budgetMinor > 0 && spentFraction > periodFraction + 0.1,
    isOverBudget: spentMinor > budgetMinor,
    safeToSpendTodayMinor:
      remainingMinor > 0
        ? Math.floor(remainingMinor / period.remainingDays)
        : 0,
  };
}

/** Budget status for every category that has a budget set. */
export function allBudgetStatuses(
  transactions: readonly Transaction[],
  budgets: BudgetMap,
  period: Period,
): BudgetStatus[] {
  const spent = spendByCategory(transactions, period);

  return (Object.keys(budgets) as TransactionCategory[])
    .filter((category) => (budgets[category] ?? 0) > 0)
    .map((category) =>
      budgetStatus(category, budgets[category] ?? 0, spent[category] ?? 0, period),
    )
    .sort((a, b) => b.spentFraction - a.spentFraction);
}

export interface OverallBudget {
  budgetMinor: number;
  spentMinor: number;
  remainingMinor: number;
  /**
   * What the user can spend today without going over, across all budgeted
   * categories. The single number people actually act on.
   */
  safeToSpendTodayMinor: number;
  periodFraction: number;
  spentFraction: number;
}

export function overallBudget(
  transactions: readonly Transaction[],
  budgets: BudgetMap,
  period: Period,
): OverallBudget {
  const budgetMinor = (Object.values(budgets) as number[]).reduce(
    (total, amount) => total + (amount ?? 0),
    0,
  );

  // Only spend in budgeted categories counts against the total, so an
  // unbudgeted category cannot silently consume another's headroom.
  const spent = spendByCategory(transactions, period);
  const spentMinor = (Object.keys(budgets) as TransactionCategory[]).reduce(
    (total, category) => total + (spent[category] ?? 0),
    0,
  );

  const remainingMinor = budgetMinor - spentMinor;

  return {
    budgetMinor,
    spentMinor,
    remainingMinor,
    safeToSpendTodayMinor:
      remainingMinor > 0 ? Math.floor(remainingMinor / period.remainingDays) : 0,
    periodFraction: period.elapsedDays / period.totalDays,
    spentFraction: budgetMinor > 0 ? spentMinor / budgetMinor : 0,
  };
}
