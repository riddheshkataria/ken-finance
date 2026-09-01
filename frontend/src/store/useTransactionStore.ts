import { create } from 'zustand';
import type { Transaction } from '../types/transaction';
import { mockTransactions } from '../mock/transactions';
import { reconcileIncomingSms, reconcileTransactionList } from '../utils/reconciliationEngine';

interface TransactionState {
  transactions: Transaction[];
  // CRUD actions
  addTransaction: (transaction: Transaction) => void;
  addSmsTransaction: (smsTransaction: Transaction) => { matched: boolean; mergedTransaction?: Transaction };
  updateTransaction: (id: string, updates: Partial<Omit<Transaction, 'id'>>) => void;
  deleteTransaction: (id: string) => void;
  getTransactionById: (id: string) => Transaction | undefined;
  reconcileAll: () => number;
  setTransactions: (transactions: Transaction[]) => void;
  resetToMock: () => void;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactions: mockTransactions,

  addTransaction: (transaction) => {
    set((state) => ({
      transactions: [transaction, ...state.transactions],
    }));
  },

  addSmsTransaction: (smsTransaction) => {
    const currentTransactions = get().transactions;
    const matchResult = reconcileIncomingSms(smsTransaction, currentTransactions);

    if (matchResult.isMatched && matchResult.matchedVoiceTransaction && matchResult.mergedTransaction) {
      const matchedVoiceId = matchResult.matchedVoiceTransaction.id;
      const merged = matchResult.mergedTransaction;

      // Replace the matched Voice-only record with the consolidated Merged record
      set((state) => ({
        transactions: state.transactions.map((tx) => (tx.id === matchedVoiceId ? merged : tx)),
      }));

      return { matched: true, mergedTransaction: merged };
    }

    // No voice record matched; add as fresh SMS-parsed transaction
    set((state) => ({
      transactions: [smsTransaction, ...state.transactions],
    }));

    return { matched: false };
  },

  updateTransaction: (id, updates) => {
    set((state) => ({
      transactions: state.transactions.map((tx) =>
        tx.id === id ? { ...tx, ...updates } : tx
      ),
    }));
  },

  deleteTransaction: (id) => {
    set((state) => ({
      transactions: state.transactions.filter((tx) => tx.id !== id),
    }));
  },

  getTransactionById: (id) => {
    return get().transactions.find((tx) => tx.id === id);
  },

  reconcileAll: () => {
    const { reconciledList, mergedCount } = reconcileTransactionList(get().transactions);
    set({ transactions: reconciledList });
    return mergedCount;
  },

  setTransactions: (transactions) => {
    set({ transactions });
  },

  resetToMock: () => {
    set({ transactions: mockTransactions });
  },
}));
