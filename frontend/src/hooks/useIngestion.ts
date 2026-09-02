/**
 * Subscribes to both ingestion channels and feeds them into the store.
 *
 * Both run concurrently by design: SMS covers banks that only text, and the
 * notification listener covers UPI apps (cleaner merchant names, usually
 * faster) and keeps working if SMS permission is ever unavailable. Dedupe in
 * `ingestion/dedupe.ts` is what makes running both safe.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useTransactionStore } from '../store/useTransactionStore';
import type { IngestionOutcome } from '../ingestion/ingest';
import type { IngestionEvent } from '../ingestion/types';
import {
  addIngestionListener,
  drainInbox,
  drainSkips,
  drainVoiceNotes,
  updateWidget,
  hasNotificationAccess,
  hasSmsPermission,
  isNativeIngestionAvailable,
  openNotificationAccessSettings,
  requestSmsPermission,
  toIngestionEvent,
  type NativeIngestionEvent,
} from '../native/kenIngestion';

export interface IngestionPermissions {
  /** null while still being determined. */
  sms: boolean | null;
  notifications: boolean | null;
}

export interface UseIngestionResult {
  available: boolean;
  permissions: IngestionPermissions;
  lastOutcome: IngestionOutcome | null;
  requestSms: () => Promise<boolean>;
  openNotificationSettings: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
  /** Feeds a synthetic event through the real pipeline, for dev and tests. */
  simulate: (event: IngestionEvent) => IngestionOutcome;
}

export function useIngestion(): UseIngestionResult {
  const ingest = useTransactionStore((state) => state.ingest);
  const [permissions, setPermissions] = useState<IngestionPermissions>({
    sms: null,
    notifications: null,
  });
  const [lastOutcome, setLastOutcome] = useState<IngestionOutcome | null>(null);

  // Held in a ref so the AppState subscription never closes over a stale
  // version of the store action.
  const ingestRef = useRef(ingest);
  ingestRef.current = ingest;

  const available = isNativeIngestionAvailable();

  const refreshPermissions = useCallback(async () => {
    if (!available) {
      setPermissions({ sms: false, notifications: false });
      return;
    }
    const [sms, notifications] = await Promise.all([
      hasSmsPermission(),
      hasNotificationAccess(),
    ]);
    setPermissions({ sms, notifications });
  }, [available]);

  const requestSms = useCallback(async () => {
    if (!available) return false;
    const granted = await requestSmsPermission();
    setPermissions((current) => ({ ...current, sms: granted }));
    return granted;
  }, [available]);

  const openNotificationSettings = useCallback(async () => {
    // Notification access can only be granted in system settings, never by a
    // dialog — so this navigates the user there rather than prompting.
    await openNotificationAccessSettings();
  }, []);

  const simulate = useCallback((event: IngestionEvent) => {
    const outcome = ingestRef.current(event);
    setLastOutcome(outcome);
    return outcome;
  }, []);

  /** Keeps the widget showing the real queue head and backlog count. */
  const pushQueueToWidget = useCallback(async () => {
    if (!available) return;

    const store = useTransactionStore.getState();
    const queue = store.getQueue();
    const head = queue[0] ?? null;

    await updateWidget({
      transactionId: head?.id ?? null,
      amountMinor: head?.amountMinor ?? null,
      merchant: head?.paidTo ?? null,
      pendingCount: queue.length,
    });
  }, [available]);

  /**
   * Drains everything the native side captured while JS was not running, in
   * dependency order: payments first, then the notes and skips that refer to
   * them, then push the resulting queue head back to the widget.
   */
  const drain = useCallback(async () => {
    if (!available) return;

    const pending = await drainInbox();
    for (const nativeEvent of pending) {
      setLastOutcome(ingestRef.current(toIngestionEvent(nativeEvent)));
    }

    const store = useTransactionStore.getState();

    // A note captured with no transaction id was recorded from the widget
    // against whatever was at the head of the queue at that moment.
    for (const note of await drainVoiceNotes()) {
      const target = store.getCaptureTarget(note.transactionId ?? undefined);
      if (!target) continue;
      store.attachNote(target.id, {
        text: note.transcript,
        transcript: note.transcript,
        audioPath: note.audioPath,
      });
    }

    for (const skippedId of await drainSkips()) {
      store.skipInQueue(skippedId);
    }

    // Items nobody is going to answer stop being offered on the widget.
    store.retireStaleQueueItems();

    await pushQueueToWidget();

    // Last tier, and the only one that costs money — it self-filters to
    // merchants the free tiers could not answer, and is fire-and-forget so a
    // slow or absent backend never delays the widget update above.
    void store.categorizePending();
  }, [available, pushQueueToWidget]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      setPermissions({ sms: false, notifications: false });
      return;
    }

    void refreshPermissions();
    void drain();

    const subscription = addIngestionListener((event: NativeIngestionEvent) => {
      setLastOutcome(ingestRef.current(toIngestionEvent(event)));
      // The widget must reflect the new queue head immediately, not on the
      // next foreground — this is the whole point of capturing at payment.
      void pushQueueToWidget();
    });

    // Anything captured while the app was backgrounded is in the native buffer.
    const appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void drain();
        void refreshPermissions();
      }
    });

    return () => {
      subscription.remove();
      appStateSubscription.remove();
    };
  }, [drain, pushQueueToWidget, refreshPermissions]);

  return {
    available,
    permissions,
    lastOutcome,
    requestSms,
    openNotificationSettings,
    refreshPermissions,
    simulate,
  };
}
