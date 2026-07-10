import { useCallback, useEffect, useState } from 'react';
import * as Speech from 'expo-speech';

/**
 * Drives read-aloud playback for a screen. Only one utterance plays at a
 * time — starting a new one stops whatever was playing, so `speakingId`
 * tracks which item (if any) is the source of the current speech.
 */
export function useTextToSpeech() {
  const [speakingId, setSpeakingId] = useState<string | number | null>(null);

  useEffect(() => () => { Speech.stop(); }, []);

  const clearIfCurrent = useCallback((id: string | number) => {
    setSpeakingId((cur) => (cur === id ? null : cur));
  }, []);

  const speak = useCallback((id: string | number, text: string) => {
    Speech.stop();
    setSpeakingId(id);
    Speech.speak(text, {
      onDone: () => clearIfCurrent(id),
      onStopped: () => clearIfCurrent(id),
      onError: () => clearIfCurrent(id),
    });
  }, [clearIfCurrent]);

  const stop = useCallback(() => {
    Speech.stop();
    setSpeakingId(null);
  }, []);

  const toggle = useCallback((id: string | number, text: string) => {
    if (speakingId === id) stop(); else speak(id, text);
  }, [speakingId, speak, stop]);

  return { speakingId, speak, stop, toggle };
}
