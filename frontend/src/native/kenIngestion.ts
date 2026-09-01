/**
 * JS bridge to the Kotlin ingestion module.
 *
 * The native side owns both capture channels — the SMS BroadcastReceiver and
 * the NotificationListenerService — and writes what it sees into a Room
 * staging table. JS drains that table; it is never on the capture hot path
 * (rules.md §7).
 *
 * Every function here degrades gracefully when the native module is absent
 * (web, or a build without the module linked) so the app still runs.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { IngestionEvent } from '../ingestion/types';

/** Shape the Kotlin module emits and stores. */
export interface NativeIngestionEvent {
  channel: 'sms' | 'notification';
  origin: string;
  title?: string;
  body: string;
  receivedAt: number;
}

interface KenIngestionNativeModule {
  /** Runtime SMS permissions. Resolves false if the user declines. */
  requestSmsPermission(): Promise<boolean>;
  hasSmsPermission(): Promise<boolean>;

  /**
   * Notification access cannot be granted by a dialog — it lives in
   * Settings > Special app access. This only reports current state.
   */
  hasNotificationAccess(): Promise<boolean>;

  /** Opens the system settings screen where notification access is granted. */
  openNotificationAccessSettings(): Promise<void>;

  /** Returns and clears everything captured while JS was not running. */
  drainInbox(): Promise<NativeIngestionEvent[]>;

  /** Pushes the current queue head to the home-screen widget. */
  updateWidget(payload: {
    transactionId: string | null;
    amountMinor: number | null;
    merchant: string | null;
    pendingCount: number;
  }): Promise<void>;
}

const nativeModule: KenIngestionNativeModule | undefined =
  NativeModules.KenIngestion;

export const isNativeIngestionAvailable = (): boolean =>
  Platform.OS === 'android' && nativeModule !== undefined;

/** Emitted when a payment is captured while the app is in the foreground. */
export const INGESTION_EVENT = 'KenIngestion.event';

export function addIngestionListener(
  handler: (event: NativeIngestionEvent) => void,
): { remove: () => void } {
  if (!isNativeIngestionAvailable() || !nativeModule) {
    return { remove: () => undefined };
  }

  const emitter = new NativeEventEmitter(
    NativeModules.KenIngestion as unknown as never,
  );
  return emitter.addListener(INGESTION_EVENT, handler);
}

export async function requestSmsPermission(): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.requestSmsPermission();
}

export async function hasSmsPermission(): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.hasSmsPermission();
}

export async function hasNotificationAccess(): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.hasNotificationAccess();
}

export async function openNotificationAccessSettings(): Promise<void> {
  if (!nativeModule) return;
  return nativeModule.openNotificationAccessSettings();
}

export async function drainInbox(): Promise<NativeIngestionEvent[]> {
  if (!nativeModule) return [];
  return nativeModule.drainInbox();
}

export async function updateWidget(payload: {
  transactionId: string | null;
  amountMinor: number | null;
  merchant: string | null;
  pendingCount: number;
}): Promise<void> {
  if (!nativeModule) return;
  return nativeModule.updateWidget(payload);
}

/** Normalises a native event into the shape the parser expects. */
export function toIngestionEvent(event: NativeIngestionEvent): IngestionEvent {
  return {
    channel: event.channel,
    origin: event.origin,
    title: event.title,
    body: event.body,
    receivedAt: event.receivedAt,
  };
}
