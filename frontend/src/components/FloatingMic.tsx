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
  NativeModules,
  TextInput,
  Modal,
} from 'react-native';
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
} from '@react-native-voice/voice';
import { Ionicons } from '@expo/vector-icons';

export interface FloatingMicProps {
  onTranscriptionComplete: (text: string) => void;
  onLiveTranscriptionChange?: (liveText: string) => void;
  locale?: string;
  style?: StyleProp<ViewStyle>;
}

export const FloatingMic: React.FC<FloatingMicProps> = ({
  onTranscriptionComplete,
  onLiveTranscriptionChange,
  locale = 'en-US',
  style,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [liveTranscription, setLiveTranscription] = useState('');
  const [showExpoGoModal, setShowExpoGoModal] = useState(false);
  const [manualVoiceInput, setManualVoiceInput] = useState('');

  // Check if native Voice module is linked in binary
  const isNativeVoiceAvailable = Boolean(NativeModules && NativeModules.Voice);

  // Web Speech API recognition instance ref
  const webRecognitionRef = useRef<any>(null);

  // Animated values for pulsing visual effects
  const pulseAnim1 = useRef(new Animated.Value(1)).current;
  const opacityAnim1 = useRef(new Animated.Value(0.6)).current;
  const pulseAnim2 = useRef(new Animated.Value(1)).current;
  const opacityAnim2 = useRef(new Animated.Value(0.4)).current;
  const buttonScaleAnim = useRef(new Animated.Value(1)).current;

  // Ref to hold current transcribed text across async callbacks
  const latestTranscriptionRef = useRef('');

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
      ])
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
      ])
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

  // Request runtime microphone permission
  const checkAndRequestPermission = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'Ken Finance needs access to your microphone to transcribe transactions.',
            buttonPositive: 'OK',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch (err) {
        console.warn('Microphone permission request error:', err);
        return false;
      }
    }
    return true;
  };

  // Setup Voice event listeners for Native and Web
  useEffect(() => {
    if (isNativeVoiceAvailable) {
      Voice.onSpeechStart = () => setIsRecording(true);
      Voice.onSpeechEnd = () => setIsRecording(false);
      Voice.onSpeechError = (e: SpeechErrorEvent) => {
        console.warn('Voice recognition error:', e.error);
        setIsRecording(false);
        stopPulseAnimation();
      };

      Voice.onSpeechPartialResults = (e: SpeechResultsEvent) => {
        if (e.value && e.value.length > 0) {
          const partialText = e.value[0];
          latestTranscriptionRef.current = partialText;
          setLiveTranscription(partialText);
          if (onLiveTranscriptionChange) onLiveTranscriptionChange(partialText);
        }
      };

      Voice.onSpeechResults = (e: SpeechResultsEvent) => {
        if (e.value && e.value.length > 0) {
          const resultText = e.value[0];
          latestTranscriptionRef.current = resultText;
          setLiveTranscription(resultText);
        }
      };
    }

    return () => {
      if (isNativeVoiceAvailable) {
        try {
          Voice.destroy().then(Voice.removeAllListeners);
        } catch (_) {}
      }
      if (webRecognitionRef.current) {
        try {
          webRecognitionRef.current.stop();
        } catch (_) {}
      }
    };
  }, [isNativeVoiceAvailable, onLiveTranscriptionChange, stopPulseAnimation]);

  // Handle Press In (Start recording & hold)
  const handlePressIn = async () => {
    // If running in Web Browser
    if (Platform.OS === 'web') {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = locale;

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

          webRecognitionRef.current = recognition;
          recognition.start();
          setIsRecording(true);
          startPulseAnimation();
          return;
        } catch (e) {
          console.warn('Web Speech API error:', e);
        }
      }
    }

    // If native module is not linked (Expo Go sandbox)
    if (!isNativeVoiceAvailable && Platform.OS !== 'web') {
      setShowExpoGoModal(true);
      return;
    }

    // Native custom build with linked Voice module
    const permitted = await checkAndRequestPermission();
    if (!permitted) {
      Alert.alert(
        'Permission Denied',
        'Microphone access is required to use voice input.'
      );
      return;
    }

    try {
      latestTranscriptionRef.current = '';
      setLiveTranscription('');
      startPulseAnimation();
      setIsRecording(true);
      await Voice.start(locale);
    } catch (error) {
      console.warn('Voice.start error:', error);
      setIsRecording(false);
      stopPulseAnimation();
    }
  };

  // Handle Press Out (Release to finalize & submit)
  const handlePressOut = async () => {
    if (!isRecording) return;

    stopPulseAnimation();
    setIsRecording(false);

    if (Platform.OS === 'web' && webRecognitionRef.current) {
      try {
        webRecognitionRef.current.stop();
      } catch (_) {}
    } else if (isNativeVoiceAvailable) {
      try {
        await Voice.stop();
      } catch (error) {
        console.warn('Voice.stop error:', error);
      }
    }

    setTimeout(() => {
      const finalText = latestTranscriptionRef.current.trim();
      if (finalText) {
        onTranscriptionComplete(finalText);
      }
      setLiveTranscription('');
      latestTranscriptionRef.current = '';
    }, 250);
  };

  const handleModalSubmit = (text: string) => {
    setShowExpoGoModal(false);
    if (text.trim()) {
      onTranscriptionComplete(text.trim());
    }
    setManualVoiceInput('');
  };

  return (
    <View style={[styles.floatingContainer, style]} pointerEvents="box-none">
      {/* Live speech preview tooltip bubble while recording */}
      {isRecording && (
        <View style={styles.tooltipBubble}>
          <View style={styles.recordingIndicatorRow}>
            <View style={styles.redDot} />
            <Text style={styles.recordingStatusText}>Listening...</Text>
          </View>
          <Text
            style={styles.liveText}
            numberOfLines={3}
            ellipsizeMode="tail"
          >
            {liveTranscription || 'Speak your transaction (e.g. "Spent 650 at Starbucks for cold brew")...'}
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
          activeOpacity={0.9}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          onPress={() => {
            if (!isNativeVoiceAvailable && Platform.OS !== 'web') {
              setShowExpoGoModal(true);
            }
          }}
          style={styles.touchableArea}
          accessibilityLabel="Hold to speak transaction"
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
              name={isRecording ? 'mic' : 'mic-outline'}
              size={30}
              color="#FFFFFF"
            />
          </Animated.View>
        </TouchableOpacity>
      </View>

      {/* Expo Go Quick Speech Simulation Modal (Active only in Expo Go) */}
      <Modal
        visible={showExpoGoModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowExpoGoModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Ionicons name="mic-circle" size={32} color="#2563EB" />
              <Text style={styles.modalTitle}>Voice Transaction Input</Text>
            </View>
            <Text style={styles.modalDescription}>
              In **Expo Go**, custom native speech binaries require a development build (`npx expo run:android` / `run:ios`). You can type or pick a sample voice command to test parsing:
            </Text>

            <TextInput
              style={styles.modalInput}
              placeholder="e.g. Spent 650 at Starbucks for cold brew"
              placeholderTextColor="#94A3B8"
              value={manualVoiceInput}
              onChangeText={setManualVoiceInput}
            />

            <View style={styles.samplePills}>
              <TouchableOpacity
                style={styles.pill}
                onPress={() => handleModalSubmit('Spent 650 at Starbucks for cold brew')}
              >
                <Text style={styles.pillText}>☕ 650 Starbucks</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pill}
                onPress={() => handleModalSubmit('Paid 3000 to Amit for flat rent')}
              >
                <Text style={styles.pillText}>🏠 3000 Flat Rent</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pill}
                onPress={() => handleModalSubmit('Received 500 from Rahul for dinner split')}
              >
                <Text style={styles.pillText}>💸 500 Rahul split</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setShowExpoGoModal(false)}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.submitBtn}
                onPress={() => handleModalSubmit(manualVoiceInput)}
              >
                <Text style={styles.submitBtnText}>Parse & Log</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    width: 240,
    backgroundColor: '#1E293B',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
    elevation: 6,
  },
  recordingIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  redDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
    marginRight: 6,
  },
  recordingStatusText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#EF4444',
    textTransform: 'uppercase',
  },
  liveText: {
    fontSize: 13,
    color: '#F8FAFC',
    lineHeight: 18,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
  },
  modalDescription: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 18,
    marginBottom: 14,
  },
  modalInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0F172A',
    marginBottom: 12,
  },
  samplePills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 18,
  },
  pill: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DBEAFE',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1E40AF',
  },
  modalButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748B',
  },
  submitBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  submitBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
