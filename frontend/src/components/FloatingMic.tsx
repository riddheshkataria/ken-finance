import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Animated,
  Platform,
  PermissionsAndroid,
  Alert,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  isNativeIngestionAvailable,
  startNativeSpeech,
  stopNativeSpeech,
  addSpeechListeners,
} from '../native/kenIngestion';

export interface FloatingMicProps {
  onTranscriptionComplete: (text: string) => void;
  onLiveTranscriptionChange?: (liveText: string) => void;
  locale?: string;
  style?: StyleProp<ViewStyle>;
}

export const FloatingMic: React.FC<FloatingMicProps> = ({
  onTranscriptionComplete,
  onLiveTranscriptionChange,
  locale,
  style,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [liveTranscription, setLiveTranscription] = useState('');

  // Web Speech API recognition instance ref (for browser testing)
  const webRecognitionRef = useRef<any>(null);

  // Animated values for pulsing visual effects
  const pulseAnim1 = useRef(new Animated.Value(1)).current;
  const opacityAnim1 = useRef(new Animated.Value(0.6)).current;
  const pulseAnim2 = useRef(new Animated.Value(1)).current;
  const opacityAnim2 = useRef(new Animated.Value(0.4)).current;
  const buttonScaleAnim = useRef(new Animated.Value(1)).current;

  // Ref to hold current transcribed text across async callbacks
  const latestTranscriptionRef = useRef('');
  // Prevents duplicate submissions of the same voice note
  const hasCompletedRef = useRef(false);

  const submitTranscription = useCallback(
    (text: string) => {
      if (hasCompletedRef.current) return;
      const trimmed = text.trim();
      if (trimmed) {
        hasCompletedRef.current = true;
        onTranscriptionComplete(trimmed);
        setLiveTranscription('');
        latestTranscriptionRef.current = '';
      }
    },
    [onTranscriptionComplete],
  );

  // Start continuous pulse animation loop
  const startPulseAnimation = useCallback(() => {
    pulseAnim1.setValue(1);
    opacityAnim1.setValue(0.7);
    pulseAnim2.setValue(1);
    opacityAnim2.setValue(0.5);

    const pulse1 = Animated.loop(
      Animated.parallel([
        Animated.timing(pulseAnim1, {
          toValue: 2.2,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim1, {
          toValue: 0,
          duration: 1200,
          useNativeDriver: true,
        }),
      ]),
    );

    const pulse2 = Animated.loop(
      Animated.sequence([
        Animated.delay(400),
        Animated.parallel([
          Animated.timing(pulseAnim2, {
            toValue: 2.2,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(opacityAnim2, {
            toValue: 0,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
      ]),
    );

    pulse1.start();
    pulse2.start();

    Animated.spring(buttonScaleAnim, {
      toValue: 1.15,
      friction: 4,
      useNativeDriver: true,
    }).start();
  }, [pulseAnim1, opacityAnim1, pulseAnim2, opacityAnim2, buttonScaleAnim]);

  // Stop pulse animation
  const stopPulseAnimation = useCallback(() => {
    pulseAnim1.stopAnimation();
    pulseAnim2.stopAnimation();
    pulseAnim1.setValue(1);
    opacityAnim1.setValue(0);
    pulseAnim2.setValue(1);
    opacityAnim2.setValue(0);

    Animated.spring(buttonScaleAnim, {
      toValue: 1,
      friction: 4,
      useNativeDriver: true,
    }).start();
  }, [pulseAnim1, pulseAnim2, opacityAnim1, opacityAnim2, buttonScaleAnim]);

  // Request runtime microphone permission on Android
  const checkAndRequestPermission = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      try {
        const alreadyGranted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        if (alreadyGranted) return true;

        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'Ken Finance needs access to your microphone to transcribe expense notes.',
            buttonPositive: 'Allow',
            buttonNegative: 'Cancel',
          },
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch (err) {
        console.warn('Microphone permission check error:', err);
        try {
          return await PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          );
        } catch (_) {
          return false;
        }
      }
    }
    return true;
  };

  // Setup native and web speech event listeners
  useEffect(() => {
    const subscription = addSpeechListeners({
      onSpeechStart: () => {
        setIsRecording(true);
      },
      onSpeechEnd: () => {
        setIsRecording(false);
        stopPulseAnimation();
        // If results haven't fired within 500ms after speech ends, submit what we have
        setTimeout(() => {
          if (!hasCompletedRef.current && latestTranscriptionRef.current.trim()) {
            submitTranscription(latestTranscriptionRef.current);
          }
        }, 500);
      },
      onSpeechError: (error) => {
        // The native module auto-retries transient errors (5=CLIENT, 8=BUSY,
        // 11=SERVER_DISCONNECTED). Errors only reach here if retries are
        // exhausted, or for non-transient errors. Suppress noise.
        const isBenign =
          error.includes('No speech') ||
          error.includes('timeout') ||
          error.includes('Server disconnected') ||
          error.includes('Client error') ||
          error.includes('Recognizer busy') ||
          error.includes('Recognition error code:');
        if (!isBenign) {
          console.warn('Speech recognition notice:', error);
        }
        setIsRecording(false);
        stopPulseAnimation();
        // If words were captured before the error, submit them
        if (!hasCompletedRef.current && latestTranscriptionRef.current.trim()) {
          submitTranscription(latestTranscriptionRef.current);
        }
      },
      onSpeechPartialResults: (text) => {
        if (text) {
          latestTranscriptionRef.current = text;
          setLiveTranscription(text);
          if (onLiveTranscriptionChange) onLiveTranscriptionChange(text);
        }
      },
      onSpeechResults: (text) => {
        const resultText = text || latestTranscriptionRef.current;
        if (resultText) {
          latestTranscriptionRef.current = resultText;
          setLiveTranscription(resultText);
          if (onLiveTranscriptionChange) onLiveTranscriptionChange(resultText);
          setIsRecording(false);
          stopPulseAnimation();
          submitTranscription(resultText);
        }
      },
    });

    return () => {
      subscription.remove();
      if (webRecognitionRef.current) {
        try {
          webRecognitionRef.current.stop();
        } catch (_) {}
      }
    };
  }, [onLiveTranscriptionChange, stopPulseAnimation, submitTranscription]);

  const startRecording = async () => {
    // If Web platform
    if (Platform.OS === 'web') {
      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;

      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang =
            locale ||
            (typeof navigator !== 'undefined'
              ? navigator.language || 'en-US'
              : 'en-US');

          recognition.onresult = (event: any) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
              interim += event.results[i][0].transcript;
            }
            latestTranscriptionRef.current = interim;
            setLiveTranscription(interim);
            if (onLiveTranscriptionChange) onLiveTranscriptionChange(interim);
          };

          recognition.onerror = (event: any) => {
            console.warn('Web Speech Recognition error:', event.error);
            setIsRecording(false);
            stopPulseAnimation();
          };

          recognition.onend = () => {
            setIsRecording(false);
            stopPulseAnimation();
            if (!hasCompletedRef.current && latestTranscriptionRef.current.trim()) {
              submitTranscription(latestTranscriptionRef.current);
            }
          };

          webRecognitionRef.current = recognition;
          hasCompletedRef.current = false;
          latestTranscriptionRef.current = '';
          setLiveTranscription('');
          recognition.start();
          setIsRecording(true);
          startPulseAnimation();
          return;
        } catch (e) {
          console.warn('Web Speech API error:', e);
        }
      }
    }

    // Android Native Ingestion SpeechRecognizer
    const permitted = await checkAndRequestPermission();
    if (!permitted) {
      Alert.alert(
        'Permission Denied',
        'Microphone access is required to speak transactions.',
      );
      return;
    }

    try {
      hasCompletedRef.current = false;
      latestTranscriptionRef.current = '';
      setLiveTranscription('');
      startPulseAnimation();
      setIsRecording(true);
      await startNativeSpeech(locale);
    } catch (error) {
      console.warn('startNativeSpeech error:', error);
      setIsRecording(false);
      stopPulseAnimation();
    }
  };

  const stopRecording = async () => {
    stopPulseAnimation();
    setIsRecording(false);

    if (Platform.OS === 'web' && webRecognitionRef.current) {
      try {
        webRecognitionRef.current.stop();
      } catch (_) {}
    } else {
      try {
        await stopNativeSpeech();
      } catch (error) {
        console.warn('stopNativeSpeech error:', error);
      }
    }

    // Small delay to let final speech recognizer chunk decode and submit
    setTimeout(() => {
      const finalText = latestTranscriptionRef.current.trim();
      if (finalText) {
        submitTranscription(finalText);
      }
      setLiveTranscription('');
      latestTranscriptionRef.current = '';
    }, 400);
  };

  // Toggle on press: tap to start / tap to stop
  const handleToggle = () => {
    if (isRecording) {
      void stopRecording();
    } else {
      void startRecording();
    }
  };

  return (
    <View style={[styles.floatingContainer, style]} pointerEvents="box-none">
      {/* Live speech preview tooltip bubble while recording */}
      {isRecording && (
        <View style={styles.tooltipBubble}>
          <View style={styles.recordingIndicatorRow}>
            <View style={styles.redDot} />
            <Text style={styles.recordingStatusText}>Listening (Tap mic to finish)</Text>
          </View>
          <Text
            style={styles.liveText}
            numberOfLines={3}
            ellipsizeMode="tail"
          >
            {liveTranscription || 'Speak now (e.g. "Spent 650 at Starbucks for cold brew")...'}
          </Text>
        </View>
      )}

      {/* Main Mic Button & Pulse Rings */}
      <View style={styles.buttonWrapper}>
        <Animated.View
          style={[
            styles.pulseRing,
            {
              transform: [{ scale: pulseAnim1 }],
              opacity: opacityAnim1,
            },
          ]}
        />

        <Animated.View
          style={[
            styles.pulseRing,
            {
              transform: [{ scale: pulseAnim2 }],
              opacity: opacityAnim2,
            },
          ]}
        />

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={handleToggle}
          style={styles.touchableArea}
          accessibilityLabel={isRecording ? 'Stop recording' : 'Tap to speak transaction'}
          accessibilityRole="button"
        >
          <Animated.View
            style={[
              styles.micButton,
              isRecording ? styles.micButtonActive : styles.micButtonIdle,
              { transform: [{ scale: buttonScaleAnim }] },
            ]}
          >
            <Ionicons
              name={isRecording ? 'stop' : 'mic'}
              size={28}
              color="#FFFFFF"
            />
          </Animated.View>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  floatingContainer: {
    position: 'absolute',
    bottom: 30,
    right: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonWrapper: {
    width: 68,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  touchableArea: {
    width: 68,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#EF4444',
  },
  micButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  micButtonIdle: {
    backgroundColor: '#2563EB',
  },
  micButtonActive: {
    backgroundColor: '#DC2626',
  },
  tooltipBubble: {
    position: 'absolute',
    bottom: 80,
    right: 0,
    width: 260,
    backgroundColor: '#1E293B',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  recordingIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  redDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
    marginRight: 6,
  },
  recordingStatusText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F87171',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  liveText: {
    fontSize: 13,
    color: '#F8FAFC',
    lineHeight: 18,
  },
});
