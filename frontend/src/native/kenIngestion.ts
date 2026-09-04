/**
 * JS bridge to the Kotlin ingestion module.
 *
 * The native side owns both capture channels — the SMS BroadcastReceiver and
 * the NotificationListenerService — and writes what it sees into a staging
 * buffer. JS drains that buffer; it is never on the capture hot path
 * (rules.md §7).
 *
 * Every function here degrades gracefully when the native module is absent
 * (web, or a build without the module linked) so the app still runs.
 */
import {
  Alert,
  Linking,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import { requireOptionalNativeModule, EventEmitter } from 'expo-modules-core';
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

  /** Voice notes recorded by the native capture sheet, awaiting attachment. */
  drainVoiceNotes(): Promise<NativeVoiceNote[]>;

  /** Transaction ids the user skipped from the widget while JS was dead. */
  drainSkips(): Promise<string[]>;

  /** Pushes the current queue head to the home-screen widget. */
  updateWidget(
    transactionId: string | null,
    amountMinor: number | null,
    merchant: string | null,
    pendingCount: number,
  ): Promise<void>;

  /** Dev affordance: pushes a fake event through the real native path. */
  simulateEvent(
    channel: 'sms' | 'notification',
    origin: string,
    title: string | null,
    body: string,
  ): Promise<void>;
}

export interface NativeVoiceNote {
  /** null means the note belongs to whatever is at the head of the queue. */
  transactionId: string | null;
  transcript: string;
  audioPath: string | null;
  capturedAt: number;
}

export interface WidgetPayload {
  transactionId: string | null;
  amountMinor: number | null;
  merchant: string | null;
  pendingCount: number;
}

const expoKenModule =
  requireOptionalNativeModule<KenIngestionNativeModule>('KenIngestion');
const legacyKenModule =
  NativeModules.KenIngestion as KenIngestionNativeModule | undefined;

const nativeModule: KenIngestionNativeModule | null =
  expoKenModule ?? legacyKenModule ?? null;

const expoEmitter = expoKenModule ? new EventEmitter(expoKenModule as any) : null;

export const isNativeIngestionAvailable = (): boolean =>
  Platform.OS === 'android';

/** Emitted when a payment is captured while the app is in the foreground. */
export const INGESTION_EVENT = 'KenIngestion.event';

export function addIngestionListener(
  handler: (event: NativeIngestionEvent) => void,
): { remove: () => void } {
  if (!isNativeIngestionAvailable() || !nativeModule) {
    return { remove: () => undefined };
  }

  if (expoEmitter) {
    return (expoEmitter as any).addListener(INGESTION_EVENT, handler);
  }

  const legacyEmitter = new NativeEventEmitter(
    nativeModule as unknown as never,
  );
  return legacyEmitter.addListener(INGESTION_EVENT, handler);
}

/**
 * RECEIVE_SMS and READ_SMS are runtime permissions on Android.
 * If not granted or blocked, prompts user to open system App Settings.
 */
export async function requestSmsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    Alert.alert('SMS Access', 'SMS ingestion is only available on Android devices.');
    return false;
  }

  try {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
      PermissionsAndroid.PERMISSIONS.READ_SMS,
    ]);

    const isGranted =
      granted[PermissionsAndroid.PERMISSIONS.RECEIVE_SMS] ===
        PermissionsAndroid.RESULTS.GRANTED &&
      granted[PermissionsAndroid.PERMISSIONS.READ_SMS] ===
        PermissionsAndroid.RESULTS.GRANTED;

    if (!isGranted) {
      const receiveStatus = granted[PermissionsAndroid.PERMISSIONS.RECEIVE_SMS];
      const readStatus = granted[PermissionsAndroid.PERMISSIONS.READ_SMS];

      if (
        receiveStatus === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ||
        readStatus === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      ) {
        Alert.alert(
          'SMS Permission Required',
          'To capture bank transactions, please enable SMS permissions in App Settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void Linking.openSettings() },
          ],
        );
      }
    }

    return isGranted;
  } catch (error) {
    console.warn('[ken] Error requesting SMS permission:', error);
    await Linking.openSettings();
    return false;
  }
}

export async function hasSmsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (nativeModule) {
    return nativeModule.hasSmsPermission();
  }
  try {
    const [receive, read] = await Promise.all([
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECEIVE_SMS),
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS),
    ]);
    return receive && read;
  } catch {
    return false;
  }
}

export async function hasNotificationAccess(): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.hasNotificationAccess();
}

/**
 * Directly opens Android's Notification Listener Settings screen where
 * the user can grant special notification access to Ken Finance.
 */
export async function openNotificationAccessSettings(): Promise<void> {
  if (nativeModule) {
    try {
      await nativeModule.openNotificationAccessSettings();
      return;
    } catch {
      // Fallback to Linking intent
    }
  }

  if (Platform.OS === 'android') {
    try {
      await Linking.sendIntent('android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS');
      return;
    } catch {
      await Linking.openSettings();
      return;
    }
  }

  await Linking.openSettings();
}

export async function drainInbox(): Promise<NativeIngestionEvent[]> {
  if (!nativeModule) return [];
  return nativeModule.drainInbox();
}

export async function drainVoiceNotes(): Promise<NativeVoiceNote[]> {
  if (!nativeModule) return [];
  return nativeModule.drainVoiceNotes();
}

export async function drainSkips(): Promise<string[]> {
  if (!nativeModule) return [];
  return nativeModule.drainSkips();
}

export async function updateWidget(payload: WidgetPayload): Promise<void> {
  if (!nativeModule) return;
  return nativeModule.updateWidget(
    payload.transactionId,
    payload.amountMinor,
    payload.merchant,
    payload.pendingCount,
  );
}

/**
 * Pushes a fabricated event through the real native path.
 * Useful in Android Studio, where the emulator can also send genuine SMS via
 * Extended Controls but cannot produce UPI app notifications.
 */
export async function simulateEvent(event: NativeIngestionEvent): Promise<void> {
  if (!nativeModule) return;
  return nativeModule.simulateEvent(
    event.channel,
    event.origin,
    event.title ?? null,
    event.body,
  );
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
