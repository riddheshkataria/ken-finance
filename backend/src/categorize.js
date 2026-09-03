/**
 * LLM categorisation with Google Gemini — the last tier, and the only one that uses an external AI model.
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
const { GoogleGenAI, Type } = require('@google/genai');
const { z } = require('zod');

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
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

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

let ai = null;

/** True when a Gemini API key is configured. */
function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function getClient() {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
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
 * Categorises a batch of transactions using Google Gemini with structured JSON output.
 *
 * Batched by design: one request for twenty transactions costs far less than
 * twenty requests.
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
    const client = getClient();
    const promptPayload = toPromptPayload(items);

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Categorise these transactions:\n\n${JSON.stringify(promptPayload, null, 2)}`,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            results: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  category: {
                    type: Type.STRING,
                    enum: CATEGORIES,
                  },
                  confidence: {
                    type: Type.STRING,
                    enum: ['high', 'medium', 'low'],
                  },
                },
                required: ['id', 'category', 'confidence'],
              },
            },
          },
          required: ['results'],
        },
      },
    });

    const parsedJson = JSON.parse(response.text || '{}');
    const validated = ResultSchema.safeParse(parsedJson);

    if (!validated.success) {
      console.warn('[ken] Gemini output schema validation warning:', validated.error);
      return [];
    }

    return validated.data.results;
  } catch (error) {
    console.warn('[ken] Gemini categorisation failed:', error.message);
    return [];
  }
}

module.exports = {
  CATEGORIES,
  categorizeTransactions,
  isConfigured,
};
