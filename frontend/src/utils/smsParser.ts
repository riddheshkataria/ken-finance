import type { Transaction, TransactionCategory, TransactionType } from '../types/transaction';

/**
 * Common Indian Bank Sender IDs and patterns
 */
export const BANK_HEADER_PATTERNS = [
  /HDFC/i, /SBI/i, /ICICI/i, /AXIS/i, /KOTAK/i, /PNB/i, /BOB/i,
  /CANARA/i, /CANBNK/i, /UNIONB/i, /IDFC/i, /INDUS/i, /YESBNK/i,
  /RBL/i, /PAYTM/i, /AMEX/i, /CITI/i, /FEDERAL/i, /HSBC/i, /SCBANK/i,
  /CENTBK/i, /IOB/i, /UBI/i, /AUBNK/i, /BANDHAN/i
];

/**
 * Checks whether an incoming SMS sender/header is from a recognized financial institution
 */
export function isBankSms(sender: string, body?: string): boolean {
  if (!sender && !body) return false;

  // 1. Check sender header (e.g. "AD-HDFCBK", "JM-ICICIB", "VK-SBIINB")
  if (sender) {
    for (const pattern of BANK_HEADER_PATTERNS) {
      if (pattern.test(sender)) {
        return true;
      }
    }
  }

  // 2. Check body keywords if sender is masked or generic
  if (body) {
    const isFinancial =
      /(?:debited|credited|spent|withdrawn|sent\s+rs|received\s+rs|txn|a\/c\s+no|acct|vpa|upi\s+ref)/i.test(body);
    const mentionsCurrency = /(?:rs\.?|inr|₹)\s*[\d,]+(?:\.\d+)?/i.test(body);
    return isFinancial && mentionsCurrency;
  }

  return false;
}

/**
 * Extracts bank name prioritizing sender header over body text
 */
function extractBankName(sender: string, body: string): string {
  const checkBank = (text: string) => {
    if (/HDFC/i.test(text)) return 'HDFC';
    if (/SBI/i.test(text)) return 'SBI';
    if (/ICICI/i.test(text)) return 'ICICI';
    if (/AXIS/i.test(text)) return 'AXIS';
    if (/KOTAK/i.test(text)) return 'KOTAK';
    if (/IDFC/i.test(text)) return 'IDFC';
    if (/PNB/i.test(text)) return 'PNB';
    if (/BOB/i.test(text)) return 'BOB';
    if (/PAYTM/i.test(text)) return 'Paytm';
    if (/YES/i.test(text)) return 'Yes Bank';
    if (/INDUS/i.test(text)) return 'IndusInd';
    if (/RBL/i.test(text)) return 'RBL';
    if (/AMEX/i.test(text)) return 'Amex';
    return null;
  };

  return checkBank(sender) || checkBank(body) || 'Bank';
}

/**
 * Extracts account number digits (e.g. "A/C *4392", "XX1234", "Card XX8821")
 */
function extractAccountInfo(sender: string, body: string): string {
  const bankName = extractBankName(sender, body);

  const patterns = [
    /(?:a\/c|acct|acc|card|ending\s+with|ending\s+in|ending|no\.?)\s*(?:no\.?)?\s*[*xX.-]*\s*(\d{3,4})\b/i,
    /(?:[*xX]{2,})(\d{3,4})\b/i,
    /\bA\/c\s+(\d{3,4})\b/i,
  ];

  for (const regex of patterns) {
    const match = body.match(regex);
    if (match && match[1]) {
      return `${bankName} - ${match[1]}`;
    }
  }

  return `${bankName} Account`;
}

/**
 * Extracts numeric transaction amount from SMS
 */
function extractAmount(body: string): number {
  const patterns = [
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:debited|credited|spent|paid|withdrawn|transferred)\s+(?:by\s+)?(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|inr|₹)/i,
  ];

  for (const regex of patterns) {
    const match = body.match(regex);
    if (match && match[1]) {
      const rawNum = match[1].replace(/,/g, '');
      const val = parseFloat(rawNum);
      if (!isNaN(val) && val > 0) {
        return val;
      }
    }
  }

  return 0;
}

/**
 * Determines transaction type ('Debit' | 'Credit')
 */
function extractTransactionType(body: string): TransactionType {
  const lower = body.toLowerCase();

  if (
    lower.includes('credited') ||
    lower.includes('credit to') ||
    lower.includes('received rs') ||
    lower.includes('refund') ||
    lower.includes('cashback') ||
    lower.includes('deposited')
  ) {
    return 'Credit';
  }

  return 'Debit';
}

