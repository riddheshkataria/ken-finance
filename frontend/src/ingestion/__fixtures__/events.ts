/**
 * Fixture corpus for the ingestion pipeline.
 *
 * All account numbers, names and reference numbers are fabricated —
 * never commit real message data (rules.md §9).
 *
 * Reject cases matter as much as parse cases: a promotional SMS or an OTP
 * silently becoming a ₹5,000 "transaction" is worse than missing a payment.
 */
import type { IngestionEvent, RejectionReason } from '../types';

/** 2026-09-01T12:00:00Z — fixed so timestamp assertions are deterministic. */
export const FIXED_NOW = Date.parse('2026-09-01T12:00:00.000Z');

export interface ParseCase {
  name: string;
  event: IngestionEvent;
  expect: {
    amountMinor: number;
    transactionType: 'Debit' | 'Credit';
    paidTo?: string;
    accountTail?: string | null;
    refNo?: string | null;
    category?: string;
  };
}

export interface RejectCase {
  name: string;
  event: IngestionEvent;
  reason: RejectionReason;
}

const sms = (origin: string, body: string): IngestionEvent => ({
  channel: 'sms',
  origin,
  body,
  receivedAt: FIXED_NOW,
});

const notification = (
  origin: string,
  title: string,
  body: string,
): IngestionEvent => ({
  channel: 'notification',
  origin,
  title,
  body,
  receivedAt: FIXED_NOW,
});

export const PARSE_CASES: ParseCase[] = [
  {
    name: 'HDFC UPI debit',
    event: sms(
      'AD-HDFCBK',
      'Sent Rs.240.00 From HDFC Bank A/C x1234 To SWIGGY On 01/09/26 Ref 412345678901. Not You? Call 18002586161',
    ),
    expect: {
      amountMinor: 24000,
      transactionType: 'Debit',
      paidTo: 'SWIGGY',
      accountTail: '1234',
      refNo: '412345678901',
      category: 'Dining',
    },
  },
  {
    name: 'SBI UPI debit with alpha date',
    event: sms(
      'VK-SBIINB',
      'Dear UPI user A/C X5678 debited by 1250.0 on date 01Sep26 trf to BIG BAZAAR Refno 512345678902. If not u? call 1800111109',
    ),
    expect: {
      amountMinor: 125000,
      transactionType: 'Debit',
      accountTail: '5678',
      refNo: '512345678902',
    },
  },
  {
    name: 'ICICI VPA debit',
    event: sms(
      'JD-ICICIB',
      'INR 240.50 debited from A/c XX9012 on 01-09-26 to VPA swiggy@ybl (UPI Ref 612345678903). Avl Bal INR 11,760.00',
    ),
    expect: {
      amountMinor: 24050,
      transactionType: 'Debit',
      paidTo: 'swiggy@ybl',
      accountTail: '9012',
      refNo: '612345678903',
      category: 'Dining',
    },
  },
  {
    name: 'credit from a person',
    event: sms(
      'AD-KOTAKB',
      'Your A/c XX3456 is credited with Rs.5,000.00 on 01-09-26 by RAHUL SHARMA. UPI Ref no 712345678904',
    ),
    expect: {
      amountMinor: 500000,
      transactionType: 'Credit',
      accountTail: '3456',
      refNo: '712345678904',
      category: 'P2P Transfer',
    },
  },
  {
    name: 'GPay notification — cleanest merchant name',
    event: notification(
      'com.google.android.apps.nbu.paisa.user',
      'Paid ₹240 to Swiggy',
      'Using HDFC Bank ****1234',
    ),
    expect: {
      amountMinor: 24000,
      transactionType: 'Debit',
      paidTo: 'Swiggy',
      category: 'Dining',
    },
  },
  {
    name: 'PhonePe notification',
    event: notification(
      'com.phonepe.app',
      'Payment successful',
      'You paid ₹1,499 to Blinkit',
    ),
    expect: {
      amountMinor: 149900,
      transactionType: 'Debit',
      paidTo: 'Blinkit',
      category: 'Grocery',
    },
  },
  {
    name: 'bank SMS surfaced through the messaging app notification',
    event: notification(
      'com.google.android.apps.messaging',
      'AD-HDFCBK',
      'Sent Rs.85.00 From HDFC Bank A/C x1234 To UBER INDIA On 01/09/26 Ref 812345678905',
    ),
    expect: {
      amountMinor: 8500,
      transactionType: 'Debit',
      paidTo: 'UBER INDIA',
      refNo: '812345678905',
      category: 'Transport',
    },
  },
  {
    name: 'balance mentioned after the amount is not mistaken for it',
    event: sms(
      'AD-AXISBK',
      'Rs.99.00 debited from A/c XX7777 on 01-09-26. Avl Bal Rs.45,231.75. Ref 912345678906',
    ),
    expect: {
      amountMinor: 9900,
      transactionType: 'Debit',
      accountTail: '7777',
      refNo: '912345678906',
    },
  },
];

export const REJECT_CASES: RejectCase[] = [
  {
    name: 'OTP must never become a transaction',
    event: sms(
      'AD-HDFCBK',
      '123456 is the OTP for your transaction of Rs.5,000.00 at AMAZON. Do not share this with anyone.',
    ),
    reason: 'otp',
  },
  {
    name: 'loan promotion',
    event: sms(
      'AD-HDFCBK',
      'You are pre-approved for a personal loan of Rs.5,00,000 at lowest interest. Apply now!',
    ),
    reason: 'promotional',
  },
  {
    name: 'collect request is money asked for, not paid',
    event: sms(
      'VM-PAYTMB',
      'RAHUL SHARMA has requested Rs.500.00 via UPI. Approve to pay before it expires.',
    ),
    reason: 'payment-request',
  },
  {
    name: 'failed transaction',
    event: sms(
      'AD-ICICIB',
      'Your transaction of Rs.2,400.00 to SWIGGY has failed. The amount will be refunded.',
    ),
    reason: 'failed-or-reversed',
  },
  {
    name: 'balance alert with no movement',
    event: sms(
      'AD-HDFCBK',
      'Avl Bal in your A/c XX1234 is Rs.45,231.75 as on 01-09-26.',
    ),
    reason: 'balance-only',
  },
  {
    name: 'upcoming autopay mandate has not happened yet',
    event: sms(
      'AD-HDFCBK',
      'Rs.499.00 will be debited from A/c XX1234 on 05-09-26 towards NETFLIX autopay.',
    ),
    reason: 'future-dated',
  },
  {
    name: 'notification from an app outside the allowlist',
    event: notification('com.whatsapp', 'Rahul', 'send me ₹500 for dinner'),
    reason: 'not-financial',
  },
];

/** Same real-world payment seen on both channels — must collapse to one row. */
export const DUPLICATE_PAIR = {
  notification: notification(
    'com.google.android.apps.nbu.paisa.user',
    'Paid ₹240 to Swiggy',
    'Using HDFC Bank ****1234',
  ),
  sms: sms(
    'AD-HDFCBK',
    'Sent Rs.240.00 From HDFC Bank A/C x1234 To SWIGGY On 01/09/26 Ref 412345678901',
  ),
};
