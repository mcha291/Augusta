import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import {
  Avatar,
  Button,
  Card,
  IconButton,
  Text,
  useTheme,
} from 'react-native-paper';

// --- Define Types for your Lambda Data ---
interface Appointment {
  id: number;
  user_id: number;
  appointment_date: string; // From DB: 2026-03-13T10:00:00.000Z
  doctor_name: string;      // maps to example 'name'
  title: string;            // maps to example 'desc'
  hospital: string;         // maps to example 'hospital'
  department: string;
  room_number: string;
  appointment_number: string;
  details: string;
  status_id: number;      // The ID (e.g., 2)
  status_label: string;   // The text (e.g., "Upcoming")
  status_color: string;   // The color (e.g., "#4CAF50")
}
interface Medication {
  id: number;
  user_id: number;
  name: string;
  dosage: string;
  frequency: string;
  status: 'active' | 'inactive';
}

interface Announcement {
  id: number;
  author_id: number;
  title: string;
  content: string;
  type: 'announcement' | 'news';
}

// Replace this with your actual Lambda Function URL
const API_BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';

export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter(); // <--- ADD THIS LINE inside the component

  // Explicitly type the states so TypeScript knows what fields exist
  const [loading, setLoading] = useState<boolean>(true);
  const [lastAppointment, setLastAppointment] = useState<Appointment | null>(null);
  const [nextAppointment, setNextAppointment] = useState<Appointment | null>(null);
  const [nextMedication, setNextMedication] = useState<Medication | null>(null);
  const [latestNews, setLatestNews] = useState<Announcement | null>(null);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchDashboardData();
    }, [])
  );

  const fetchDashboardData = async () => {
    try {
      setLoading(true);

      const [apptRes, medRes, newsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/appointments`),
        fetch(`${API_BASE_URL}/medications`),
        fetch(`${API_BASE_URL}/announcements`)
      ]);

      const appts: Appointment[] = await apptRes.json();
      const meds: Medication[] = await medRes.json();
      const news: Announcement[] = await newsRes.json();
      const now = new Date();

      // FIX: Change 'scheduled' to 'Upcoming' to match your new seed data
      const upcoming = appts
        .filter(a => a.status_id === 1 && new Date(a.appointment_date) > now)
        .sort((a, b) => new Date(a.appointment_date).getTime() - new Date(b.appointment_date).getTime())[0];

      setNextAppointment(upcoming || null);
      const lastcoming = appts
        .filter(a => a.status_id === 1 && new Date(a.appointment_date) < now)
        .sort((a, b) => new Date(a.appointment_date).getTime() - new Date(b.appointment_date).getTime())[0];

      setLastAppointment(lastcoming || null);
      setNextAppointment(upcoming || null);
      setNextMedication(meds.find(m => m.status === 'active') || null);
      setLatestNews(news[news.length - 1] || null);

    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };
  const handleComplete = () => updateAppointmentStatus(3);
  const handleMissed = () => updateAppointmentStatus(4);

  const updateAppointmentStatus = async (statusId: number) => {
    if (!lastAppointment) return;

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE_URL}/appointments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: lastAppointment.id,
          status_id: statusId
        })
      });

      if (res.ok) {
        // Success: Re-fetch data. The current appt is no longer 'Upcoming',
        // so the card will either show the next one or be empty.
        fetchDashboardData();
      } else {
        throw new Error("Failed to update status");
      }
    } catch (e) {
      Alert.alert("Error", "Could not update appointment.");
      setLoading(false);
    }
  };


  if (loading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.header}>
        
                <IconButton
                  icon="account-circle-outline"
                  iconColor={theme.colors.primary}
                  size={28}
                  onPress={() => router.push('/profile')} // Add this line
                />
        <IconButton icon="refresh" size={24} onPress={fetchDashboardData} />
      </View>

      <Text variant="headlineMedium" style={styles.mainTitle}>Dashboard</Text>

      {/* --- NEW: THE CHECK-IN CARD --- */}
      {lastAppointment && (
        <Card style={[styles.card, { backgroundColor: theme.colors.primaryContainer }]} mode="elevated">
          <Card.Title
            title="Appointment Check-in"
            subtitle="Action required for your next visit"
            titleStyle={styles.bold}
            left={(props) => <Avatar.Icon {...props} icon="bell-ring" />}
          />
          <Card.Content style={styles.checkInContent}>
            <Text variant="titleMedium" style={styles.bold}>{lastAppointment.doctor_name}</Text>
            <Text variant="bodyMedium">{lastAppointment.title}</Text>
            <Text variant="labelSmall" style={{ marginTop: 4 }}>
              {new Date(lastAppointment.appointment_date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            </Text>
          </Card.Content>
          <Card.Actions>
            <Button
              mode="outlined"
              onPress={() => handleComplete()}
              textColor={theme.colors.error}
              style={{ borderColor: theme.colors.error }}
            >
              Missed
            </Button>
            <Button
              mode="contained"
              onPress={() => handleMissed()}
              buttonColor={theme.colors.primary}
            >
              Completed
            </Button>
          </Card.Actions>
        </Card>
      )}

      {loading && !nextAppointment ? (
        <ActivityIndicator size="large" style={{ marginTop: 20 }} />
      ) : (
        <>
          <Card style={styles.card} mode="outlined">
            <Card.Title title="Recent News" left={(props) => <Avatar.Icon {...props} icon="newspaper" />} />
            <Card.Content><Text>Check the latest updates from WISE HQ.</Text></Card.Content>
          </Card>
        </>
      )}

      {/* Card 1: Next Appointment */}
      <Card style={styles.card} mode="outlined">
        <View style={styles.horizontalCard}>
          <Avatar.Icon size={40} icon="calendar-clock" />
          <View style={styles.cardHeaderInfo}>
            <Text variant="titleMedium" style={styles.bold}>
              {nextAppointment?.title || "No Upcoming Appointments"}
            </Text>
            <Text variant="bodySmall">
              {/* FIX: Use doctor_name and hospital */}
              {nextAppointment ? `${nextAppointment.doctor_name} • ${nextAppointment.hospital}` : "---"}
            </Text>
          </View>
          <View style={[styles.placeholderSmall, { backgroundColor: theme.colors.surfaceVariant }]}>
            <Text variant="labelSmall" style={{ fontWeight: 'bold', textAlign: 'center' }}>
              {/* FIX: Use room_number */}
              {nextAppointment?.room_number || "N/A"}
            </Text>
          </View>
        </View>
      </Card>

      {/* Card 2: Medication */}
      <Card style={styles.card} mode="outlined">
        <Card.Title
          title="Next Medication"
          subtitle={nextMedication ? "Active" : "None"}
          titleStyle={styles.bold}
          left={(props) => <Avatar.Icon {...props} icon="pill" />}
        />
        <Card.Content>
          <Text variant="titleMedium" style={styles.bold}>
            {nextMedication?.name || "No medications set"}
          </Text>
          <Text variant="bodyMedium">
            {nextMedication ? `${nextMedication.dosage} - ${nextMedication.frequency}` : "Stay healthy!"}
          </Text>
        </Card.Content>
        <Card.Actions>
          <Button mode="contained" disabled={!nextMedication}>Mark Taken</Button>
        </Card.Actions>
      </Card>

      {/* Card 3: News */}
      {latestNews && (
        <Card style={styles.card} mode="outlined">
          <Card.Title
            title={latestNews.type === 'news' ? "Latest News" : "Announcement"}
            left={(props) => <Avatar.Icon {...props} icon="newspaper" />}
          />
          <Card.Content>
            <Text variant="titleMedium" style={styles.bold}>{latestNews.title}</Text>
            <Text variant="bodyMedium">{latestNews.content}</Text>
          </Card.Content>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  scrollContent: { padding: 16, paddingTop: 40, paddingBottom: 100 },
  header: { flexDirection: 'row', justifyContent: 'space-between' },
  mainTitle: { fontWeight: 'bold', marginBottom: 20 },
  card: { marginBottom: 16, borderRadius: 12 },
  horizontalCard: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  cardHeaderInfo: { flex: 1, marginLeft: 12 },
  bold: { fontWeight: '600' },
  placeholderSmall: { height: 60, width: 90, borderRadius: 8, justifyContent: 'center', padding: 4 },
  centerText: { textAlign: 'center' },
  checkInContent: { marginVertical: 8 },
});