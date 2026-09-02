import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  Alert,
  Platform,
  StatusBar as RNStatusBar,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useTransactionStore } from './src/store/useTransactionStore';
import { useMerchantStore } from './src/store/useMerchantStore';
import { FloatingMic } from './src/components/FloatingMic';
import { IngestionSetupCard } from './src/components/IngestionSetupCard';
import { PendingQueueBanner } from './src/components/PendingQueueBanner';
import { CategoryPicker } from './src/components/CategoryPicker';
import { InsightsPanel } from './src/components/InsightsPanel';
import { useBudgetStore } from './src/store/useBudgetStore';
import { Transaction, TransactionCategory } from './src/types/transaction';

import { parseVoiceToTransaction } from './src/utils/voiceParser';
import { useIngestion } from './src/hooks/useIngestion';
import { selectPendingQueue } from './src/store/queue';
import { formatINR, sumPaise } from './src/utils/money';

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
    deleteTransaction,
    hydrated,
    hydrate,
    loadSampleData,
    clearAll,
  } = useTransactionStore();
  const [lastVoicePrompt, setLastVoicePrompt] = useState<string | null>(null);
  // The queue item the user is currently answering, if any. A voice note
  // recorded while this is set attaches to that payment rather than creating
  // a new standalone transaction.
  const [notingTransaction, setNotingTransaction] = useState<Transaction | null>(
    null,
  );

  const hydrateMerchants = useMerchantStore((state) => state.hydrate);
  const hydrateBudgets = useBudgetStore((state) => state.hydrate);
  const budgets = useBudgetStore((state) => state.budgets);
  const setBudget = useBudgetStore((state) => state.setBudget);
  const [showInsights, setShowInsights] = useState(false);

  // Load persisted state before anything else renders meaningfully. Merchant
  // memory must be loaded before ingestion runs, or the first captured
  // payment would be categorised as if the user had taught us nothing.
  useEffect(() => {
    void hydrate();
    void hydrateMerchants();
    void hydrateBudgets();
  }, [hydrate, hydrateMerchants, hydrateBudgets]);

  // Both ingestion channels run concurrently and write straight into the
  // store; dedupe in ingestion/dedupe.ts keeps one payment as one row.
  const { available, permissions, requestSms, openNotificationSettings } =
    useIngestion();
  const skipInQueue = useTransactionStore((state) => state.skipInQueue);
  const ignoreTransaction = useTransactionStore((state) => state.ignoreTransaction);
  const attachNote = useTransactionStore((state) => state.attachNote);
  const categorizePending = useTransactionStore((state) => state.categorizePending);
  const updateTransaction = useTransactionStore((state) => state.updateTransaction);

  // The transaction whose category the user is changing. Setting one teaches
  // merchant memory, so every later payment to that merchant is automatic.
  const [categorising, setCategorising] = useState<Transaction | null>(null);
  const pendingQueue = useTransactionStore((state) =>
    selectPendingQueue(state.transactions),
  );

  // Calculate totals
  const totalDebit = sumPaise(
    transactions.filter((t) => t.transactionType === 'Debit').map((t) => t.amountMinor),
  );

  const totalCredit = sumPaise(
    transactions.filter((t) => t.transactionType === 'Credit').map((t) => t.amountMinor),
  );

  const netBalance = totalCredit - totalDebit;

  const handleVoiceComplete = (transcription: string) => {
    setLastVoicePrompt(transcription);

    // Answering a queued payment attaches the note to it. Creating a second
    // standalone transaction here would double-count the same spend, which is
    // the failure mode the whole dedupe layer exists to prevent.
    if (notingTransaction) {
      attachNote(notingTransaction.id, {
        text: transcription,
        transcript: transcription,
        audioPath: null,
      });
      setNotingTransaction(null);

      // A note is exactly what lets the model beat the keyword guess, so this
      // is the moment the paid tier is most likely to earn its cost. Not
      // awaited: the confirmation should not wait on a network round trip.
      void categorizePending();

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
      // A spoken note already carries its own context, so it is complete on
      // arrival — it is bank events that land in the queue awaiting a note.
      status: 'complete',
      skippedCount: 0,
      lastPromptedAt: null,
      note: parsed.title ?? null,
      transcript: transcription,
      audioPath: null,
    };
    addTransaction(newTx);
    Alert.alert(
      'Transaction Logged via Voice',
      `"${transcription}"\n\nAdded: ${formatINR(newTx.amountMinor)} (${newTx.category} • ${newTx.transactionType})`
    );
  };

  const renderTransactionItem = ({ item }: { item: Transaction }) => {
    const categoryColor = getCategoryColor(item.category);
    const isDebit = item.transactionType === 'Debit';
    const dateFormatted = new Date(item.timestamp).toLocaleDateString('en-IN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    return (
      <View style={styles.card}>
        <View style={styles.cardRow}>
          {/* Category Dot & Title */}
          <View style={styles.leftInfo}>
            <TouchableOpacity
              style={[styles.categoryBadge, { backgroundColor: `${categoryColor}20` }]}
              onPress={() => setCategorising(item)}
              accessibilityRole="button"
              accessibilityLabel={`Change category, currently ${item.category}`}
            >
              <Text style={[styles.categoryBadgeText, { color: categoryColor }]}>
                {item.category}
              </Text>
              <Ionicons name="chevron-down" size={11} color={categoryColor} />
            </TouchableOpacity>
            <Text style={styles.txTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.txSubtitle}>
              {item.paidTo} • {item.accountInfo}
            </Text>
          </View>

          {/* Amount & Source */}
          <View style={styles.rightInfo}>
            <Text style={[styles.txAmount, isDebit ? styles.debitText : styles.creditText]}>
              {isDebit ? '-' : '+'}{formatINR(item.amountMinor)}
            </Text>
            <View style={styles.sourceTag}>
              <Text style={styles.sourceTagText}>{item.source}</Text>
            </View>
            <Text style={styles.timestampText}>{dateFormatted}</Text>
          </View>

          {/* Delete Action */}
          <TouchableOpacity
            style={styles.deleteButton}
            onPress={() => deleteTransaction(item.id)}
            accessibilityLabel="Delete transaction"
          >
            <Ionicons name="trash-outline" size={18} color="#9CA3AF" />
          </TouchableOpacity>
        </View>
      </View>
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
              <Text style={styles.appSubtitle}>Smart Voice & SMS Finance Manager</Text>
            </View>
            <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.insightsButton}
              onPress={() => setShowInsights(true)}
              accessibilityLabel="Open budgets and insights"
            >
              <Ionicons name="stats-chart" size={16} color="#FFFFFF" />
              <Text style={styles.insightsButtonText}>Insights</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.resetButton}
              onPress={() => {
                // Sample data is a development affordance; loading it over a
                // real user's history would be destructive, so confirm first.
                Alert.alert(
                  'Replace all data?',
                  'This clears your transactions and loads sample data.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Clear all', style: 'destructive', onPress: clearAll },
                    { text: 'Load samples', onPress: loadSampleData },
                  ],
                );
              }}
            >
              <Ionicons name="refresh" size={16} color="#4B5563" />
            </TouchableOpacity>
            </View>
          </View>

          {/* Overview Balance Cards */}
          <View style={styles.balanceContainer}>
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>Net Cash Flow</Text>
              <Text
                style={[
                  styles.balanceValue,
                  netBalance >= 0 ? styles.creditText : styles.debitText,
                ]}
              >
                {netBalance >= 0 ? '+' : ''}{formatINR(netBalance)}
              </Text>
            </View>
            <View style={styles.subStatsRow}>
              <View style={styles.subStatBox}>
                <Text style={styles.subStatLabel}>Total Spent</Text>
                <Text style={[styles.subStatValue, styles.debitText]}>
                  {formatINR(totalDebit)}
                </Text>
              </View>
              <View style={styles.subStatDivider} />
              <View style={styles.subStatBox}>
                <Text style={styles.subStatLabel}>Total Income</Text>
                <Text style={[styles.subStatValue, styles.creditText]}>
                  {formatINR(totalCredit)}
                </Text>
              </View>
            </View>
          </View>

          <IngestionSetupCard
            available={available}
            permissions={permissions}
            onRequestSms={() => void requestSms()}
            onOpenNotificationSettings={() => void openNotificationSettings()}
          />

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

          {/* Transactions List */}
          <View style={styles.listHeaderRow}>
            <Text style={styles.sectionTitle}>
              Transactions ({transactions.length})
            </Text>
            <Text style={styles.hintText}>Hold mic below to speak</Text>
          </View>

          <FlatList
            data={transactions}
            keyExtractor={(item) => item.id}
            renderItem={renderTransactionItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Ionicons
                  name={hydrated ? 'receipt-outline' : 'hourglass-outline'}
                  size={48}
                  color="#D1D5DB"
                />
                {/* Distinguish "still loading" from "genuinely empty" — the
                    two look identical otherwise, and telling a user with a
                    year of history that they have none is alarming. */}
                <Text style={styles.emptyText}>
                  {hydrated ? 'No transactions yet' : 'Loading your transactions…'}
                </Text>
                {hydrated && (
                  <Text style={styles.emptySubtext}>
                    Hold the mic to log one, or grant access above to capture
                    payments automatically
                  </Text>
                )}
              </View>
            }
          />

          {/* Floating Mic with Live Streaming & Press-and-Hold */}
          <FloatingMic onTranscriptionComplete={handleVoiceComplete} />

          <InsightsPanel
            visible={showInsights}
            transactions={transactions}
            budgets={budgets}
            onSetBudget={setBudget}
            onClose={() => setShowInsights(false)}
          />

          <CategoryPicker
            transaction={categorising}
            onDismiss={() => setCategorising(null)}
            onSelect={(category) => {
              if (!categorising) return;
              // updateTransaction teaches merchant memory when a category is
              // set explicitly — see useTransactionStore.
              updateTransaction(categorising.id, { category });
              setCategorising(null);
            }}
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
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  appName: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  appSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  insightsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0F172A',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  insightsButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  resetButtonText: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '600',
  },
  balanceContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  balanceCard: {
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  balanceLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  balanceValue: {
    fontSize: 28,
    fontWeight: '800',
    marginTop: 4,
  },
  subStatsRow: {
    flexDirection: 'row',
    paddingTop: 12,
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  subStatBox: {
    alignItems: 'center',
    flex: 1,
  },
  subStatDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#E2E8F0',
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
  lastVoiceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    marginBottom: 8,
    gap: 6,
  },
  lastVoiceText: {
    fontSize: 12,
    color: '#1E40AF',
    fontWeight: '500',
    flex: 1,
  },
  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E293B',
  },
  hintText: {
    fontSize: 11,
    color: '#94A3B8',
  },
  listContent: {
    paddingBottom: 100,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 4,
    elevation: 1,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leftInfo: {
    flex: 1,
    marginRight: 10,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 4,
  },
  categoryBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  txTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0F172A',
  },
  txSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  rightInfo: {
    alignItems: 'flex-end',
    marginRight: 8,
  },
  txAmount: {
    fontSize: 15,
    fontWeight: '700',
  },
  debitText: {
    color: '#DC2626',
  },
  creditText: {
    color: '#16A34A',
  },
  sourceTag: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 3,
  },
  sourceTagText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#475569',
  },
  timestampText: {
    fontSize: 10,
    color: '#94A3B8',
    marginTop: 3,
  },
  deleteButton: {
    padding: 6,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 10,
  },
  emptySubtext: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 4,
  },
});

