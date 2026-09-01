import type { Transaction } from '../types/transaction';

/**
 * Maximum timestamp difference allowed for matching (10 minutes in milliseconds)
 */
export const RECONCILIATION_TIME_WINDOW_MS = 10 * 60 * 1000;

/**
 * Maximum floating point tolerance for amount comparison (e.g. ₹1.00)
 */
export const AMOUNT_TOLERANCE = 1.0;

/**
 * Minimum normalized string similarity score (0.0 to 1.0)
 */
export const STRING_SIMILARITY_THRESHOLD = 0.35;

/**
 * Computes the Levenshtein edit distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();

  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[s1.length][s2.length];
}

/**
 * Computes normalized similarity between 0.0 (completely different) and 1.0 (exact match)
 */
export function calculateStringSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  // Substring match bonus (e.g., "Starbucks" inside "STARBUCKS COFFEE INDIA")
  if (s1.includes(s2) || s2.includes(s1)) {
    return 0.85;
  }

  // Handle VPA matching (e.g., "swiggy" in "swiggy@icici")
  const prefix1 = s1.split('@')[0];
  const prefix2 = s2.split('@')[0];
  if (prefix1.includes(prefix2) || prefix2.includes(prefix1)) {
    return 0.80;
  }

  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);

  return Math.max(0, 1 - distance / maxLength);
}

/**
 * Cleans and formats merchant name for merged record
 */
function cleanMerchantName(voicePaidTo: string, smsPaidTo: string): string {
  // If SMS has a VPA, prioritize cleaner voice merchant or strip VPA domain
  if (smsPaidTo.includes('@')) {
    if (voicePaidTo && voicePaidTo !== 'Unknown Merchant' && voicePaidTo !== 'Voice Input') {
      return voicePaidTo;
    }
    return smsPaidTo.split('@')[0].toUpperCase();
  }

  if (voicePaidTo && voicePaidTo !== 'Unknown Merchant' && voicePaidTo !== 'Voice Input') {
    return voicePaidTo;
  }

  return smsPaidTo;
}

/**
 * Result of a single reconciliation match attempt
 */
export interface ReconciliationMatchResult {
  isMatched: boolean;
  matchScore: number;
  matchedVoiceTransaction?: Transaction;
  mergedTransaction?: Transaction;
}

/**
 * Evaluates whether a Voice-only transaction matches an SMS-parsed transaction
 */
export function evaluateMatch(
  voiceTx: Transaction,
  smsTx: Transaction
): { isMatch: boolean; score: number } {
  // 1. Must be Voice-only and SMS-parsed
  if (voiceTx.source !== 'Voice-only' || smsTx.source !== 'SMS-parsed') {
    return { isMatch: false, score: 0 };
  }

  // 2. Timestamp within +/- 10 minutes
  const voiceTime = new Date(voiceTx.timestamp).getTime();
  const smsTime = new Date(smsTx.timestamp).getTime();
  const timeDiff = Math.abs(voiceTime - smsTime);

  if (timeDiff > RECONCILIATION_TIME_WINDOW_MS) {
    return { isMatch: false, score: 0 };
  }

  // 3. Amount parity check (within minor tolerance)
  const amountDiff = Math.abs(voiceTx.amount - smsTx.amount);
  if (amountDiff > AMOUNT_TOLERANCE) {
    return { isMatch: false, score: 0 };
  }

  // 4. String similarity on paidTo / merchant name
  const merchantSimilarity = calculateStringSimilarity(voiceTx.paidTo, smsTx.paidTo);
  const titleSimilarity = calculateStringSimilarity(voiceTx.title, smsTx.paidTo);
  const maxSimilarity = Math.max(merchantSimilarity, titleSimilarity);

  // If generic "Voice Input" or "Unknown Merchant" was used in voice, allow match if amount & time match
  const isGenericVoiceMerchant =
    voiceTx.paidTo === 'Voice Input' || voiceTx.paidTo === 'Unknown Merchant';

  const isMatch = isGenericVoiceMerchant || maxSimilarity >= STRING_SIMILARITY_THRESHOLD;

  // Composite match score (0 - 100)
  const timeScore = 1 - timeDiff / RECONCILIATION_TIME_WINDOW_MS;
  const compositeScore = (isGenericVoiceMerchant ? 0.7 : maxSimilarity) * 0.6 + timeScore * 0.4;

  return { isMatch, score: compositeScore };
}

/**
 * Merges a matched Voice transaction and SMS transaction into a consolidated record.
 */
export function mergeTransactions(voiceTx: Transaction, smsTx: Transaction): Transaction {
  return {
    id: smsTx.id || voiceTx.id,
    amount: smsTx.amount, // SMS amount (source of truth)
    title: voiceTx.title, // Voice title (rich user context)
    category: voiceTx.category, // Voice category
    paidTo: cleanMerchantName(voiceTx.paidTo, smsTx.paidTo), // Cleaned merchant name
    accountInfo: smsTx.accountInfo, // SMS account identifier (e.g. 'HDFC - 4392')
    transactionType: smsTx.transactionType, // SMS type
    timestamp: smsTx.timestamp, // SMS timestamp
    source: 'Merged', // Marked as Merged
  };
}

/**
 * Reconciles an incoming SMS-parsed transaction against a pool of existing transactions.
 * Returns the merged transaction and the ID of the matched voice transaction to replace.
 */
export function reconcileIncomingSms(
  smsTx: Transaction,
  existingTransactions: Transaction[]
): ReconciliationMatchResult {
  const voiceCandidates = existingTransactions.filter((tx) => tx.source === 'Voice-only');

  let bestMatch: Transaction | null = null;
  let highestScore = -1;

  for (const voiceCandidate of voiceCandidates) {
    const { isMatch, score } = evaluateMatch(voiceCandidate, smsTx);
    if (isMatch && score > highestScore) {
      highestScore = score;
      bestMatch = voiceCandidate;
    }
  }

  if (bestMatch) {
    const merged = mergeTransactions(bestMatch, smsTx);
    return {
      isMatched: true,
      matchScore: highestScore,
      matchedVoiceTransaction: bestMatch,
      mergedTransaction: merged,
    };
  }

  return {
    isMatched: false,
    matchScore: 0,
  };
}

/**
 * Reconciles an entire list of transactions, merging all valid Voice + SMS pairs.
 */
export function reconcileTransactionList(transactions: Transaction[]): {
  reconciledList: Transaction[];
  mergedCount: number;
} {
  const voiceList = transactions.filter((t) => t.source === 'Voice-only');
  const smsList = transactions.filter((t) => t.source === 'SMS-parsed');
  const others = transactions.filter((t) => t.source === 'Merged');

  const matchedVoiceIds = new Set<string>();
  const mergedResults: Transaction[] = [];
  const unmatchedSms: Transaction[] = [];

  for (const sms of smsList) {
    // Find matching unmatched voice candidate
    const eligibleVoice = voiceList.filter((v) => !matchedVoiceIds.has(v.id));
    const result = reconcileIncomingSms(sms, eligibleVoice);

    if (result.isMatched && result.matchedVoiceTransaction && result.mergedTransaction) {
      matchedVoiceIds.add(result.matchedVoiceTransaction.id);
      mergedResults.push(result.mergedTransaction);
    } else {
      unmatchedSms.push(sms);
    }
  }

  const remainingVoice = voiceList.filter((v) => !matchedVoiceIds.has(v.id));

  // Sort descending by timestamp
  const reconciledList = [...mergedResults, ...others, ...unmatchedSms, ...remainingVoice].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return {
    reconciledList,
    mergedCount: mergedResults.length,
  };
}

