import { useState, useEffect, useCallback, useRef } from 'react';
import { Platform, PermissionsAndroid, DeviceEventEmitter, NativeEventEmitter, NativeModules } from 'react-native';
import { parseBankSms, isBankSms } from '../utils/smsParser';
import type { Transaction } from '../types/transaction';

export interface RawSmsMessage {
  sender: string;
  body: string;
  timestamp?: number | string;
}

export interface UseSmsListenerOptions {
  /**
   * Optional callback triggered whenever a valid bank SMS is intercepted and parsed.
   */
  onTransactionReceived?: (transaction: Partial<Transaction>, rawSms: RawSmsMessage) => void;
  /**
   * Automatically prompt for SMS permissions on mount (Android only).
   * @default true
   */
  autoRequestPermissions?: boolean;
}

export interface UseSmsListenerResult {
  hasPermission: boolean | null;
  isListening: boolean;
  lastParsedTransaction: Partial<Transaction> | null;
  error: string | null;
  requestPermissions: () => Promise<boolean>;
  simulateIncomingSms: (sender: string, body: string) => Partial<Transaction> | null;
}

/**
 * Custom React Native hook to listen to incoming Android SMS messages,
 * filter bank alerts, and extract structured Transaction data.
 */
export function useSmsListener(options?: UseSmsListenerOptions): UseSmsListenerResult {
  const { onTransactionReceived, autoRequestPermissions = true } = options || {};

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [lastParsedTransaction, setLastParsedTransaction] = useState<Partial<Transaction> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onTransactionReceivedRef = useRef(onTransactionReceived);
  onTransactionReceivedRef.current = onTransactionReceived;

  /**
   * Requests READ_SMS and RECEIVE_SMS runtime permissions on Android
   */
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') {
      // iOS / Web do not support programmatic incoming SMS interception for security reasons
      setHasPermission(false);
      return false;
    }

    try {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
        PermissionsAndroid.PERMISSIONS.READ_SMS,
      ]);

      const receiveGranted = granted[PermissionsAndroid.PERMISSIONS.RECEIVE_SMS] === PermissionsAndroid.RESULTS.GRANTED;
      const readGranted = granted[PermissionsAndroid.PERMISSIONS.READ_SMS] === PermissionsAndroid.RESULTS.GRANTED;

      const isPermitted = receiveGranted && readGranted;
      setHasPermission(isPermitted);

      if (!isPermitted) {
        setError('SMS permissions were denied by the user.');
      } else {
        setError(null);
      }

      return isPermitted;
    } catch (err: any) {
      const errorMsg = err?.message || 'Failed to request SMS permissions';
      setError(errorMsg);
      setHasPermission(false);
      return false;
    }
  }, []);

  /**
   * Processes a raw SMS object, filters bank headers, and parses transaction fields
   */
  const processSms = useCallback((sender: string, body: string): Partial<Transaction> | null => {
    if (!isBankSms(sender, body)) {
      return null;
    }

    const parsed = parseBankSms(sender, body);
    if (parsed) {
      setLastParsedTransaction(parsed);
      if (onTransactionReceivedRef.current) {
        onTransactionReceivedRef.current(parsed, { sender, body });
      }
    }
    return parsed;
  }, []);

  /**
   * Helper function to simulate an incoming bank SMS (useful in Expo Go, Simulator, or Web)
   */
  const simulateIncomingSms = useCallback((sender: string, body: string): Partial<Transaction> | null => {
    return processSms(sender, body);
  }, [processSms]);

  useEffect(() => {
    let subscription: any = null;

    const setupListener = async () => {
      if (Platform.OS === 'android') {
        let permitted = hasPermission;
        if (autoRequestPermissions && permitted === null) {
          permitted = await requestPermissions();
        }

        if (permitted) {
          setIsListening(true);

          // Support standard React Native SMS event emitters (e.g. SmsReceiver / react-native-android-sms-listener)
          const emitter = NativeModules.SmsListener
            ? new NativeEventEmitter(NativeModules.SmsListener)
            : DeviceEventEmitter;

          subscription = emitter.addListener('onSMSReceived', (message: any) => {
            const sender = message?.originatingAddress || message?.address || message?.sender || '';
            const body = message?.body || message?.message || '';

            if (sender && body) {
              processSms(sender, body);
            }
          });
        }
      }
    };

    setupListener();

    return () => {
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      }
      setIsListening(false);
    };
  }, [autoRequestPermissions, hasPermission, processSms, requestPermissions]);

  return {
    hasPermission,
    isListening,
    lastParsedTransaction,
    error,
    requestPermissions,
    simulateIncomingSms,
  };
}

