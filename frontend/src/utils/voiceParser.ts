import type { Transaction, TransactionCategory, TransactionType } from '../types/transaction';
import { rupeesToPaise } from './money';

/**
 * Category keyword mappings with weighted priority
 */
const CATEGORY_KEYWORDS: Record<TransactionCategory, string[]> = {
  Dining: [
    'starbucks', 'cafe', 'coffee', 'tea', 'dinner', 'lunch', 'breakfast', 'brunch',
    'food', 'swiggy', 'zomato', 'restaurant', 'bar', 'pub', 'burger', 'pizza',
    'mcdonalds', 'kfc', 'dominos', 'meal', 'eating', 'snacks', 'cold brew', 'drinks',
    'diner', 'bakery', 'subway'
  ],
  Grocery: [
    'grocery', 'groceries', 'veggies', 'vegetables', 'fruits', 'milk', 'instamart',
    'blinkit', 'zepto', 'bigbasket', 'supermarket', 'mart', 'dmart', 'provisions',
    'bread', 'eggs', 'spices', 'ration'
  ],
  Transport: [
    'uber', 'ola', 'rapido', 'cab', 'taxi', 'auto', 'rickshaw', 'metro',
    'petrol', 'diesel', 'fuel', 'toll', 'fastag', 'bus', 'flight', 'train',
    'irctc', 'parking', 'gas station'
  ],
  Rent: [
    'flat rent', 'house rent', 'room rent', 'rent', 'landlord', 'pg', 'society maintenance'
  ],
  Bills: [
    'electricity bill', 'water bill', 'wifi', 'broadband', 'internet', 'recharge',
    'mobile bill', 'dth', 'cylinder', 'gas bill', 'bill', 'tata power', 'bescom',
    'jio', 'airtel', 'vi', 'utility', 'postpaid'
  ],
  'P2P Transfer': [
    'split', 'sent to', 'transferred', 'p2p', 'borrowed', 'lent', 'repaid', 'owe'
  ],
  Investment: [
    'sip', 'mutual fund', 'stocks', 'shares', 'zerodha', 'groww', 'angelone',
    'index fund', 'crypto', 'bitcoin', 'fixed deposit', 'fd', 'etf', 'gold'
  ],
  Others: [
    'shopping', 'amazon', 'flipkart', 'myntra', 'clothes', 'shoes', 'gym',
    'medicine', 'pharmacy', 'hospital', 'doctor', 'movie', 'cinema', 'book'
  ],
};

const CREDIT_KEYWORDS = [
  'received', 'credited', 'got', 'refund', 'refunded', 'cashback', 'salary',
  'dividend', 'incoming', 'deposit', 'deposited'
];

/**
 * Normalizes words by stripping punctuation
 */
function cleanText(text: string): string {
  return text.trim().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ').replace(/\s{2,}/g, ' ');
}

/**
 * Formats a string to Title Case
 */
function toTitleCase(str: string): string {
  if (!str) return '';
  return str
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Extracts the spoken amount as integer paise (rules.md §1).
 * Handles "k"/thousand, commas, currency symbols and decimals.
 * People speak rupees ("650", "1.5k"), so conversion happens here — this is
 * the boundary where a human-supplied rupee figure enters the system.
 */
function extractAmountMinor(transcript: string): number {
  // Check for expressions like "3k", "1.5k", "3 thousand"
  const kMatch = transcript.match(/(?:rs\.?|inr|₹|\$)?\s*(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/i);
  if (kMatch) {
    return rupeesToPaise(parseFloat(kMatch[1]) * 1000);
  }

  // Check for numbers (with optional commas/decimals and optional currency prefix/suffix)
  const match = transcript.match(/(?:rs\.?|rupees?|inr|₹|\$)?\s*(\d+(?:,\d+)*(?:\.\d+)?)(?:\s*(?:bucks|rupees?|rs\.?|inr))?/i);
  if (match && match[1]) {
    const rawNum = match[1].replace(/,/g, '');
    const val = parseFloat(rawNum);
    if (!isNaN(val) && val > 0) {
      return rupeesToPaise(val);
    }
  }

  return 0; // safe fallback
}

/**
 * Classifies transcript into one of the 8 strict categories
 */
function extractCategory(transcript: string): TransactionCategory {
  const lower = transcript.toLowerCase();

  // Match against known category keyword lists
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [TransactionCategory, string[]][]) {
    for (const kw of keywords) {
      // Word boundary match
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(lower)) {
        return category;
      }
    }
  }

  // If sentence is "Paid X to [Person]" or "Received X from [Person]" without other category, classify as P2P Transfer
  if (/\b(?:paid|sent|transferred|give|gave)\s+\d+.*?\bto\s+[A-Z][a-z]+/i.test(transcript) ||
      /\b(?:received|got)\s+\d+.*?\bfrom\s+[A-Z][a-z]+/i.test(transcript)) {
    return 'P2P Transfer';
  }

  return 'Others';
}

