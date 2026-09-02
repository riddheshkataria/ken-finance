import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  requestCategories,
  selectNeedingLlm,
  shouldRemember,
} from './llmCategorizer';
import { learnMerchant, type MerchantMemoryMap } from './lookup';
import type { Transaction } from '../types/transaction';

const base: Transaction = {
  id: 'a',
  amountMinor: 24000,
  title: 'Payment',
  category: 'Others',
  paidTo: 'Kamath Idli Hotel',
  accountInfo: 'HDFC - 1234',
  transactionType: 'Debit',
  timestamp: '2026-09-01T12:00:00.000Z',
  source: 'SMS-parsed',
  channel: 'sms',
  refNo: '412345678901',
  accountTail: '1234',
  dedupeKey: 'ref:412345678901',
  rawPayload: 'Sent Rs.240.00 From HDFC Bank A/C x1234 To KAMATH IDLI HOTEL',
  status: 'pending_note',
  skippedCount: 0,
  lastPromptedAt: null,
  note: 'team lunch',
  transcript: 'team lunch',
  audioPath: null,
};

const make = (overrides: Partial<Transaction>): Transaction => ({
  ...base,
  ...overrides,
});

describe('selectNeedingLlm — the cost control', () => {
  it('skips merchants the user has already taught us', () => {
    const memory = learnMerchant({}, 'Kamath Idli Hotel', 'Dining');
    assert.deepEqual(selectNeedingLlm([make({})], memory), []);
  });

  it('skips merchants the shipped dictionary knows', () => {
    // Paying the API for something a lookup table answers is pure waste.
    const swiggy = make({ paidTo: 'swiggy@ybl', note: 'dinner' });
    assert.deepEqual(selectNeedingLlm([swiggy], {}), []);
  });

  it('skips transactions with no note — the model has nothing extra', () => {
    const noNote = make({ note: null, transcript: null });
    assert.deepEqual(selectNeedingLlm([noNote], {}), []);
  });

  it('skips ignored transactions', () => {
    const ignored = make({ status: 'ignored' });
    assert.deepEqual(selectNeedingLlm([ignored], {}), []);
  });

  it('selects an unknown merchant that has a note', () => {
    const selected = selectNeedingLlm([make({})], {});
    assert.deepEqual(selected.map((t) => t.id), ['a']);
  });
});

describe('shouldRemember', () => {
  it('remembers only high confidence', () => {
    // Remembering a guess would let one model mistake apply to every future
    // payment to that merchant, and override a correct dictionary answer.
    assert.equal(shouldRemember({ id: 'a', category: 'Dining', confidence: 'high' }), true);
    assert.equal(shouldRemember({ id: 'a', category: 'Dining', confidence: 'medium' }), false);
    assert.equal(shouldRemember({ id: 'a', category: 'Dining', confidence: 'low' }), false);
  });
});

describe('requestCategories', () => {
  const originalFetch = globalThis.fetch;
  let lastRequest: { url: string; body: Record<string, unknown> } | null = null;

  const stubFetch = (status: number, payload: unknown) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      lastRequest = {
        url: String(url),
        body: JSON.parse(String(init.body)),
      };
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      };
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    lastRequest = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns valid suggestions', async () => {
    stubFetch(200, {
      results: [{ id: 'a', category: 'Dining', confidence: 'high' }],
    });

    const result = await requestCategories([make({})], {
      baseUrl: 'http://localhost:5000',
    });

    assert.deepEqual(result, [{ id: 'a', category: 'Dining', confidence: 'high' }]);
  });

  it('sends only what categorisation needs', async () => {
    stubFetch(200, { results: [] });
    await requestCategories([make({})], { baseUrl: 'http://localhost:5000' });

    const items = (lastRequest?.body.items as Record<string, unknown>[]) ?? [];
    const sent = Object.keys(items[0] ?? {}).sort();

    // No account tail, no reference number, no raw message text.
    assert.deepEqual(sent, [
      'amountMinor',
      'id',
      'merchant',
      'note',
      'transactionType',
    ]);
  });

  it('drops a category the app does not understand', async () => {
    // Guards against the backend's copy of the enum drifting from ours.
    stubFetch(200, {
      results: [
        { id: 'a', category: 'Groceries', confidence: 'high' },
        { id: 'b', category: 'Dining', confidence: 'high' },
      ],
    });

    const result = await requestCategories([make({})], {
      baseUrl: 'http://localhost:5000',
    });

    assert.deepEqual(result.map((r) => r.id), ['b']);
  });

  it('returns empty when categorisation is not configured', async () => {
    stubFetch(503, { error: 'not configured', results: [] });

    const result = await requestCategories([make({})], {
      baseUrl: 'http://localhost:5000',
    });

    assert.deepEqual(result, []);
  });

  it('returns empty rather than throwing when the network fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    // A failed categorisation must never break ingestion.
    const result = await requestCategories([make({})], {
      baseUrl: 'http://localhost:5000',
    });

    assert.deepEqual(result, []);
  });

  it('makes no request for an empty batch', async () => {
    stubFetch(200, { results: [] });
    const result = await requestCategories([], { baseUrl: 'http://localhost:5000' });

    assert.deepEqual(result, []);
    assert.equal(lastRequest, null);
  });
});

describe('the tiers compose', () => {
  it('sends only the genuinely unknown merchant of a mixed batch', () => {
    const memory: MerchantMemoryMap = learnMerchant({}, 'Blue Tokai', 'Dining');

    const transactions = [
      make({ id: 'known-memory', paidTo: 'blue tokai@ybl' }),
      make({ id: 'known-dictionary', paidTo: 'Uber India' }),
      make({ id: 'no-note', paidTo: 'Mystery Shop', note: null, transcript: null }),
      make({ id: 'needs-llm', paidTo: 'Kamath Idli Hotel', note: 'team lunch' }),
    ];

    assert.deepEqual(
      selectNeedingLlm(transactions, memory).map((t) => t.id),
      ['needs-llm'],
    );
  });
});
