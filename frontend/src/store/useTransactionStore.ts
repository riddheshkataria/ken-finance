import { create } from 'zustand';
import type { Transaction } from '../types/transaction';
import { mockTransactions } from '../mock/transactions';
import {
  reconcileIncomingSms,
  reconcileTransactionList,
} from '../utils/reconciliationEngine';
import { ingestEvent, type IngestionOutcome } from '../ingestion/ingest';
import {
  deleteAllTransactions,
  deleteTransaction as deleteTransactionFromDatabase,
  initDatabase,
  loadTransactions,
  saveTransactions,
} from './database';
import { persistDiff } from './persistence';
import { useMerchantStore } from './useMerchantStore';
import {
  requestCategories,
  selectNeedingLlm,
  shouldRemember,
} from '../merchants/llmCategorizer';
import { API_BASE_URL, LLM_CATEGORIZATION_ENABLED } from '../config';
import type { IngestionEvent } from '../ingestion/types';
import {
  selectCaptureTarget,
  selectItemsToRetire,
  selectPendingQueue,
  selectQueueHead,
} from './queue';

interface TransactionState {
  transactions: Transaction[];

  // --- Ingestion ---
  /** Single entry point for bank events from either channel. */
  ingest: (event: IngestionEvent) => IngestionOutcome;

  // --- CRUD ---
  addTransaction: (transaction: Transaction) => void;
  addBankTransaction: (
    bankTransaction: Transaction,
  ) => { matched: boolean; mergedTransaction?: Transaction };
  updateTransaction: (
    id: string,
    updates: Partial<Omit<Transaction, 'id'>>,
  ) => void;
  deleteTransaction: (id: string) => void;
  getTransactionById: (id: string) => Transaction | undefined;

  // --- Pending-note queue ---
  attachNote: (
    id: string,
    note: { text: string; transcript: string | null; audioPath: string | null },
  ) => void;
  skipInQueue: (id: string) => void;
  ignoreTransaction: (id: string) => void;
  retireStaleQueueItems: (now?: number) => number;
  getQueue: () => Transaction[];
  getQueueHead: () => Transaction | null;
  getCaptureTarget: (requestedId?: string) => Transaction | null;

  // --- Bulk ---
  reconcileAll: () => number;
  setTransactions: (transactions: Transaction[]) => void;

  // --- LLM categorization (last tier, costs money) ---
  /**
   * Categorises transactions neither user memory nor the dictionary knows.
   * Returns how many were categorised.
   */
  categorizePending: () => Promise<number>;

  // --- Persistence ---
  /** True once hydration from SQLite has finished (or failed). */
  hydrated: boolean;
  /** Loads stored transactions. Call once, at app start. */
  hydrate: () => Promise<void>;
  /** Dev affordance: replaces everything with sample data. */
  loadSampleData: () => void;
  /** Removes every transaction, on device and in memory. */
  clearAll: () => void;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  // Starts empty and is filled by hydrate(). Seeding real users with mock
  // rows would be a correctness bug, not just untidy.
  transactions: [],
  hydrated: false,

  ingest: (event) => {
    let outcome = ingestEvent(event, get().transactions);

    if (outcome.kind === 'created') {
      // Apply what the user has already taught us about this merchant. The
      // parser's keyword guess is only a fallback — a category the user set
      // themselves is the whole point of merchant memory, and re-asking for
      // a merchant they have already categorised is the tedium being fixed.
      const resolution = useMerchantStore
        .getState()
        .resolve(outcome.transaction.paidTo);

      const transaction =
        resolution.category !== null
          ? { ...outcome.transaction, category: resolution.category }
          : outcome.transaction;

      outcome = { kind: 'created', transaction };
      // A new bank event may still match a voice note the user recorded
      // moments earlier — reconciliation runs before it is stored.
      const { matched, mergedTransaction } = get().addBankTransaction(
        transaction,
      );
      return matched && mergedTransaction
        ? { kind: 'duplicate', merged: mergedTransaction }
        : outcome;
    }

    if (outcome.kind === 'duplicate') {
      const merged = outcome.merged;
      set((state) => ({
        transactions: state.transactions.map((transaction) =>
          transaction.id === merged.id ? merged : transaction,
        ),
      }));
    }

    return outcome;
  },

  addTransaction: (transaction) => {
    set((state) => ({ transactions: [transaction, ...state.transactions] }));
  },

  addBankTransaction: (bankTransaction) => {
    const matchResult = reconcileIncomingSms(bankTransaction, get().transactions);

    if (
      matchResult.isMatched &&
      matchResult.matchedVoiceTransaction &&
      matchResult.mergedTransaction
    ) {
      const matchedVoiceId = matchResult.matchedVoiceTransaction.id;
      const merged = matchResult.mergedTransaction;

      // Replace the matched Voice-only record with the consolidated one.
      set((state) => ({
        transactions: state.transactions.map((transaction) =>
          transaction.id === matchedVoiceId ? merged : transaction,
        ),
      }));

      return { matched: true, mergedTransaction: merged };
    }

    set((state) => ({ transactions: [bankTransaction, ...state.transactions] }));
    return { matched: false };
  },

