/**
 * Shared shapes for the unified ingestion pipeline.
 *
 * Both channels — bank SMS and posted notifications — normalise into a single
 * IngestionEvent so there is exactly one parsing path (rules.md §4).
 */
import type { IngestionChannel, ParsedBankEvent } from '../types/transaction';

export interface IngestionEvent {
  channel: Extract<IngestionChannel, 'sms' | 'notification'>;

  /**
   * SMS sender header ("AD-HDFCBK") or the notification's source package
   * ("com.google.android.apps.nbu.paisa.user").
   */
  origin: string;

  /** Notification title, if any. Often carries the amount on UPI apps. */
  title?: string;

  /** SMS body, or the notification's text / bigText. */
  body: string;

  /** Epoch millis at which the event was observed on-device. */
  receivedAt: number;
}

/** Why an event was discarded, kept for debugging and fixture assertions. */
export type RejectionReason =
  | 'not-financial'
  | 'otp'
  | 'promotional'
  | 'balance-only'
  | 'failed-or-reversed'
  | 'payment-request'
  | 'future-dated'
  | 'no-amount';

export type IngestionResult =
  | { ok: true; event: ParsedBankEvent }
  | { ok: false; reason: RejectionReason };
