import React, { useState } from 'react';
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
import { FloatingMic } from './src/components/FloatingMic';
import { Transaction, TransactionCategory } from './src/types/transaction';

import { parseVoiceToTransaction } from './src/utils/voiceParser';
import { useSmsListener } from './src/hooks/useSmsListener';

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
    addSmsTransaction,
    deleteTransaction,
    resetToMock,
    reconcileAll,
  } = useTransactionStore();
  const [lastVoicePrompt, setLastVoicePrompt] = useState<string | null>(null);

  // Hook to listen to Android Bank SMS notifications with auto-reconciliation
  const { simulateIncomingSms, isListening } = useSmsListener({
    onTransactionReceived: (parsedTx, rawSms) => {
      const newTx: Transaction = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        amount: parsedTx.amount ?? 0,
        title: parsedTx.title ?? 'Bank SMS Transaction',
        category: parsedTx.category ?? 'Others',
        paidTo: parsedTx.paidTo ?? 'Merchant',
        accountInfo: parsedTx.accountInfo ?? 'Bank Account',
        transactionType: parsedTx.transactionType ?? 'Debit',
        timestamp: parsedTx.timestamp ?? new Date().toISOString(),
        source: 'SMS-parsed',
      };

      const result = addSmsTransaction(newTx);

      if (result.matched && result.mergedTransaction) {
        Alert.alert(
          '✨ Transaction Reconciled & Merged!',
          `Matched Voice log with Bank SMS (${rawSms.sender})!\n\nTitle: "${result.mergedTransaction.title}"\nAmount: ₹${result.mergedTransaction.amount}\nA/C: ${result.mergedTransaction.accountInfo}`
        );
      } else {
        Alert.alert(
          '💳 Bank SMS Logged',
          `Sender: ${rawSms.sender}\nAmount: ₹${newTx.amount} (${newTx.category})\nA/C: ${newTx.accountInfo}`
        );
      }
    },
  });

  // Calculate totals
  const totalDebit = transactions
    .filter((t) => t.transactionType === 'Debit')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalCredit = transactions
    .filter((t) => t.transactionType === 'Credit')
    .reduce((sum, t) => sum + t.amount, 0);

  const netBalance = totalCredit - totalDebit;

  const handleVoiceComplete = (transcription: string) => {
    setLastVoicePrompt(transcription);
    const parsed = parseVoiceToTransaction(transcription);
    const newTx: Transaction = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      amount: parsed.amount ?? 0,
      title: parsed.title ?? 'Voice Transaction',
      category: parsed.category ?? 'Others',
      paidTo: parsed.paidTo ?? 'Unknown Merchant',
      accountInfo: parsed.accountInfo ?? 'Cash/Default',
      transactionType: parsed.transactionType ?? 'Debit',
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      source: 'Voice-only',
    };
    addTransaction(newTx);
    Alert.alert(
      'Transaction Logged via Voice',
      `"${transcription}"\n\nAdded: ₹${newTx.amount} (${newTx.category} • ${newTx.transactionType})`
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
            <View style={[styles.categoryBadge, { backgroundColor: `${categoryColor}20` }]}>
              <Text style={[styles.categoryBadgeText, { color: categoryColor }]}>
                {item.category}
              </Text>
            </View>
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
              {isDebit ? '-' : '+'}₹{item.amount.toLocaleString('en-IN')}
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
            <TouchableOpacity style={styles.resetButton} onPress={resetToMock}>
              <Ionicons name="refresh" size={16} color="#4B5563" />
              <Text style={styles.resetButtonText}>Reset Data</Text>
            </TouchableOpacity>
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
                {netBalance >= 0 ? '+' : ''}₹{netBalance.toLocaleString('en-IN')}
              </Text>
            </View>
            <View style={styles.subStatsRow}>
              <View style={styles.subStatBox}>
                <Text style={styles.subStatLabel}>Total Spent</Text>
                <Text style={[styles.subStatValue, styles.debitText]}>
                  ₹{totalDebit.toLocaleString('en-IN')}
                </Text>
              </View>
              <View style={styles.subStatDivider} />
              <View style={styles.subStatBox}>
                <Text style={styles.subStatLabel}>Total Income</Text>
                <Text style={[styles.subStatValue, styles.creditText]}>
                  ₹{totalCredit.toLocaleString('en-IN')}
                </Text>
              </View>
            </View>
          </View>

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
                <Ionicons name="receipt-outline" size={48} color="#D1D5DB" />
                <Text style={styles.emptyText}>No transactions found</Text>
                <Text style={styles.emptySubtext}>Use the mic or reset data to get started</Text>
              </View>
            }
          />

          {/* Floating Mic with Live Streaming & Press-and-Hold */}
          <FloatingMic onTranscriptionComplete={handleVoiceComplete} />
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

