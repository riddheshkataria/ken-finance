/**
 * Monthly budgets per category.
 *
 * A separate entity from transactions and merchants, so a separate store —
 * this is not a mirror of anything (rules.md §3).
 *
 * Absence of a category means no budget, which is deliberately different from
 * a budget of zero: "I have not set one" and "I intend to spend nothing here"
 * should not look the same in the UI.
 */
import { create } from 'zustand';
import type { TransactionCategory } from '../types/transaction';
import type { BudgetMap } from '../analytics/budget';
import {
  deleteBudget,
  initDatabase,
  loadBudgets,
  saveBudget,
} from './database';

const VALID_CATEGORIES: ReadonlySet<string> = new Set<TransactionCategory>([
  'Dining',
  'Grocery',
  'Transport',
  'Rent',
  'Bills',
  'P2P Transfer',
  'Investment',
  'Others',
]);

interface BudgetState {
  budgets: BudgetMap;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  /** Sets a monthly budget in paise. Zero or less removes it. */
  setBudget: (category: TransactionCategory, amountMinor: number) => void;
  clearBudget: (category: TransactionCategory) => void;
}

export const useBudgetStore = create<BudgetState>((set, get) => ({
  budgets: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;

    const available = await initDatabase();
    if (available) {
      const rows = await loadBudgets();
      const budgets: Partial<Record<TransactionCategory, number>> = {};

      for (const row of rows) {
        // Guard against a stale row for a category that no longer exists —
        // the enum is closed, and an unknown key would never be rendered but
        // would still be counted in the overall budget total.
        if (!VALID_CATEGORIES.has(row.category)) continue;
        budgets[row.category as TransactionCategory] = Math.trunc(row.amount_minor);
      }

      set({ budgets });
    }

    set({ hydrated: true });
  },

  setBudget: (category, amountMinor) => {
    if (amountMinor <= 0) {
      get().clearBudget(category);
      return;
    }

    const rounded = Math.trunc(amountMinor);
    set((state) => ({ budgets: { ...state.budgets, [category]: rounded } }));
    void saveBudget(category, rounded);
  },

  clearBudget: (category) => {
    set((state) => {
      const next = { ...state.budgets };
      delete next[category];
      return { budgets: next };
    });
    void deleteBudget(category);
  },
}));
