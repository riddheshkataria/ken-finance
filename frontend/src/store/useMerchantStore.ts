/**
 * Merchant memory: what the user has taught us about who they pay.
 *
 * A separate store from transactions because it is a different entity, not a
 * mirror of the same data — the rule against parallel stores (rules.md §3) is
 * about duplicating one source of truth, which this does not do.
 *
 * Categorising a merchant once and never being asked again is what removes
 * most of the manual tedium the app exists to solve, and it costs nothing per
 * transaction.
 */
import { create } from 'zustand';
import type { TransactionCategory } from '../types/transaction';
import {
  learnMerchant,
  resolveCategory,
  type CategoryResolution,
  type MerchantMemory,
  type MerchantMemoryMap,
} from '../merchants/lookup';
import {
  deleteAllMerchants,
  initDatabase,
  loadMerchants,
  saveMerchant,
} from './database';

interface MerchantState {
  memory: MerchantMemoryMap;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  /** Records the user's decision for this merchant. */
  learn: (rawMerchant: string | null | undefined, category: TransactionCategory) => void;
  /** Resolves a category, preferring what the user taught us. */
  resolve: (rawMerchant: string | null | undefined) => CategoryResolution;
  clearAll: () => void;
}

export const useMerchantStore = create<MerchantState>((set, get) => ({
  memory: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;

    const available = await initDatabase();
    if (available) {
      const stored = await loadMerchants();
      const memory: Record<string, MerchantMemory> = {};
      for (const entry of stored) {
        memory[entry.key] = entry;
      }
      set({ memory });
    }

    set({ hydrated: true });
  },

  learn: (rawMerchant, category) => {
    const previous = get().memory;
    const updated = learnMerchant(previous, rawMerchant, category);

    // learnMerchant returns the same object when the merchant had no usable
    // key, so an unparseable name never creates a junk row.
    if (updated === previous) return;

    // Find the changed entry against the PREVIOUS map, before set() makes
    // get().memory the new one and the comparison becomes vacuous.
    const changedKey = Object.keys(updated).find(
      (key) => updated[key] !== previous[key],
    );

    set({ memory: updated });

    if (changedKey) void saveMerchant(updated[changedKey]);
  },

  resolve: (rawMerchant) => resolveCategory(rawMerchant, get().memory),

  clearAll: () => {
    set({ memory: {} });
    void deleteAllMerchants();
  },
}));
