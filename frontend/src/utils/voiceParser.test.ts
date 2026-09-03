import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoiceToTransaction } from './voiceParser';

describe('parseVoiceToTransaction', () => {
  it('correctly parses incoming repayment (Tanmay sent me 230 he owed me for food)', () => {
    const result = parseVoiceToTransaction('tanmay sent me 230 he owed me for food');
    assert.equal(result.amountMinor, 23000);
    assert.equal(result.transactionType, 'Credit');
    assert.equal(result.paidTo, 'Tanmay');
    assert.equal(result.category, 'Dining');
    assert.equal(result.title, 'Food');
  });

  it('correctly parses outgoing debit (Spent 650 at Starbucks for cold brew)', () => {
    const result = parseVoiceToTransaction('Spent 650 at Starbucks for cold brew');
    assert.equal(result.amountMinor, 65000);
    assert.equal(result.transactionType, 'Debit');
    assert.equal(result.paidTo, 'Starbucks');
    assert.equal(result.category, 'Dining');
    assert.equal(result.title, 'Cold Brew');
  });

  it('correctly parses outgoing rent debit (Paid 3000 to Amit for flat rent)', () => {
    const result = parseVoiceToTransaction('Paid 3000 to Amit for flat rent');
    assert.equal(result.amountMinor, 300000);
    assert.equal(result.transactionType, 'Debit');
    assert.equal(result.paidTo, 'Amit');
    assert.equal(result.category, 'Rent');
    assert.equal(result.title, 'Flat Rent');
  });

  it('correctly parses received P2P credit (Received 500 from Rohit for dinner)', () => {
    const result = parseVoiceToTransaction('Received 500 from Rohit for dinner');
    assert.equal(result.amountMinor, 50000);
    assert.equal(result.transactionType, 'Credit');
    assert.equal(result.paidTo, 'Rohit');
    assert.equal(result.category, 'Dining');
    assert.equal(result.title, 'Dinner');
  });

  it('correctly parses cashback credit (Got 1200 cashback from Amazon)', () => {
    const result = parseVoiceToTransaction('Got 1200 cashback from Amazon');
    assert.equal(result.amountMinor, 120000);
    assert.equal(result.transactionType, 'Credit');
    assert.equal(result.paidTo, 'Amazon');
  });

  it('handles "k" shorthand and thousands (Sent 2.5k to Priya for groceries)', () => {
    const result = parseVoiceToTransaction('Sent 2.5k to Priya for groceries');
    assert.equal(result.amountMinor, 250000);
    assert.equal(result.transactionType, 'Debit');
    assert.equal(result.paidTo, 'Priya');
    assert.equal(result.category, 'Grocery');
  });
});

