import { create } from 'zustand';
import type { Transaction } from '../types/transaction';
import { mockTransactions } from '../mock/transactions';
import {
  reconcileIncomingSms,
  reconcileTransactionList,
} from '../utils/reconciliationEngine';
import { ingestEvent, type IngestionOutcome } from '../ingestion/ingest';
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
  resetToMock: () => void;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactions: mockTransactions,

  ingest: (event) => {
    const outcome = ingestEvent(event, get().transactions);

    if (outcome.kind === 'created') {
      // A new bank event may still match a voice note the user recorded
      // moments earlier — reconciliation runs before it is stored.
      const { matched, mergedTransaction } = get().addBankTransaction(
        outcome.transaction,
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

  resetToMock: () => set({ transactions: mockTransactions }),
}));
