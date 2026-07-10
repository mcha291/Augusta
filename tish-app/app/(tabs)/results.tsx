import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native';
import { LineChart } from "react-native-chart-kit";
import {
  Button,
  Divider,
  IconButton,
  Surface,
  Text,
  useTheme
} from 'react-native-paper';

// Design System
import ProfileHeader from '@/components/profile-header';
import { useAuth } from '@/context/AuthContext';
import { apiRequest } from '@/utils/api';
import { COLORS, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { GlobalStyles } from '../../styles/globalstyles';

// --- Types ---
interface TestConfig { field_number: number; display_name: string; units: string; }
interface TestResult { id: number; test_date: string;[key: string]: any; }



export default function ResultsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { width: windowWidth } = useWindowDimensions();
  const { user, activeDependent } = useAuth();

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
        apiRequest(`/test-config`, {}, activeDependent?.id),
        apiRequest(`/test-results`, {}, activeDependent?.id)
      ]);
      setConfigs(await configRes.json());
      setResults(await resultsRes.json());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useFocusEffect(useCallback(() => { loadData(); }, []));

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
  const dynamicCardWidth = (windowWidth - (SPACING.xl * 2) - (12 * (numColumns - 1))) / numColumns;
  const chartKey = `${startDate.getTime()}-${endDate.getTime()}-${selectedField}`;
  const handleDelete = (id: number) => {
    const performDelete = async () => {
      try {
        const res = await apiRequest(`/test-results`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        if (res.ok) loadData();
      } catch (e) {
        Alert.alert(t('common.error'), t('results.deleteFailed'));
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(t('results.deleteConfirmWeb'))) performDelete();
    } else {
      Alert.alert(t('results.deleteConfirmTitle'), t('results.deleteConfirmMessage'), [
        { text: t('common.cancel'), style: "cancel" },
        { text: t('common.delete'), onPress: performDelete, style: "destructive" }
      ]);
    }
  };
  const navigateToEdit = (item: any) => {
    router.push({ pathname: '/results-form', params: { result: JSON.stringify(item) } });
  };

  // --- REFINED CHART CONFIGS ---
  const mainChartConfig = {
    backgroundGradientFrom: "#ffffff",
    backgroundGradientTo: "#ffffff",
    decimalPlaces: 1,
    color: (opacity = 1) => `rgba(99, 102, 241, ${opacity})`,
    labelColor: (opacity = 1) => `rgba(30, 41, 59, ${opacity})`, // Darker labels for readability
    style: { borderRadius: 16 },
    propsForDots: { r: "4", strokeWidth: "2", stroke: "#fff" },
    propsForBackgroundLines: { stroke: "rgba(0,0,0,0.05)", strokeDasharray: "0" }, // Faint lines for scale
    fillShadowGradientOpacity: 0.1,
  };

  const miniChartConfig = {
    ...mainChartConfig,
    color: (opacity = 1) => `rgba(99, 102, 241, ${opacity})`,
    propsForDots: { r: "0" },
    propsForBackgroundLines: { strokeWidth: 0 }, // Keep minis clean
  };

  return (
    <View style={GlobalStyles.container}>
      {/* --- 2. THE REFACTORED HEADER --- */}
      <ProfileHeader
        rightActions={
          <View style={{ flexDirection: 'row' }}>
            <IconButton icon={viewMode === 'dashboard' ? "view-list" : "chart-areaspline"} iconColor={COLORS.ink} size={26} onPress={() => setViewMode(viewMode === 'dashboard' ? 'list' : 'dashboard')} />
            <IconButton icon="plus-circle-outline" iconColor={COLORS.ink} size={26} onPress={() => router.push('/results-form')} />
          </View>
        }
      />

      <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.pageTitle}>{viewMode === 'dashboard' ? t('results.titleDashboard') : t('results.titleList')}</Text>
        {/* 2. REFACTORED DATE SELECTOR BAR */}
        <Surface style={styles.dateSelectorBar} elevation={0}>

          {/* Start Date */}
          <View style={styles.dateControl}>
            <Text style={GlobalStyles.labelMini}>{t('results.start')}</Text>
            {Platform.OS === 'web' ? (
              <input
                type="date"
                value={startDate.toISOString().split('T')[0]}
                style={webInputStyle}
                onChange={(e) => setStartDate(new Date(e.target.value))}
              />
            ) : (
              <Pressable onPress={() => setShowStartPicker(true)} style={styles.dateInputRow}>
                <MaterialCommunityIcons name="calendar-month" size={16} color={COLORS.primary} style={styles.dateIcon} />
                <Text style={styles.dateVal}>{startDate.toLocaleDateString()}</Text>
              </Pressable>
            )}
          </View>

          {/* Middle Spacer Arrow */}
          <MaterialCommunityIcons
            name="arrow-right"
            size={16}
            color={COLORS.secondary}
            style={{ marginHorizontal: 12, marginTop: 14 }}
          />

          {/* End Date */}
          <View style={styles.dateControl}>
            <Text style={GlobalStyles.labelMini}>{t('results.end')}</Text>
            {Platform.OS === 'web' ? (
              <input
                type="date"
                value={endDate.toISOString().split('T')[0]}
                style={webInputStyle}
                onChange={(e) => setEndDate(new Date(e.target.value))}
              />
            ) : (
              <Pressable onPress={() => setShowEndPicker(true)} style={styles.dateInputRow}>
                <MaterialCommunityIcons name="calendar-month" size={16} color={COLORS.primary} style={styles.dateIcon} />
                <Text style={styles.dateVal}>{endDate.toLocaleDateString()}</Text>
              </Pressable>
            )}
          </View>
        </Surface>

        {viewMode === 'dashboard' ? (
          <View>
            {/* Main Chart */}
            <Surface style={styles.mainChartContainer} elevation={0}>
              <View style={styles.chartHeader}>
                <Text style={GlobalStyles.labelMini}>{t('results.trendAnalysis')}</Text>
                <Text style={styles.activeLabel}>{configs.find(c => c.field_number === selectedField)?.display_name}</Text>
              </View>
              {getChartDataForField(selectedField) ? (
                <LineChart
                  key={`main-${chartKey}`}
                  data={getChartDataForField(selectedField)!}
                  width={windowWidth - 72} // Adjusted for inner padding
                  height={220}
                  chartConfig={mainChartConfig}
                  bezier
                  style={styles.chart}
                  yAxisSuffix={` ${configs.find(c => c.field_number === selectedField)?.units || ''}`}
                  verticalLabelRotation={0}
                />
              ) : <View style={styles.noData}><Text style={styles.noDataText}>{t('results.insufficientData')}</Text></View>}
            </Surface>

            {/* Quick View Grid */}
            <Text style={[GlobalStyles.sectionTitle, { marginTop: 24, marginBottom: 16 }]}>{t('results.quickStats')}</Text>
            <View style={styles.miniGrid}>
              {[1, 2, 3, 4]
                .filter(num => getChartDataForField(num) !== null)   // <-- hide fields with no data
                .map(num => {
                  const data = getChartDataForField(num);
                  const isSelected = selectedField === num;
                  const config = configs.find(c => c.field_number === num);

                  return (
                    <Pressable
                      key={num}
                      onPress={() => setSelectedField(num)}
                      style={{ width: dynamicCardWidth, marginBottom: 12 }}
                    >
                      <View style={[
                        styles.miniCardWrapper,
                        isSelected && { borderColor: COLORS.primary, borderWidth: 2 }
                      ]}>
                        <Surface style={styles.miniCardInner} elevation={0}>
                          <Text variant="labelSmall" numberOfLines={1} style={[styles.miniTitle, isSelected && { color: COLORS.primary }]}>
                            {config?.display_name || t('results.fieldFallback', { num })}
                          </Text>
                          {data ? (
                            <View pointerEvents="none" style={styles.miniChartBox}>
                              <LineChart
                                key={`mini-${num}-${chartKey}`}
                                data={data}
                                width={dynamicCardWidth - 10}
                                height={60}
                                withDots={false}
                                withHorizontalLabels={false}
                                withVerticalLabels={false}
                                chartConfig={miniChartConfig}
                                style={{ paddingRight: 0, paddingLeft: 0 }}
                              />
                            </View>
                          ) : <Text style={styles.noDataText}>{t('results.emptyMini')}</Text>}
                        </Surface>
                      </View>
                    </Pressable>
                  );
                })}
            </View>
            {[1, 2, 3, 4].every(num => getChartDataForField(num) === null) && (
              <Text style={styles.noDataText}>{t('results.noDataInRange')}</Text>
            )}
          </View>
        ) : (
          /* 5. List View (Mirrored from Appointments) */
          <View style={styles.listContainer}>
            {filteredResults.map(report => (
              <Surface key={report.id} style={styles.reportCard} elevation={0}>
                <View style={styles.cardHeaderRow}>
                  <View style={styles.flaskIconBox}>
                    <MaterialCommunityIcons name="flask-outline" size={22} color={COLORS.primary} />
                  </View>
                  <View style={styles.mainInfo}>
                    <Text style={styles.reportTitle}>{t('results.labReport')}</Text>
                    <Text style={styles.reportDate}>{new Date(report.test_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</Text>
                  </View>
                  <View style={styles.actionGroup}>
                    <IconButton icon="pencil-outline" size={18} onPress={() => navigateToEdit(report)} />
                    <IconButton icon={expandedId === report.id ? "chevron-up" : "chevron-down"} size={22} onPress={() => setExpandedId(expandedId === report.id ? null : report.id)} />
                  </View>
                </View>

                {expandedId === report.id && (
                  <View style={styles.expandedDetails}>
                    <Divider style={styles.divider} />
                    {configs.map(cfg => {
                      const val = report[`field_${cfg.field_number}`];
                      return val ? (
                        <View key={cfg.field_number} style={styles.dataRow}>
                          <Text style={styles.dataLabel}>{cfg.display_name}</Text>
                          <Text style={styles.dataValue}>{val} <Text style={styles.unitText}>{cfg.units}</Text></Text>
                        </View>
                      ) : null;
                    })}
                    <View style={styles.footerActions}>
                      <Button mode="text" textColor={COLORS.error} onPress={() => handleDelete(report.id)}>{t('common.delete')}</Button>
                      <Button mode="contained-tonal" onPress={() => navigateToEdit(report)} style={{ borderRadius: 12 }}>{t('results.editReport')}</Button>
                    </View>
                  </View>
                )}
              </Surface>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const webInputStyle = { border: 'none', fontSize: 14, fontWeight: '700', color: COLORS.ink, cursor: 'pointer', background: 'transparent' };

const styles = StyleSheet.create({
  pageTitle: { fontSize: 28, fontWeight: '800', color: COLORS.ink, marginBottom: 20 },

  dateSelectorBar: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: RADIUS.lg,
    backgroundColor: 'white',
    marginBottom: 24,
    ...SHADOWS.soft,
    alignItems: 'center',
    justifyContent: 'flex-start' // Changed to keep content aligned together
  },
  dateControl: {
    // Removed fixed alignment to allow natural left-to-right flow
    minWidth: 100,
  },
  dateInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4, // More space under the label
  },
  dateVal: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.ink
  },
  dateIcon: {
    marginRight: 8, // Gap between icon and text
    opacity: 0.9
  },
  // Dashboard
  mainChartContainer: { backgroundColor: 'white', borderRadius: RADIUS.xl, padding: 20, ...SHADOWS.soft },
  chartHeader: { marginBottom: 15 },
  activeLabel: { fontSize: 18, fontWeight: '800', color: COLORS.ink },
  chart: { marginTop: 10, marginLeft: -15 }, // Shifted slightly for Y-axis labels
  noData: { height: 180, justifyContent: 'center', alignItems: 'center' },
  noDataText: { color: COLORS.secondary, fontSize: 12 },

  // Mini Grid Fixes
  miniGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  miniCardWrapper: {
    borderRadius: RADIUS.lg,
    overflow: 'hidden',
    backgroundColor: 'white',
    ...SHADOWS.soft
  },
  miniCardInner: {
    padding: 12,
    height: 120,
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  miniChartBox: {
    marginTop: 10,
    width: '100%',
    alignItems: 'center'
  },
  miniTitle: { fontSize: 10, fontWeight: '800', color: COLORS.slate, textAlign: 'center', textTransform: 'uppercase' },
  emptyMiniText: { fontSize: 10, opacity: 0.3, marginTop: 15 },
  listContainer: { gap: 10 },
  // List View
  reportCard: { backgroundColor: 'white', borderRadius: RADIUS.lg, padding: 12, ...SHADOWS.soft },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center' },
  flaskIconBox: { width: 44, height: 44, backgroundColor: COLORS.background, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  mainInfo: { flex: 1, marginLeft: 16 },
  reportTitle: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  reportDate: { fontSize: 12, color: COLORS.slate },
  actionGroup: { flexDirection: 'row', alignItems: 'center' },

  expandedDetails: { marginTop: 10 },
  divider: { marginVertical: 12, backgroundColor: COLORS.background },
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  dataLabel: { fontSize: 13, color: COLORS.slate },
  dataValue: { fontSize: 13, fontWeight: '700', color: COLORS.ink },
  unitText: { fontSize: 10, fontWeight: 'normal', color: COLORS.secondary },
  footerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 }
});