import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

/**
 * Drives dictation for a single screen. Only one field can be listening at a
 * time since the underlying recognizer is a global singleton, so this hook is
 * meant to be instantiated once per screen and shared across fields.
 */
export function useVoiceDictation() {
  const [activeField, setActiveField] = useState<string | null>(null);
  const baseTextRef = useRef('');
  const onChangeTextRef = useRef<((text: string) => void) | null>(null);

  useSpeechRecognitionEvent('result', (event) => {
    if (!onChangeTextRef.current) return;
    const transcript = event.results[0]?.transcript ?? '';
    const base = baseTextRef.current;
    onChangeTextRef.current(base ? `${base} ${transcript}` : transcript);
  });

  useSpeechRecognitionEvent('end', () => {
    setActiveField(null);
    onChangeTextRef.current = null;
  });

  useSpeechRecognitionEvent('error', (event) => {
    setActiveField(null);
    onChangeTextRef.current = null;
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      Alert.alert('Dictation Error', event.message || 'Could not transcribe speech.');
    }
  });

  const start = useCallback(async (fieldKey: string, baseText: string, onChangeText: (text: string) => void) => {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      Alert.alert('Not Available', 'Speech recognition is not available on this device.');
      return;
    }

    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      Alert.alert('Permission Required', 'Microphone and speech recognition access are needed for dictation.');
      return;
    }

    baseTextRef.current = baseText;
    onChangeTextRef.current = onChangeText;
    setActiveField(fieldKey);
    ExpoSpeechRecognitionModule.start({ lang: 'en-US', interimResults: true });
  }, []);

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  return { activeField, start, stop };
}
