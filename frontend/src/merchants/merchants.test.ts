import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { displayMerchant, normalizeMerchant } from './normalize';
import { learnMerchant, resolveCategory, type MerchantMemoryMap } from './lookup';
import { parseIngestionEvent } from '../ingestion/parseEvent';

describe('normalizeMerchant', () => {
  it('collapses the four forms of the same merchant to one key', () => {
    // The whole feature depends on this: categorise Swiggy once, and every
    // channel's spelling of Swiggy must hit that memory.
    assert.equal(normalizeMerchant('swiggy@ybl'), 'swiggy');
    assert.equal(normalizeMerchant('SWIGGY LIMITED'), 'swiggy');
    assert.equal(normalizeMerchant('Swiggy'), 'swiggy');
    assert.equal(normalizeMerchant('UPI/SWIGGY/412345678901'), 'swiggy');
  });

  it('strips legal suffixes but not descriptive words', () => {
    assert.equal(normalizeMerchant('Blue Tokai Coffee Pvt Ltd'), 'blue tokai coffee');
    assert.equal(normalizeMerchant('Zomato Private Limited'), 'zomato');
  });

  it('keeps distinct merchants distinct', () => {
    // Over-normalising here would file every grocery run as a restaurant.
    assert.notEqual(
      normalizeMerchant('Swiggy Instamart'),
      normalizeMerchant('Swiggy'),
    );
    assert.equal(normalizeMerchant('Swiggy Instamart'), 'swiggy instamart');
  });

  it('drops reference numbers but keeps short numbers in names', () => {
    assert.equal(normalizeMerchant('SWIGGY 412345678901'), 'swiggy');
    assert.equal(normalizeMerchant('Cafe 21'), 'cafe 21');
  });

  it('normalises punctuation so spellings agree', () => {
    assert.equal(normalizeMerchant('blue-tokai'), normalizeMerchant('Blue Tokai'));
    assert.equal(normalizeMerchant('D.MART'), 'd mart');
  });

  it('keeps the person, not the bank, from a personal VPA', () => {
    assert.equal(normalizeMerchant('rahul.sharma@oksbi'), 'rahul sharma');
  });

  it('returns empty for values carrying no signal', () => {
    // Storing these would make every unparseable payment share one memory
    // entry and overwrite each other's category.
    assert.equal(normalizeMerchant(''), '');
    assert.equal(normalizeMerchant(null), '');
    assert.equal(normalizeMerchant('123456789'), '');
    assert.equal(normalizeMerchant('x'), '');
  });
});

describe('displayMerchant', () => {
  it('title-cases words but keeps acronyms upper', () => {
    assert.equal(displayMerchant('swiggy'), 'Swiggy');
    assert.equal(displayMerchant('blue tokai'), 'Blue Tokai');
    assert.equal(displayMerchant('kfc'), 'KFC');
  });
});

describe('resolveCategory', () => {
  const empty: MerchantMemoryMap = {};

  it('resolves known merchants from the shipped dictionary', () => {
    assert.equal(resolveCategory('swiggy@ybl', empty).category, 'Dining');
    assert.equal(resolveCategory('Uber India', empty).category, 'Transport');
    assert.equal(resolveCategory('Zerodha Coin', empty).category, 'Investment');
  });

  it('prefers the more specific dictionary entry', () => {
    // "swiggy instamart" contains "swiggy", but Instamart is groceries.
    assert.equal(
      resolveCategory('Swiggy Instamart', empty).category,
      'Grocery',
    );
  });

  it('refuses to guess from an ambiguous prefix alone', () => {
    // "swiggy genie" is neither a restaurant order nor groceries; guessing
    // Dining from the prefix would be a silent miscategorisation.
    const result = resolveCategory('Swiggy Genie Delivery', empty);
    assert.equal(result.category, null);
    assert.equal(result.source, 'none');
  });

  it('returns null rather than guessing for an unknown merchant', () => {
    const result = resolveCategory('Kamath Idli Hotel', empty);
    assert.equal(result.category, null);
    assert.equal(result.source, 'none');
  });

  it('user memory beats the dictionary', () => {
    // Someone who buys groceries through Swiggy should not keep being told
    // it is Dining, no matter what the dictionary ships with.
    const memory = learnMerchant({}, 'swiggy@ybl', 'Grocery');
    const result = resolveCategory('SWIGGY LIMITED', memory);

    assert.equal(result.category, 'Grocery');
    assert.equal(result.source, 'user-memory');
  });
});

