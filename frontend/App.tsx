import React, { useEffect, useState, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Alert,
  Platform,
  StatusBar as RNStatusBar,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useTransactionStore } from './src/store/useTransactionStore';
import { useBudgetStore } from './src/store/useBudgetStore';
import { useMerchantStore } from './src/store/useMerchantStore';
import { FloatingMic } from './src/components/FloatingMic';
import { IngestionSetupCard } from './src/components/IngestionSetupCard';
import { PendingQueueBanner } from './src/components/PendingQueueBanner';
import { TransactionDetailModal } from './src/components/TransactionDetailModal';
import { InsightsPanel } from './src/components/InsightsPanel';
import { Transaction, TransactionCategory } from './src/types/transaction';

import { parseVoiceToTransaction } from './src/utils/voiceParser';
import { useIngestion } from './src/hooks/useIngestion';
import { selectPendingQueue } from './src/store/queue';
import { formatINR, sumPaise } from './src/utils/money';
import { isSyncConfigured } from './src/sync/supabaseClient';

type TabType = 'activity' | 'transactions' | 'insights' | 'settings';

const CATEGORIES: readonly TransactionCategory[] = [
  'Dining',
  'Grocery',
  'Transport',
  'Rent',
  'Bills',
  'P2P Transfer',
  'Investment',
  'Others',
];

const getCategoryColor = (category: TransactionCategory) => {
  switch (category) {
    case 'Dining':
      return '#F59E0B';
    case 'Grocery':
      return '#10B981';
    case 'Transport':
      return '#3B82F6';
    case 'Rent':
      return '#8B5CF6';
    case 'Bills':
      return '#EF4444';
    case 'P2P Transfer':
      return '#EC4899';
    case 'Investment':
      return '#06B6D4';
    case 'Others':
    default:
      return '#6B7280';
  }
};

