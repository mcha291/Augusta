import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native';
import { LineChart } from "react-native-chart-kit";
import {
  Avatar,
  Button,
  Chip,
  Divider,
  IconButton,
  List,
  Surface,
  Text,
  useTheme
} from 'react-native-paper';

// --- Types & Helpers ---
interface TestConfig { field_number: number; display_name: string; units: string; }
interface TestResult { id: number; test_date: string; [key: string]: any; }
const isValidDate = (d: any) => d instanceof Date && !isNaN(d.getTime());
const formatDateForWeb = (date: Date) => date.toISOString().split('T')[0];
const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';
const PADDING = 16;
const GAPS = 12;

export default function ResultsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [configs, setConfigs] = useState<TestConfig[]>([]);
  const [results, setResults] = useState<TestResult[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'dashboard' | 'list'>('dashboard');
  const [selectedField, setSelectedField] = useState<number>(1);

  const [startDate, setStartDate] = useState<Date>(new Date(new Date().setFullYear(new Date().getFullYear() - 1)));
  const [endDate, setEndDate] = useState<Date>(new Date());
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  const loadData = async () => {
    try {
      const [configRes, resultsRes] = await Promise.all([
        fetch(`${BASE_URL}/test-config`),
        fetch(`${BASE_URL}/test-results`)
      ]);
      setConfigs(await configRes.json());
      setResults(await resultsRes.json());
    } catch (e) { console.error(e); } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useFocusEffect(useCallback(() => { loadData(); }, []));

  // --- NEW: DELETE LOGIC ---
  const handleDelete = (id: number) => {
    const performDelete = async () => {
      try {
        const res = await fetch(`${BASE_URL}/test-results`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        if (res.ok) loadData();
      } catch (e) {
        Alert.alert("Error", "Failed to delete result.");
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm("Are you sure you want to delete this report?")) performDelete();
    } else {
      Alert.alert("Delete Report", "This action cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", onPress: performDelete, style: "destructive" }
      ]);
    }
  };

  const navigateToEdit = (item: any) => {
    router.push({ pathname: '/results-form', params: { result: JSON.stringify(item) } });
  };

  // --- Filtering Logic ---
  const filteredResults = useMemo(() => {
    const s = new Date(startDate).setHours(0, 0, 0, 0);
    const e = new Date(endDate).setHours(23, 59, 59, 999);
    return results.filter((r) => {
      const d = new Date(r.test_date).getTime();
      return d >= s && d <= e;
    });
  }, [results, startDate, endDate]);

  const getChartDataForField = useCallback((fieldNum: number) => {
    const dataPoints = filteredResults
      .filter(r => r[`field_${fieldNum}`] !== null && r[`field_${fieldNum}`] !== undefined)
      .sort((a, b) => new Date(a.test_date).getTime() - new Date(b.test_date).getTime());
    if (dataPoints.length < 2) return null;
    return {
      labels: dataPoints.slice(-6).map(r => new Date(r.test_date).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })),
      datasets: [{ data: dataPoints.slice(-6).map(r => parseFloat(r[`field_${fieldNum}`])) }]
    };
  }, [filteredResults]);

  const numColumns = windowWidth > 600 ? 3 : 2;
  const dynamicCardWidth = (windowWidth - (PADDING * 2) - (GAPS * (numColumns - 1))) / numColumns;
  const chartKey = `${startDate.getTime()}-${endDate.getTime()}-${selectedField}`;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <IconButton icon="account-circle-outline" iconColor={theme.colors.primary} size={28} onPress={() => router.push('/profile')} />
          <IconButton icon={viewMode === 'dashboard' ? "view-list" : "chart-areaspline"} size={28} onPress={() => setViewMode(viewMode === 'dashboard' ? 'list' : 'dashboard')} />
        </View>
        <IconButton icon="plus-circle-outline" size={28} onPress={() => router.push('/results-form')} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {setRefreshing(true); loadData();}} />}>
        <Text variant="headlineMedium" style={styles.title}>{viewMode === 'dashboard' ? 'Analytics' : 'Lab Reports'}</Text>

        {/* Date Selector */}
        <Surface style={styles.dateSelectorBar} elevation={1}>
          <View style={styles.dateControl}><Text variant="labelSmall" style={styles.dateLabel}>START DATE</Text>
            {Platform.OS === 'web' ? <input type="date" value={formatDateForWeb(startDate)} style={webInputStyle} onChange={(e) => setStartDate(new Date(e.target.value))} /> : <Button mode="outlined" compact onPress={() => setShowStartPicker(true)}>{startDate.toLocaleDateString()}</Button>}
          </View>
          <IconButton icon="arrow-right" size={20} style={{marginTop: 15}} />
          <View style={styles.dateControl}><Text variant="labelSmall" style={styles.dateLabel}>END DATE</Text>
            {Platform.OS === 'web' ? <input type="date" value={formatDateForWeb(endDate)} style={webInputStyle} onChange={(e) => setEndDate(new Date(e.target.value))} /> : <Button mode="outlined" compact onPress={() => setShowEndPicker(true)}>{endDate.toLocaleDateString()}</Button>}
          </View>
        </Surface>

        {viewMode === 'dashboard' ? (
          <View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {configs.map(cfg => (<Chip key={cfg.field_number} selected={selectedField === cfg.field_number} onPress={() => setSelectedField(cfg.field_number)} style={styles.chip}>{cfg.display_name}</Chip>))}
            </ScrollView>
            <Surface style={styles.mainChartContainer} elevation={1}>
              {getChartDataForField(selectedField) ? <LineChart key={`main-${chartKey}`} data={getChartDataForField(selectedField)!} width={windowWidth - 64} height={200} chartConfig={chartConfig(theme)} bezier style={styles.chartStyle} /> : <View style={styles.noData}><Text variant="bodySmall" style={{opacity:0.5}}>No data in range</Text></View>}
            </Surface>
            <View style={[styles.miniGrid, { gap: GAPS }]}>
              {[1, 2, 3, 4].map(num => (
                <Pressable key={num} onPress={() => setSelectedField(num)} style={{ width: dynamicCardWidth }}>
                  <Surface style={[styles.miniCard, { width: dynamicCardWidth, borderColor: selectedField === num ? theme.colors.primary : 'transparent', borderWidth: selectedField === num ? 2 : 0 }]} elevation={1}>
                    <Text variant="labelSmall" numberOfLines={1}>{configs.find(c => c.field_number === num)?.display_name}</Text>
                    {getChartDataForField(num) ? <View pointerEvents="none"><LineChart key={`mini-${num}-${chartKey}`} data={getChartDataForField(num)!} width={dynamicCardWidth} height={80} withDots={false} chartConfig={{...chartConfig(theme), color: () => theme.colors.secondary}} style={{ marginLeft: -12 }} /></View> : <Text style={{fontSize:9, marginTop:20, opacity:0.3}}>No Data</Text>}
                  </Surface>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          /* --- LIST VIEW WITH DELETE BUTTONS --- */
          <View style={styles.listContainer}>
            {filteredResults.map(report => (
              <View key={report.id} style={styles.listItemContainer}>
                <View style={styles.accordionRow}>
                  <List.Accordion
                    title={`Report - ${new Date(report.test_date).toLocaleDateString()}`}
                    expanded={expandedId === report.id}
                    onPress={() => setExpandedId(expandedId === report.id ? null : report.id)}
                    left={p => <Avatar.Icon {...p} icon="flask" size={40} />}
                    right={() => null}
                    style={styles.accordion}
                  >
                    <View style={[styles.detailsBox, { backgroundColor: theme.colors.surfaceVariant }]}>
                      {configs.map(cfg => {
                        const val = report[`field_${cfg.field_number}`];
                        return val ? (
                          <View key={cfg.field_number} style={styles.dataRow}>
                            <Text variant="bodySmall" style={{flex: 1, opacity: 0.7}}>{cfg.display_name}</Text>
                            <Text variant="bodySmall" style={{fontWeight: 'bold'}}>{val} {cfg.units}</Text>
                          </View>
                        ) : null;
                      })}
                      
                      <Divider style={styles.divider} />
                      
                      {/* Side-by-side buttons inside expansion */}
                      <View style={styles.actionButtonRow}>
                        <Button 
                          mode="outlined" 
                          icon="delete" 
                          onPress={() => handleDelete(report.id)} 
                          style={{ flex: 1, borderColor: theme.colors.error }}
                          textColor={theme.colors.error}
                        >
                          Delete
                        </Button>
                        <Button 
                          mode="contained-tonal" 
                          icon="pencil" 
                          onPress={() => navigateToEdit(report)} 
                          style={{ flex: 1, marginLeft: 8 }}
                        >
                          Edit
                        </Button>
                      </View>
                    </View>
                  </List.Accordion>

                  {/* Icons in the collapsed row */}
                  <View style={styles.rightActionGroup}>
                    <IconButton 
                      icon="delete-outline" 
                      size={20} 
                      iconColor={theme.colors.error} 
                      onPress={() => handleDelete(report.id)} 
                    />
                    <IconButton 
                      icon="pencil-outline" 
                      size={20} 
                      onPress={() => navigateToEdit(report)} 
                    />
                    <Pressable onPress={() => setExpandedId(expandedId === report.id ? null : report.id)} style={styles.chevron}>
                      <MaterialCommunityIcons name={expandedId === report.id ? 'chevron-up' : 'chevron-down'} size={24} color="#bbb" />
                    </Pressable>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const webInputStyle = { padding: '8px', borderRadius: '8px', border: '1px solid #ccc', backgroundColor: 'transparent', width: '100%', textAlign: 'center' as const };
const chartConfig = (theme: any) => ({ backgroundColor: "#fff", backgroundGradientFrom: "#fff", backgroundGradientTo: "#fff", color: (o=1) => theme.colors.primary, labelColor: () => theme.colors.onSurfaceVariant, decimalPlaces: 1, paddingRight: 0 });

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: Platform.OS === 'ios' ? 50 : 40, paddingHorizontal: 8 },
  headerLeft: { flexDirection: 'row' },
  scrollContent: { padding: PADDING, paddingBottom: 100 },
  title: { fontWeight: 'bold', marginBottom: 15 },
  dateSelectorBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 12, marginBottom: 20, backgroundColor: 'rgba(0,0,0,0.02)' },
  dateControl: { flex: 1, alignItems: 'center' },
  dateLabel: { opacity: 0.5, marginBottom: 4, fontWeight: 'bold', fontSize: 10 },
  chipRow: { flexDirection: 'row', marginBottom: 16 },
  chip: { marginRight: 8 },
  mainChartContainer: { padding: 12, borderRadius: 16, alignItems: 'center', marginBottom: 20 },
  chartStyle: { borderRadius: 16 },
  miniGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  miniCard: { padding: 10, borderRadius: 12, height: 130, alignItems: 'center', overflow: 'hidden', justifyContent: 'space-between' },
  listContainer: { marginTop: 10 },
  listItemContainer: { marginBottom: 4 },
  accordionRow: { position: 'relative' },
  accordion: { backgroundColor: 'transparent', paddingRight: 110 },
  rightActionGroup: { position: 'absolute', right: 0, top: 0, flexDirection: 'row', alignItems: 'center', height: 72, paddingRight: 8 },
  chevron: { padding: 8 },
  detailsBox: { padding: 16, marginLeft: 52, marginRight: 16, borderRadius: 12, marginTop: -8, marginBottom: 16 },
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  divider: { marginVertical: 12, opacity: 0.2 },
  actionButtonRow: { flexDirection: 'row', marginTop: 8 },
  noData: { height: 200, justifyContent: 'center' },
  pickerContainer: { backgroundColor: 'white', padding: 10, borderRadius: 12, marginBottom: 20, borderWidth: 1, borderColor: '#eee' }
});