describe('learnMerchant', () => {
  it('applies a single correction to every later spelling', () => {
    // This is the entire point of the feature.
    const memory = learnMerchant({}, 'Kamath Idli Hotel', 'Dining');

    assert.equal(resolveCategory('kamath idli hotel@ybl', memory).category, 'Dining');
    assert.equal(
      resolveCategory('UPI/KAMATH IDLI HOTEL/9988', memory).category,
      'Dining',
    );
  });

  it('counts confirmations and updates the category on a change of mind', () => {
    let memory = learnMerchant({}, 'Blue Tokai', 'Dining');
    memory = learnMerchant(memory, 'blue tokai', 'Grocery');

    assert.equal(memory['blue tokai'].category, 'Grocery');
    assert.equal(memory['blue tokai'].seenCount, 2);
  });

  it('does not store a merchant with no usable key', () => {
    assert.deepEqual(learnMerchant({}, '', 'Dining'), {});
    assert.deepEqual(learnMerchant({}, '123456', 'Dining'), {});
  });

  it('does not mutate the memory it was given', () => {
    const original: MerchantMemoryMap = {};
    const updated = learnMerchant(original, 'Swiggy', 'Dining');

    assert.deepEqual(original, {});
    assert.notEqual(updated, original);
  });
});

describe('the user journey this feature exists for', () => {
  it('stops asking about a merchant after one correction', () => {
    // A real bank SMS for a merchant the dictionary has never heard of.
    const first = parseIngestionEvent({
      channel: 'sms',
      origin: 'AD-HDFCBK',
      body:
        'Sent Rs.180.00 From HDFC Bank A/C x1234 To KAMATH IDLI HOTEL On 01/09/26 Ref 412345678901',
      receivedAt: Date.parse('2026-09-01T12:00:00.000Z'),
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // Nothing known yet, so no category can be resolved — the parser's
    // keyword guess stands and the user has to decide.
    let memory: MerchantMemoryMap = {};
    assert.equal(resolveCategory(first.event.paidTo, memory).category, null);

    // The user categorises it once.
    memory = learnMerchant(memory, first.event.paidTo, 'Dining');

    // The same shop, days later, reported through the other channel with a
    // completely different spelling.
    const second = parseIngestionEvent({
      channel: 'notification',
      origin: 'com.google.android.apps.nbu.paisa.user',
      title: 'Paid ₹220 to Kamath Idli Hotel',
      body: 'Using HDFC Bank ****1234',
      receivedAt: Date.parse('2026-09-04T09:00:00.000Z'),
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    const resolved = resolveCategory(second.event.paidTo, memory);
    assert.equal(resolved.category, 'Dining', 'the user was asked twice');
    assert.equal(resolved.source, 'user-memory');
  });

  it('categorises a known merchant on the very first payment', () => {
    const result = parseIngestionEvent({
      channel: 'sms',
      origin: 'JD-ICICIB',
      body:
        'INR 240.50 debited from A/c XX9012 on 01-09-26 to VPA swiggy@ybl (UPI Ref 612345678903)',
      receivedAt: Date.parse('2026-09-01T12:00:00.000Z'),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Shipped dictionary means day one is not blank.
    const resolved = resolveCategory(result.event.paidTo, {});
    assert.equal(resolved.category, 'Dining');
    assert.equal(resolved.source, 'dictionary');
  });
});