/**
 * Extracts recipient / merchant / VPA name from SMS body
 */
function extractPaidTo(body: string, isCredit: boolean): string {
  // 1. UPI VPA pattern: e.g. "to VPA swiggy@icici", "from rahul@oksbi"
  const vpaMatch = body.match(/(?:to\s+(?:vpa\s+)?|from\s+(?:vpa\s+)?|vpa\s*[:\s]+)([a-zA-Z0-9._-]+@[a-zA-Z0-9]+)/i);
  if (vpaMatch && vpaMatch[1]) {
    return vpaMatch[1].trim();
  }

  // 2. "to [Merchant/Person] on", "at [Merchant] on", "info: [Merchant]"
  const merchantPatterns = [
    /(?:at|to|info:?|towards|info\/)\s+([A-Za-z0-9&.\s'-]+?)(?=\s+(?:on|via|ref|upi|avl|avbl|bal|limit|balance|dated|\.|$))/i,
    /(?:transfer\s+to|paid\s+to|sent\s+to)\s+([A-Za-z0-9&.\s'-]+?)(?=\s+(?:on|via|ref|upi|avl|avbl|\.|$))/i,
    /(?:from\s+a\/c\s+linked\s+to\s+vpa\s+)([A-Za-z0-9&.\s'-]+?)(?=\s+(?:on|via|ref|upi|\.|$))/i,
  ];

  for (const regex of merchantPatterns) {
    const match = body.match(regex);
    if (match && match[1]) {
      const candidate = match[1].replace(/[.,/#!$%^&*;:{}=\-_`~()]+$/, '').trim();
      if (
        candidate &&
        !['your', 'the', 'account', 'vpa', 'card', 'bank', 'upi', 'atm'].includes(candidate.toLowerCase()) &&
        candidate.length > 1
      ) {
        return candidate.toUpperCase();
      }
    }
  }

  return isCredit ? 'Sender via Bank' : 'Merchant / Recipient';
}

/**
 * Automatically infers transaction category from merchant or keywords
 */
function inferCategory(paidTo: string, body: string, isCredit: boolean): TransactionCategory {
  const text = `${paidTo} ${body}`.toLowerCase();

  if (isCredit) {
    return 'P2P Transfer';
  }

  if (/swiggy|zomato|starbucks|mcdonald|dominos|kfc|cafe|restaurant|food|burger|pizza|dine|bakery/i.test(text)) {
    return 'Dining';
  }
  if (/instamart|blinkit|zepto|bigbasket|supermarket|grocery|groceries|dmart|milk/i.test(text)) {
    return 'Grocery';
  }
  if (/uber|ola|rapido|cab|petrol|fuel|metro|irctc|fastag|toll|parking|flight/i.test(text)) {
    return 'Transport';
  }
  if (/rent|landlord|flat rent|house rent|society maintenance/i.test(text)) {
    return 'Rent';
  }
  if (/electricity|bescom|tata power|bill|wifi|airtel|jio|vi|recharge|dth|broadband|gas/i.test(text)) {
    return 'Bills';
  }
  if (/zerodha|groww|mutual fund|sip|stock|angelone|coin|investment/i.test(text)) {
    return 'Investment';
  }
  if (/@upi|@ok|@icici|@hdfc|transfer|p2p/i.test(paidTo) || /transfer to|sent to/i.test(body)) {
    return 'P2P Transfer';
  }

  return 'Others';
}

/**
 * Parses an incoming bank SMS alert into a structured Partial<Transaction>.
 *
 * @param sender - The SMS sender header (e.g., 'AD-HDFCBK', 'VK-SBIINB')
 * @param body - The text message body
 * @returns Partial<Transaction> or null if message is not a financial transaction alert
 */
export function parseBankSms(sender: string, body: string): Partial<Transaction> | null {
  if (!body || !isBankSms(sender, body)) {
    return null;
  }

  const amount = extractAmount(body);
  if (amount <= 0) {
    return null;
  }

  const transactionType = extractTransactionType(body);
  const isCredit = transactionType === 'Credit';
  const accountInfo = extractAccountInfo(sender, body);
  const paidTo = extractPaidTo(body, isCredit);
  const category = inferCategory(paidTo, body, isCredit);

  const title = isCredit
    ? `Received from ${paidTo}`
    : `Payment to ${paidTo}`;

  return {
    amount,
    title,
    category,
    paidTo,
    accountInfo,
    transactionType,
    timestamp: new Date().toISOString(),
    source: 'SMS-parsed',
  };
}

