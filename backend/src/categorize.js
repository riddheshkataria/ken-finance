/**
 * LLM categorisation — the last tier, and the only one that costs money.
 *
 * The app resolves categories in three tiers: user memory, then a shipped
 * merchant dictionary, then this. By the time a transaction reaches here, both
 * free tiers have missed, which should be a small minority of traffic. The
 * client is responsible for not calling this otherwise; see the guard in
 * frontend/src/store/useMerchantStore.ts.
 *
 * What makes this worth the call rather than a keyword guess: the user's own
 * voice note. "Chai with the team" is unambiguous to a model and invisible to
 * a regex.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

/**
 * The 8 categories, closed. Must stay identical to TransactionCategory in
 * frontend/src/types/transaction.ts — the frontend re-validates what comes
 * back, so a drift here degrades to "uncategorised" rather than corrupting
 * data, but it should still be updated in the same commit (rules.md §2).
 */
const CATEGORIES = [
  'Dining',
  'Grocery',
  'Transport',
  'Rent',
  'Bills',
  'P2P Transfer',
  'Investment',
  'Others',
];

const ResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      category: z.enum(CATEGORIES),
      // Surfaced so the client can decide whether to apply silently or ask.
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

/**
 * Kept byte-stable so it caches. Anything volatile — the transactions
 * themselves — goes in the user message, after the cache breakpoint.
 */
const SYSTEM_PROMPT = `You categorise Indian personal-finance transactions.

Assign each transaction exactly one category from this list:
- Dining: restaurants, cafes, food delivery, bars, chai
- Grocery: supermarkets, quick-commerce groceries, milk, vegetables, meat
- Transport: cabs, autos, metro, fuel, tolls, parking, flights, trains
- Rent: house or flat rent, deposits, society maintenance, brokerage
- Bills: utilities, mobile, internet, DTH, gas, insurance premiums, subscriptions
- P2P Transfer: money to or from another person, splitting, repayment
- Investment: mutual funds, SIPs, stocks, gold, fixed deposits, NPS
- Others: anything that fits none of the above (shopping, health, entertainment)

The user's own voice note, when present, is the strongest signal — it states
what the payment was actually for. Prefer it over the merchant name. A note
saying "team lunch" makes it Dining even if the merchant looks like a hotel.

Confidence:
- high: the note or a well-known merchant makes it unambiguous
- medium: a reasonable inference from partial information
- low: essentially a guess

Use "Others" with low confidence rather than forcing a poor fit. A wrong
category the user must hunt down and undo is worse than an honest "Others".`;

let client = null;

/** True when an API credential is configured. */
function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient() {
  if (!client) {
    // Zero-arg constructor: the SDK resolves the API key, auth token, or an
    // `ant auth login` profile on its own.
    client = new Anthropic();
  }
  return client;
}

/**
 * Formats transactions for the model.
 *
 * Deliberately narrow: merchant, amount, direction and the user's note. No
 * account numbers, no reference numbers, no raw message text — none of it
 * helps categorisation, and all of it is sensitive (rules.md §9).
 */
function toPromptPayload(items) {
  return items.map((item) => ({
    id: item.id,
    merchant: item.merchant || 'unknown',
    amount_rupees: Math.round((item.amountMinor ?? 0) / 100),
    direction: item.transactionType === 'Credit' ? 'received' : 'paid',
    note: item.note || item.transcript || null,
  }));
}

/**
 * Categorises a batch of transactions.
 *
 * Batched by design: one request for twenty transactions costs far less than
 * twenty requests, and the cached system prompt is only paid for once.
 *
 * Returns [] rather than throwing when unconfigured or on failure —
 * categorisation is an enhancement, and losing it must never block a payment
 * from being recorded.
 */
async function categorizeTransactions(items) {
  if (!isConfigured() || !Array.isArray(items) || items.length === 0) {
    return [];
  }

  try {
    const response = await getClient().messages.parse({
      model: 'claude-opus-5',
      max_tokens: 4096,
      // The taxonomy is identical on every call, so caching it turns most of
      // the input cost into a cache read.
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      // Classification does not need deliberation, and low effort is
      // materially cheaper and faster on short inputs.
      output_config: {
        format: zodOutputFormat(ResultSchema),
        effort: 'low',
      },
      messages: [
        {
          role: 'user',
          content: `Categorise these transactions:\n\n${JSON.stringify(
            toPromptPayload(items),
            null,
            2,
          )}`,
        },
      ],
    });

    // parsed_output is null when the response did not satisfy the schema.
    return response.parsed_output?.results ?? [];
  } catch (error) {
    console.warn('[ken] Categorisation failed:', error.message);
    return [];
  }
}

module.exports = {
  CATEGORIES,
  categorizeTransactions,
  isConfigured,
};
