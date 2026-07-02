import { SOUND_MAP } from '@/constants/sounds';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { Button, Surface, Text } from 'react-native-paper';

interface AlarmOverlayProps {
  isVisible: boolean;
  medName: string;
  dosage: string;
  soundKey: string;
  onDismiss: () => void;
}

export default function AlarmOverlay({ isVisible, medName, dosage, soundKey, onDismiss }: AlarmOverlayProps) {
  const [sound, setSound] = useState<Audio.Sound | null>(null);


  useEffect(() => {
    if (isVisible) playAlarm();
    else stopAlarm();
  }, [isVisible, soundKey]);

  async function playAlarm() {
    // Determine which sound to play
    const soundFile = SOUND_MAP[soundKey] || SOUND_MAP['default'];

    const { sound } = await Audio.Sound.createAsync(
      soundFile,
      { isLooping: true, shouldPlay: true }
    );
    setSound(sound);
  }

  function startVibration() {
    const interval = setInterval(() => {
      if (!isVisible) clearInterval(interval);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }, 1000);
  }

  async function stopAlarm() {
    if (sound) {
      await sound.stopAsync();
      await sound.unloadAsync();
      setSound(null);
    }
  }

  return (
    <Modal visible={isVisible} animationType="slide" transparent={false}>
      <View style={styles.container}>
        <Surface style={styles.content} elevation={0}>
          <MaterialCommunityIcons name="bell-ring" size={80} color="#EF4444" />

          <View style={styles.textGroup}>
            <Text variant="labelLarge" style={styles.alertLabel}>REMINDER: MEDICATION DUE</Text>
            <Text variant="displaySmall" style={styles.medName}>{medName}</Text>
            <Text variant="headlineSmall" style={styles.dosage}>{dosage}</Text>
          </View>

          <View style={styles.actionGroup}>
            <Button
              mode="contained"
              buttonColor="#22C55E"
              onPress={onDismiss}
              style={styles.btn}
              labelStyle={styles.btnLabel}
              icon="check-bold"
            >
              CONFIRM INGESTION
            </Button>

            <Button
              mode="outlined"
              textColor="white"
              onPress={onDismiss}
              style={[styles.btn, { borderColor: 'rgba(255,255,255,0.3)' }]}
            >
              Snooze (5m)
            </Button>
          </View>

          <Text style={styles.footerText}>WISE HEALTH PROTOCOL v4.2</Text>
        </Surface>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1E293B' },
  content: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center', padding: 40 },
  textGroup: { alignItems: 'center', marginVertical: 40 },
  alertLabel: { color: '#EF4444', fontWeight: '900', letterSpacing: 2, marginBottom: 10 },
  medName: { color: 'white', fontWeight: '900', textAlign: 'center' },
  dosage: { color: 'rgba(255,255,255,0.6)', marginTop: 8 },
  actionGroup: { width: '100%', gap: 15 },
  btn: { paddingVertical: 10, borderRadius: 20 },
  btnLabel: { fontSize: 18, fontWeight: '800' },
  footerText: { position: 'absolute', bottom: 40, color: 'rgba(255,255,255,0.2)', fontSize: 10, letterSpacing: 2 }
});