export default function App() {
  const {
    transactions,
    addTransaction,
    updateTransaction,
    deleteTransaction,
    skipInQueue,
    ignoreTransaction,
    attachNote,
    sync,
    syncing,
    lastSyncedAt,
    pendingPush,
    hydrated,
    hydrate,
    loadSampleData,
    clearAll,
  } = useTransactionStore();

  const { budgets, setBudget, hydrate: hydrateBudgets } = useBudgetStore();
  const { memory: merchantMemory, hydrate: hydrateMerchants } = useMerchantStore();

  const [activeTab, setActiveTab] = useState<TabType>('activity');
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [insightsModalVisible, setInsightsModalVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('All');
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<'All' | 'Debit' | 'Credit' | 'Pending'>('All');
  const [lastVoicePrompt, setLastVoicePrompt] = useState<string | null>(null);
  const [notingTransaction, setNotingTransaction] = useState<Transaction | null>(null);

  // Hydrate all local stores on startup
  useEffect(() => {
    void hydrate();
    void hydrateBudgets();
    void hydrateMerchants();
  }, [hydrate, hydrateBudgets, hydrateMerchants]);

  const { available, permissions, requestSms, openNotificationSettings } = useIngestion();

  // Memoize derived queue
  const pendingQueue = useMemo(
    () => selectPendingQueue(transactions),
    [transactions],
  );

  // Financial totals
  const totalDebit = useMemo(
    () => sumPaise(transactions.filter((t) => t.transactionType === 'Debit').map((t) => t.amountMinor)),
    [transactions],
  );

  const totalCredit = useMemo(
    () => sumPaise(transactions.filter((t) => t.transactionType === 'Credit').map((t) => t.amountMinor)),
    [transactions],
  );

  const netBalance = totalCredit - totalDebit;

  // Filtered transactions for the ledger view
  const filteredTransactions = useMemo(() => {
    return transactions.filter((t) => {
      // Search filter
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        const matchTitle = t.title.toLowerCase().includes(q);
        const matchPaidTo = t.paidTo.toLowerCase().includes(q);
        const matchNote = t.note?.toLowerCase().includes(q) ?? false;
        const matchTranscript = t.transcript?.toLowerCase().includes(q) ?? false;
        const matchRefNo = t.refNo?.toLowerCase().includes(q) ?? false;
        if (!matchTitle && !matchPaidTo && !matchNote && !matchTranscript && !matchRefNo) {
          return false;
        }
      }

      // Category filter
      if (selectedCategoryFilter !== 'All' && t.category !== selectedCategoryFilter) {
        return false;
      }

      // Type filter
      if (selectedTypeFilter === 'Debit' && t.transactionType !== 'Debit') return false;
      if (selectedTypeFilter === 'Credit' && t.transactionType !== 'Credit') return false;
      if (selectedTypeFilter === 'Pending' && t.status !== 'pending_note') return false;

      return true;
    });
  }, [transactions, searchQuery, selectedCategoryFilter, selectedTypeFilter]);

  const handleOpenDetail = (tx: Transaction) => {
    setSelectedTransaction(tx);
    setDetailModalVisible(true);
  };

  const handleSaveDetail = (id: string, updates: Partial<Transaction>) => {
    updateTransaction(id, updates);
    if (updates.category && updates.paidTo) {
      useMerchantStore.getState().learn(updates.paidTo, updates.category);
    }
  };

  const handleDeleteDetail = (id: string) => {
    deleteTransaction(id);
    setSelectedTransaction(null);
  };

  const handleVoiceComplete = (transcription: string) => {
    setLastVoicePrompt(transcription);

    if (notingTransaction) {
      attachNote(notingTransaction.id, {
        text: transcription,
        transcript: transcription,
        audioPath: null,
      });
      setNotingTransaction(null);
      Alert.alert(
        'Note added',
        `${formatINR(notingTransaction.amountMinor)} · ${notingTransaction.paidTo}\n\n"${transcription}"`,
      );
      return;
    }

    const parsed = parseVoiceToTransaction(transcription);
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const newTx: Transaction = {
      id,
      amountMinor: parsed.amountMinor ?? 0,
      title: parsed.title ?? 'Voice Transaction',
      category: parsed.category ?? 'Others',
      paidTo: parsed.paidTo ?? 'Unknown Merchant',
      accountInfo: parsed.accountInfo ?? 'Cash/Default',
      transactionType: parsed.transactionType ?? 'Debit',
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      source: 'Voice-only',
      channel: 'voice',
      refNo: null,
      accountTail: null,
      dedupeKey: `voice:${id}`,
      rawPayload: transcription,
      status: 'complete',
      skippedCount: 0,
      lastPromptedAt: null,
      note: parsed.title ?? null,
      transcript: transcription,
      audioPath: null,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      syncedAt: null,
    };
    addTransaction(newTx);
    Alert.alert(
      'Transaction Logged via Voice',
      `"${transcription}"\n\nAdded: ${newTx.transactionType === 'Credit' ? '+' : '-'}${formatINR(newTx.amountMinor)} (${newTx.category} • ${newTx.transactionType})`,
    );
  };

  const renderTransactionCard = (item: Transaction) => {
    const categoryColor = getCategoryColor(item.category);
    const isDebit = item.transactionType === 'Debit';
    const dateFormatted = new Date(item.timestamp).toLocaleDateString('en-IN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    return (
      <TouchableOpacity
        key={item.id}
        style={styles.card}
        onPress={() => handleOpenDetail(item)}
        activeOpacity={0.7}
      >
        <View style={styles.cardRow}>
          {/* Left info */}
          <View style={styles.leftInfo}>
            <View style={[styles.categoryBadge, { backgroundColor: `${categoryColor}20`, borderColor: `${categoryColor}40` }]}>
              <Text style={[styles.categoryBadgeText, { color: categoryColor }]}>
                {item.category}
              </Text>
            </View>
            <Text style={styles.txTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.txSubtitle} numberOfLines={1}>
              {item.paidTo} {item.accountInfo ? `• ${item.accountInfo}` : ''}
            </Text>
            {item.note && (
              <View style={styles.inlineNote}>
                <Ionicons name="chatbubble-ellipses-outline" size={12} color="#2563EB" />
                <Text style={styles.inlineNoteText} numberOfLines={1}>
                  {item.note}
                </Text>
              </View>
            )}
          </View>

          {/* Right info */}
          <View style={styles.rightInfo}>
            <Text style={[styles.txAmount, isDebit ? styles.debitText : styles.creditText]}>
              {isDebit ? '-' : '+'}{formatINR(item.amountMinor)}
            </Text>
            <View style={styles.sourceTag}>
              <Text style={styles.sourceTagText}>{item.source}</Text>
            </View>
            <Text style={styles.timestampText}>{dateFormatted}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.container}>
          {/* Top Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.appName}>Ken Finance</Text>
              <Text style={styles.appSubtitle}>Voice & Automated Indian Expense Tracker</Text>
            </View>
            <TouchableOpacity
              style={styles.insightsHeaderBtn}
              onPress={() => setActiveTab('insights')}
              accessibilityLabel="Open analytics insights"
            >
              <Ionicons name="pie-chart" size={16} color="#2563EB" />
              <Text style={styles.insightsHeaderBtnText}>Budgets</Text>
            </TouchableOpacity>
          </View>

          {/* Tab Navigation Controls */}
          <View style={styles.tabNavRow}>
            <TouchableOpacity
              style={[styles.tabNavItem, activeTab === 'activity' && styles.tabNavItemActive]}
              onPress={() => setActiveTab('activity')}
            >
              <Ionicons
                name={activeTab === 'activity' ? 'flash' : 'flash-outline'}
                size={16}
                color={activeTab === 'activity' ? '#2563EB' : '#64748B'}
              />
              <Text style={[styles.tabNavText, activeTab === 'activity' && styles.tabNavTextActive]}>
                Activity
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tabNavItem, activeTab === 'transactions' && styles.tabNavItemActive]}
              onPress={() => setActiveTab('transactions')}
            >
              <Ionicons
                name={activeTab === 'transactions' ? 'receipt' : 'receipt-outline'}
                size={16}
                color={activeTab === 'transactions' ? '#2563EB' : '#64748B'}
              />
              <Text style={[styles.tabNavText, activeTab === 'transactions' && styles.tabNavTextActive]}>
                Transactions ({transactions.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tabNavItem, activeTab === 'insights' && styles.tabNavItemActive]}
              onPress={() => setActiveTab('insights')}
            >
              <Ionicons
                name={activeTab === 'insights' ? 'analytics' : 'analytics-outline'}
                size={16}
                color={activeTab === 'insights' ? '#2563EB' : '#64748B'}
              />
              <Text style={[styles.tabNavText, activeTab === 'insights' && styles.tabNavTextActive]}>
                Budgets
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tabNavItem, activeTab === 'settings' && styles.tabNavItemActive]}
              onPress={() => setActiveTab('settings')}
            >
              <Ionicons
                name={activeTab === 'settings' ? 'settings' : 'settings-outline'}
                size={16}
                color={activeTab === 'settings' ? '#2563EB' : '#64748B'}
              />
              <Text style={[styles.tabNavText, activeTab === 'settings' && styles.tabNavTextActive]}>
                Sync
              </Text>
            </TouchableOpacity>
          </View>

          {/* TAB 1: Activity (Dashboard Feed) */}
          {activeTab === 'activity' && (
            <FlatList
              data={transactions.slice(0, 10)}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => renderTransactionCard(item)}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              ListHeaderComponent={
                <View style={styles.activityHeader}>
                  {/* Balance Overview Card */}
                  <View style={styles.balanceContainer}>
                    <View style={styles.balanceCard}>
                      <Text style={styles.balanceLabel}>Net Cash Flow</Text>
                      <Text style={[styles.balanceValue, netBalance >= 0 ? styles.creditText : styles.debitText]}>
                        {netBalance >= 0 ? '+' : ''}{formatINR(netBalance)}
                      </Text>
                    </View>
                    <View style={styles.subStatsRow}>
                      <View style={styles.subStatBox}>
                        <Text style={styles.subStatLabel}>Total Spent</Text>
                        <Text style={[styles.subStatValue, styles.debitText]}>{formatINR(totalDebit)}</Text>
                      </View>
                      <View style={styles.subStatDivider} />
                      <View style={styles.subStatBox}>
                        <Text style={styles.subStatLabel}>Total Income</Text>
                        <Text style={[styles.subStatValue, styles.creditText]}>{formatINR(totalCredit)}</Text>
                      </View>
                    </View>
                  </View>

                  {/* Ingestion Permissions Card */}
                  <IngestionSetupCard
                    available={available}
                    permissions={permissions}
                    onRequestSms={() => void requestSms()}
                    onOpenNotificationSettings={() => void openNotificationSettings()}
                  />

                  {/* Pending Queue Banner */}
                  <PendingQueueBanner
                    head={pendingQueue[0] ?? null}
                    remaining={Math.max(0, pendingQueue.length - 1)}
                    onAddNote={(transaction) => setNotingTransaction(transaction)}
                    onSkip={(transaction) => skipInQueue(transaction.id)}
                    onIgnore={(transaction) => ignoreTransaction(transaction.id)}
                  />

                  {/* Voice Feedback Banner */}
                  {lastVoicePrompt && (
                    <View style={styles.lastVoiceBanner}>
                      <Ionicons name="mic-circle" size={20} color="#2563EB" />
                      <Text style={styles.lastVoiceText} numberOfLines={1}>
                        Last Voice Log: &quot;{lastVoicePrompt}&quot;
                      </Text>
                    </View>
                  )}

                  <View style={styles.listHeaderRow}>
                    <Text style={styles.sectionTitle}>Recent Activity</Text>
                    <TouchableOpacity onPress={() => setActiveTab('transactions')}>
                      <Text style={styles.viewAllText}>View All ({transactions.length}) &rarr;</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              }
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Ionicons name={hydrated ? 'receipt-outline' : 'hourglass-outline'} size={48} color="#D1D5DB" />
                  <Text style={styles.emptyText}>
                    {hydrated ? 'No transactions yet' : 'Loading your transactions…'}
                  </Text>
                  {hydrated && (
                    <Text style={styles.emptySubtext}>
                      Hold the mic below to speak an expense, or tap &apos;Reset Data&apos; in Sync tab for samples.
                    </Text>
                  )}
                </View>
              }
            />
          )}

          {/* TAB 2: All Transactions (Search, Filter, Full Ledger) */}
          {activeTab === 'transactions' && (
            <View style={styles.tabContentContainer}>
              {/* Search Bar */}
              <View style={styles.searchBarContainer}>
                <Ionicons name="search" size={18} color="#64748B" />
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search merchant, title, note, transcript..."
                  placeholderTextColor="#94A3B8"
                  clearButtonMode="while-editing"
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery('')}>
                    <Ionicons name="close-circle" size={18} color="#94A3B8" />
                  </TouchableOpacity>
                )}
              </View>

              {/* Type Filters */}
              <View style={styles.filterPillsRow}>
                {(['All', 'Debit', 'Credit', 'Pending'] as const).map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[styles.filterPill, selectedTypeFilter === type && styles.filterPillActive]}
                    onPress={() => setSelectedTypeFilter(type)}
                  >
                    <Text style={[styles.filterPillText, selectedTypeFilter === type && styles.filterPillTextActive]}>
                      {type === 'Pending' ? `Needs Note (${pendingQueue.length})` : type}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Category Pills Filter */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
                <TouchableOpacity
                  style={[styles.catFilterPill, selectedCategoryFilter === 'All' && styles.catFilterPillActive]}
                  onPress={() => setSelectedCategoryFilter('All')}
                >
                  <Text style={[styles.catFilterPillText, selectedCategoryFilter === 'All' && styles.catFilterPillTextActive]}>
                    All Categories
                  </Text>
                </TouchableOpacity>
                {CATEGORIES.map((cat) => {
                  const active = selectedCategoryFilter === cat;
                  const catCol = getCategoryColor(cat);
                  return (
                    <TouchableOpacity
                      key={cat}
                      style={[
                        styles.catFilterPill,
                        active && { backgroundColor: `${catCol}20`, borderColor: catCol },
                      ]}
                      onPress={() => setSelectedCategoryFilter(cat)}
                    >
                      <Text style={[styles.catFilterPillText, active && { color: catCol, fontWeight: '700' }]}>
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* Transaction List */}
              <FlatList
                data={filteredTransactions}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => renderTransactionCard(item)}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                  <View style={styles.emptyContainer}>
                    <Ionicons name="filter-outline" size={48} color="#D1D5DB" />
                    <Text style={styles.emptyText}>No matching transactions</Text>
                    <Text style={styles.emptySubtext}>Try adjusting your search query or category filters.</Text>
                  </View>
                }
              />
            </View>
          )}

          {/* TAB 3: Insights & Budgets */}
          {activeTab === 'insights' && (
            <View style={styles.tabContentContainer}>
              <InsightsPanel
                visible={true}
                transactions={transactions}
                budgets={budgets}
                onSetBudget={setBudget}
                onClose={() => setActiveTab('activity')}
              />
            </View>
          )}

          {/* TAB 4: Cloud Sync & Settings */}
          {activeTab === 'settings' && (
            <ScrollView style={styles.tabContentContainer} contentContainerStyle={styles.settingsContent}>
              {/* Cloud Sync Status */}
              <View style={styles.settingsCard}>
                <View style={styles.settingsHeader}>
                  <Ionicons name="cloud-outline" size={22} color="#2563EB" />
                  <Text style={styles.settingsTitle}>Supabase Cloud Sync</Text>
                </View>
                <Text style={styles.settingsDesc}>
                  Syncs encrypted transactions and budget settings across your devices using Supabase Postgres.
                </Text>

                <View style={styles.syncRow}>
                  <Text style={styles.syncLabel}>Status:</Text>
                  <Text style={[styles.syncStatusVal, isSyncConfigured() ? styles.creditText : styles.debitText]}>
                    {isSyncConfigured() ? 'Connected' : 'Offline Mode (Local SQLite)'}
                  </Text>
                </View>

                {isSyncConfigured() && (
                  <>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Pending uploads:</Text>
                      <Text style={styles.syncStatusVal}>{pendingPush()} rows dirty</Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Last synced:</Text>
                      <Text style={styles.syncStatusVal}>
                        {lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : 'Not yet synced'}
                      </Text>
                    </View>

                    <TouchableOpacity
                      style={[styles.syncNowBtn, syncing && styles.syncBtnDisabled]}
                      onPress={() => void sync()}
                      disabled={syncing}
                    >
                      <Ionicons name={syncing ? 'hourglass-outline' : 'sync'} size={16} color="#FFFFFF" />
                      <Text style={styles.syncNowBtnText}>{syncing ? 'Syncing…' : 'Sync Now'}</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>

              {/* AI & Merchant Memory */}
              <View style={styles.settingsCard}>
                <View style={styles.settingsHeader}>
                  <Ionicons name="bulb-outline" size={22} color="#F59E0B" />
                  <Text style={styles.settingsTitle}>AI & Merchant Memory</Text>
                </View>
                <Text style={styles.settingsDesc}>
                  Ken learns from your edits. Once you categorise a merchant, future transactions to that merchant are automatically assigned without calling the LLM.
                </Text>
                <View style={styles.syncRow}>
                  <Text style={styles.syncLabel}>Learned Merchants:</Text>
                  <Text style={styles.syncStatusVal}>{Object.keys(merchantMemory).length} rules active</Text>
                </View>
                <View style={styles.syncRow}>
                  <Text style={styles.syncLabel}>Categorization Engine:</Text>
                  <Text style={styles.syncStatusVal}>Google Gemini 2.5 Flash</Text>
                </View>
              </View>

              {/* Data Management */}
              <View style={styles.settingsCard}>
                <View style={styles.settingsHeader}>
                  <Ionicons name="server-outline" size={22} color="#4B5563" />
                  <Text style={styles.settingsTitle}>Data Management</Text>
                </View>
                <Text style={styles.settingsDesc}>
                  Load rich sample data covering all 8 Indian categories, recurring subscriptions, and insights.
                </Text>

                <TouchableOpacity
                  style={styles.sampleDataBtn}
                  onPress={() => {
                    Alert.alert('Load Sample Data?', 'This populates sample transactions across all categories.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Load', onPress: loadSampleData },
                    ]);
                  }}
                >
                  <Ionicons name="refresh" size={16} color="#2563EB" />
                  <Text style={styles.sampleDataBtnText}>Reset to Sample Data</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.clearAllBtn}
                  onPress={() => {
                    Alert.alert('Clear All Transactions?', 'This permanently removes all local transactions.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Clear All', style: 'destructive', onPress: clearAll },
                    ]);
                  }}
                >
                  <Ionicons name="trash" size={16} color="#EF4444" />
                  <Text style={styles.clearAllBtnText}>Clear All Transactions</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}

          {/* Floating Mic for Live Voice Recording */}
          <FloatingMic onTranscriptionComplete={handleVoiceComplete} />

          {/* Full Transaction Details Modal */}
          <TransactionDetailModal
            visible={detailModalVisible}
            transaction={selectedTransaction}
            onClose={() => setDetailModalVisible(false)}
            onSave={handleSaveDetail}
            onDelete={handleDeleteDetail}
            onAddNote={(tx) => setNotingTransaction(tx)}
          />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  appName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  appSubtitle: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 1,
  },
  insightsHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  insightsHeaderBtnText: {
    fontSize: 12,
    color: '#2563EB',
    fontWeight: '700',
  },
  tabNavRow: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingHorizontal: 8,
  },
  tabNavItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    gap: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabNavItemActive: {
    borderBottomColor: '#2563EB',
  },
  tabNavText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  tabNavTextActive: {
    color: '#2563EB',
    fontWeight: '700',
  },
  tabContentContainer: {
    flex: 1,
  },
  activityHeader: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  balanceContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  balanceCard: {
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  balanceLabel: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  balanceValue: {
    fontSize: 32,
    fontWeight: '800',
    marginTop: 4,
    letterSpacing: -0.5,
  },
  subStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
  },
  subStatBox: {
    flex: 1,
    alignItems: 'center',
  },
  subStatDivider: {
    width: 1,
    backgroundColor: '#F1F5F9',
  },
  subStatLabel: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '500',
  },
  subStatValue: {
    fontSize: 16,
    fontWeight: '700',
    marginTop: 2,
  },
  debitText: {
    color: '#EF4444',
  },
  creditText: {
    color: '#10B981',
  },
  lastVoiceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#DBEAFE',
  },
  lastVoiceText: {
    flex: 1,
    fontSize: 12,
    color: '#1E40AF',
    fontStyle: 'italic',
  },
  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
  },
  viewAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2563EB',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 100,
    gap: 10,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOpacity: 0.02,
    shadowRadius: 4,
    elevation: 1,
  },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  leftInfo: {
    flex: 1,
    marginRight: 10,
    gap: 4,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  categoryBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  txTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 2,
  },
  txSubtitle: {
    fontSize: 12,
    color: '#64748B',
  },
  inlineNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  inlineNoteText: {
    fontSize: 11,
    color: '#2563EB',
    fontStyle: 'italic',
  },
  rightInfo: {
    alignItems: 'flex-end',
    gap: 2,
  },
  txAmount: {
    fontSize: 16,
    fontWeight: '700',
  },
  sourceTag: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sourceTagText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#64748B',
  },
  timestampText: {
    fontSize: 10,
    color: '#94A3B8',
  },
  searchBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#0F172A',
  },
  filterPillsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 6,
    marginBottom: 8,
  },
  filterPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  filterPillActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  filterPillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
  },
  filterPillTextActive: {
    color: '#FFFFFF',
  },
  categoryScroll: {
    paddingHorizontal: 16,
    marginBottom: 10,
    maxHeight: 36,
  },
  catFilterPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginRight: 6,
  },
  catFilterPillActive: {
    backgroundColor: '#0F172A',
    borderColor: '#0F172A',
  },
  catFilterPillText: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '600',
  },
  catFilterPillTextActive: {
    color: '#FFFFFF',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 12,
  },
  emptySubtext: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 18,
  },
  settingsContent: {
    padding: 16,
    paddingBottom: 100,
    gap: 14,
  },
  settingsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 10,
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settingsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
  },
  settingsDesc: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 17,
  },
  syncRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#F8FAFC',
  },
  syncLabel: {
    fontSize: 13,
    color: '#64748B',
  },
  syncStatusVal: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0F172A',
  },
  syncNowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#2563EB',
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 6,
  },
  syncBtnDisabled: {
    opacity: 0.6,
  },
  syncNowBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  sampleDataBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#EFF6FF',
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 4,
  },
  sampleDataBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2563EB',
  },
  clearAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FEE2E2',
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 6,
  },
  clearAllBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#EF4444',
  },
});