  updateTransaction: (id, updates) => {
    // A category the user set by hand is a teaching signal: remember it so
    // this merchant is never asked about again.
    if (updates.category) {
      const existing = get().getTransactionById(id);
      const merchant = updates.paidTo ?? existing?.paidTo;
      if (merchant) {
        useMerchantStore.getState().learn(merchant, updates.category);
      }
    }

    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id ? { ...transaction, ...updates } : transaction,
      ),
    }));
  },

  deleteTransaction: (id) => {
    set((state) => ({
      transactions: state.transactions.filter(
        (transaction) => transaction.id !== id,
      ),
    }));
  },

  getTransactionById: (id) =>
    get().transactions.find((transaction) => transaction.id === id),

  attachNote: (id, note) => {
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id
          ? {
              ...transaction,
              note: note.text,
              transcript: note.transcript,
              audioPath: note.audioPath,
              title: note.text || transaction.title,
              // Answering the "what was this for" question is exactly what
              // takes a payment out of the queue.
              status: 'complete',
            }
          : transaction,
      ),
    }));
  },

  skipInQueue: (id) => {
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id
          ? {
              ...transaction,
              skippedCount: transaction.skippedCount + 1,
              lastPromptedAt: new Date().toISOString(),
            }
          : transaction,
      ),
    }));
  },

  ignoreTransaction: (id) => {
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id ? { ...transaction, status: 'ignored' } : transaction,
      ),
    }));
  },

  retireStaleQueueItems: (now = Date.now()) => {
    const stale = selectItemsToRetire(get().transactions, now);
    if (stale.length === 0) return 0;

    const staleIds = new Set(stale.map((transaction) => transaction.id));
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        staleIds.has(transaction.id)
          ? { ...transaction, status: 'needs_review' }
          : transaction,
      ),
    }));

    return stale.length;
  },

  getQueue: () => selectPendingQueue(get().transactions),
  getQueueHead: () => selectQueueHead(get().transactions),
  getCaptureTarget: (requestedId) =>
    selectCaptureTarget(get().transactions, requestedId),

  reconcileAll: () => {
    const { reconciledList, mergedCount } = reconcileTransactionList(
      get().transactions,
    );
    set({ transactions: reconciledList });
    return mergedCount;
  },

  setTransactions: (transactions) => set({ transactions }),

  categorizePending: async () => {
    if (!LLM_CATEGORIZATION_ENABLED) return 0;

    const merchants = useMerchantStore.getState();

    // The cost control: only what the two free tiers could not answer.
    const candidates = selectNeedingLlm(get().transactions, merchants.memory);
    if (candidates.length === 0) return 0;

    const suggestions = await requestCategories(candidates, {
      baseUrl: API_BASE_URL,
    });
    if (suggestions.length === 0) return 0;

    const byId = new Map(suggestions.map((item) => [item.id, item]));

    set((state) => ({
      transactions: state.transactions.map((transaction) => {
        const suggestion = byId.get(transaction.id);
        return suggestion
          ? { ...transaction, category: suggestion.category }
          : transaction;
      }),
    }));

    // Only high-confidence answers become memory. Remembering a guess would
    // let one model mistake apply to every future payment to that merchant,
    // and memory outranks the dictionary so it could override a correct
    // shipped answer. A user correction always overwrites either way.
    for (const suggestion of suggestions) {
      if (!shouldRemember(suggestion)) continue;
      const transaction = get().getTransactionById(suggestion.id);
      if (transaction) {
        merchants.learn(transaction.paidTo, suggestion.category);
      }
    }

    return suggestions.length;
  },

  hydrate: async () => {
    if (get().hydrated) return;

    const available = await initDatabase();
    if (available) {
      const stored = await loadTransactions();
      // Assigned directly rather than merged: at hydration the database is
      // authoritative and nothing has been captured in this session yet.
      set({ transactions: stored });
    }

    // Marked hydrated even when SQLite is unavailable, so the UI leaves its
    // loading state and the app still works in memory.
    set({ hydrated: true });
  },

  loadSampleData: () => set({ transactions: mockTransactions }),

  clearAll: () => {
    set({ transactions: [] });
    void deleteAllTransactions();
  },
}));

/**
 * Write-through persistence.
 *
 * Subscribing here rather than saving inside each action means any action
 * added later is persisted automatically. Registered at module scope so it is
 * attached before the first mutation can happen.
 */
useTransactionStore.subscribe((state, previous) => {
  if (state.transactions === previous.transactions) return;
  void persistDiff(previous.transactions, state.transactions, {
    saveTransactions,
    deleteTransaction: deleteTransactionFromDatabase,
  });
});