/**
 * Extracts merchant, person name, or entity from context
 */
function extractPaidTo(transcript: string): string {
  // Pattern 1: "at/to/from/via/in [Merchant/Person] for/towards/on ..."
  const atToMatch = transcript.match(/\b(?:at|to|from|on|via)\s+([A-Za-z0-9&'\s]+?)(?=\s+(?:for|towards|via|by|worth|using|through|on\s+account|with)|$)/i);
  if (atToMatch && atToMatch[1]) {
    const candidate = cleanText(atToMatch[1]).trim();
    // Exclude noise words
    if (candidate && !['the', 'my', 'a', 'an', 'cash', 'account', 'upi'].includes(candidate.toLowerCase())) {
      return toTitleCase(candidate);
    }
  }

  // Pattern 2: Known merchant keywords
  const merchants = [
    'Starbucks', 'Swiggy', 'Zomato', 'Uber', 'Ola', 'Blinkit', 'Zepto', 'Instamart',
    'Amazon', 'Flipkart', 'Netflix', 'Spotify', 'Tata Power', 'Airtel', 'Jio',
    'Zerodha', 'Groww', 'Blue Tokai', 'McDonalds', 'Dominos', 'KFC', 'BigBasket'
  ];

  for (const m of merchants) {
    if (new RegExp(`\\b${m}\\b`, 'i').test(transcript)) {
      return m;
    }
  }

  return 'Unknown Merchant';
}

/**
 * Extracts a concise description/title of the transaction purpose
 */
function extractTitle(transcript: string, paidTo: string, category: TransactionCategory): string {
  // Look for purpose after "for", "towards", "on"
  const forMatch = transcript.match(/\b(?:for|towards|on)\s+([A-Za-z0-9&'\s]+?)(?=\s+(?:at|to|from|via|using|through|worth)|$)/i);
  if (forMatch && forMatch[1]) {
    const purpose = cleanText(forMatch[1]).trim();
    if (purpose && !['it', 'this', 'that'].includes(purpose.toLowerCase())) {
      return toTitleCase(purpose);
    }
  }

  // If paidTo is available, format as "[PaidTo] - [Category]"
  if (paidTo && paidTo !== 'Unknown Merchant') {
    return `${paidTo} (${category})`;
  }

  // Fallback: sanitized transcript snippet
  const sanitized = cleanText(transcript);
  return sanitized.length > 30 ? `${sanitized.substring(0, 30)}...` : toTitleCase(sanitized) || 'Voice Transaction';
}

/**
 * Determines whether transaction is Debit or Credit
 */
function extractTransactionType(transcript: string): TransactionType {
  const lower = transcript.toLowerCase();
  for (const word of CREDIT_KEYWORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      return 'Credit';
    }
  }
  return 'Debit';
}

/**
 * Parses natural spoken voice transcripts into structured Transaction data.
 *
 * @param transcript - Natural spoken sentence (e.g., 'Spent 650 at Starbucks for cold brew')
 * @returns Partial<Transaction> with all extracted fields and safe fallbacks
 */
export function parseVoiceToTransaction(transcript: string): Partial<Transaction> {
  if (!transcript || typeof transcript !== 'string') {
    return {
      amountMinor: 0,
      title: 'Voice Transaction',
      category: 'Others',
      paidTo: 'Unknown Merchant',
      accountInfo: 'Cash/Default',
      transactionType: 'Debit',
      timestamp: new Date().toISOString(),
      source: 'Voice-only',
    };
  }

  const trimmed = transcript.trim();
  const amountMinor = extractAmountMinor(trimmed);
  const category = extractCategory(trimmed);
  const paidTo = extractPaidTo(trimmed);
  const title = extractTitle(trimmed, paidTo, category);
  const transactionType = extractTransactionType(trimmed);

  return {
    amountMinor,
    title,
    category,
    paidTo,
    accountInfo: 'Cash/Default',
    transactionType,
    timestamp: new Date().toISOString(),
    source: 'Voice-only',
  };
}
