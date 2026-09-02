import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type {
  Transaction,
  TransactionCategory,
  TransactionType,
  TransactionSource,
} from '../types/transaction';
import { paiseToRupees, rupeesToPaise } from '../utils/money';

export interface TransactionReviewModalProps {
  visible: boolean;
  initialData: Partial<Transaction> | null;
  onSave: (transaction: Transaction) => void;
  onDiscard: () => void;
}

const CATEGORIES: TransactionCategory[] = [
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

const getSourceBadgeInfo = (source?: TransactionSource) => {
  switch (source) {
    case 'Voice-only':
      return { label: 'Voice Input', icon: 'mic', bg: '#EFF6FF', color: '#2563EB' };
    case 'SMS-parsed':
      return { label: 'SMS Alert', icon: 'chatbox-ellipses', bg: '#ECFDF5', color: '#059669' };
    case 'Merged':
      return { label: 'Reconciled & Merged', icon: 'sparkles', bg: '#FAF5FF', color: '#7C3AED' };
    default:
      return { label: 'Manual Entry', icon: 'create', bg: '#F1F5F9', color: '#475569' };
  }
};

export const TransactionReviewModal: React.FC<TransactionReviewModalProps> = ({
  visible,
  initialData,
  onSave,
  onDiscard,
}) => {
  const [amount, setAmount] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [category, setCategory] = useState<TransactionCategory>('Others');
  const [paidTo, setPaidTo] = useState<string>('');
  const [accountInfo, setAccountInfo] = useState<string>('');
  const [transactionType, setTransactionType] = useState<TransactionType>('Debit');
  const [source, setSource] = useState<TransactionSource>('Voice-only');
  const [timestamp, setTimestamp] = useState<string>('');
  const [txId, setTxId] = useState<string>('');

  // Auto-populate form when initialData changes
  useEffect(() => {
    if (initialData) {
      // The form edits rupees because that is what people type; storage stays
      // in paise (rules.md §1).
      setAmount(
        initialData.amountMinor !== undefined
          ? String(paiseToRupees(initialData.amountMinor))
          : '',
      );
      setTitle(initialData.title || '');
      setCategory(initialData.category || 'Others');
      setPaidTo(initialData.paidTo || '');
      setAccountInfo(initialData.accountInfo || 'Cash/Default');
      setTransactionType(initialData.transactionType || 'Debit');
      setSource(initialData.source || 'Voice-only');
      setTimestamp(initialData.timestamp || new Date().toISOString());
      setTxId(initialData.id || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`);
    }
  }, [initialData, visible]);

  const handleConfirmSave = () => {
    const generatedId =
      txId || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const finalTransaction: Transaction = {
      // Carry through ingestion metadata (refNo, dedupeKey, rawPayload…) that
      // the form does not expose but must not drop.
      refNo: initialData?.refNo ?? null,
      accountTail: initialData?.accountTail ?? null,
      dedupeKey: initialData?.dedupeKey ?? `manual:${generatedId}`,
      rawPayload: initialData?.rawPayload ?? null,
      channel: initialData?.channel ?? 'manual',
      skippedCount: initialData?.skippedCount ?? 0,
      lastPromptedAt: initialData?.lastPromptedAt ?? null,
      transcript: initialData?.transcript ?? null,
      audioPath: initialData?.audioPath ?? null,

      // Confirming the form is a local edit, so the row becomes dirty and is
      // pushed on the next sync.
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      syncedAt: initialData?.syncedAt ?? null,

      id: generatedId,
      amountMinor: rupeesToPaise(parseFloat(amount) || 0),
      title: title.trim() || 'Transaction',
      category,
      paidTo: paidTo.trim() || 'Unknown',
      accountInfo: accountInfo.trim() || 'Cash/Default',
      transactionType,
      timestamp: timestamp || new Date().toISOString(),
      source,
      // Confirming the form is the user supplying the missing context, so the
      // record leaves the pending-note queue.
      status: 'complete',
      note: title.trim() || null,
    };

    onSave(finalTransaction);
  };

  const badge = getSourceBadgeInfo(source);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDiscard}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <TouchableOpacity
          style={styles.dismissOverlay}
          activeOpacity={1}
          onPress={onDiscard}
        />

        <View style={styles.sheetContainer}>
          {/* Header Drag Notch */}
          <View style={styles.dragNotch} />

          {/* Sheet Header */}
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.sheetTitle}>Review Transaction</Text>
              <Text style={styles.sheetSubtitle}>Review & edit before saving</Text>
            </View>

            {/* Source Badge */}
            <View style={[styles.sourceBadge, { backgroundColor: badge.bg }]}>
              <Ionicons name={badge.icon as any} size={14} color={badge.color} />
              <Text style={[styles.sourceBadgeText, { color: badge.color }]}>
                {badge.label}
              </Text>
            </View>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Transaction Type Toggle (Debit vs Credit) */}
            <View style={styles.typeToggleContainer}>
              <TouchableOpacity
                style={[
                  styles.typeToggleBtn,
                  transactionType === 'Debit' && styles.typeToggleDebitActive,
                ]}
                onPress={() => setTransactionType('Debit')}
              >
                <Ionicons
                  name="arrow-down-circle"
                  size={16}
                  color={transactionType === 'Debit' ? '#FFFFFF' : '#64748B'}
                />
                <Text
                  style={[
                    styles.typeToggleText,
                    transactionType === 'Debit' && styles.typeToggleTextActive,
                  ]}
                >
                  Debit (Expense)
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.typeToggleBtn,
                  transactionType === 'Credit' && styles.typeToggleCreditActive,
                ]}
                onPress={() => setTransactionType('Credit')}
              >
                <Ionicons
                  name="arrow-up-circle"
                  size={16}
                  color={transactionType === 'Credit' ? '#FFFFFF' : '#64748B'}
                />
                <Text
                  style={[
                    styles.typeToggleText,
                    transactionType === 'Credit' && styles.typeToggleTextActive,
                  ]}
                >
                  Credit (Income)
                </Text>
              </TouchableOpacity>
            </View>

            {/* Amount Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Amount (₹)</Text>
              <View style={styles.amountInputWrapper}>
                <Text style={styles.currencySymbol}>₹</Text>
                <TextInput
                  style={styles.amountInput}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  keyboardType="numeric"
                  placeholderTextColor="#94A3B8"
                />
              </View>
            </View>

            {/* Title / Description */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Title / Description</Text>
              <TextInput
                style={styles.textInput}
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Dinner with team"
                placeholderTextColor="#94A3B8"
              />
            </View>

            {/* Category Pills */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Category</Text>
              <View style={styles.categoryPillsContainer}>
                {CATEGORIES.map((cat) => {
                  const isSelected = category === cat;
                  const catColor = getCategoryColor(cat);
                  return (
                    <TouchableOpacity
                      key={cat}
                      style={[
                        styles.categoryPill,
                        isSelected
                          ? { backgroundColor: catColor, borderColor: catColor }
                          : { backgroundColor: '#F1F5F9', borderColor: '#E2E8F0' },
                      ]}
                      onPress={() => setCategory(cat)}
                    >
                      <Text
                        style={[
                          styles.categoryPillText,
                          isSelected ? { color: '#FFFFFF', fontWeight: '700' } : { color: '#475569' },
                        ]}
                      >
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Merchant / Paid To */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Paid To / Merchant / Sender</Text>
              <TextInput
                style={styles.textInput}
                value={paidTo}
                onChangeText={setPaidTo}
                placeholder="e.g. Starbucks, Swiggy, Rahul Sharma"
                placeholderTextColor="#94A3B8"
              />
            </View>

            {/* Account Info */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Account Info</Text>
              <TextInput
                style={styles.textInput}
                value={accountInfo}
                onChangeText={setAccountInfo}
                placeholder="e.g. HDFC - 4392 or Cash/Default"
                placeholderTextColor="#94A3B8"
              />
            </View>
          </ScrollView>

          {/* Action Buttons */}
          <View style={styles.actionButtonRow}>
            <TouchableOpacity
              style={styles.discardButton}
              onPress={onDiscard}
              activeOpacity={0.8}
            >
              <Ionicons name="close" size={18} color="#64748B" />
              <Text style={styles.discardButtonText}>Discard</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.confirmButton}
              onPress={handleConfirmSave}
              activeOpacity={0.8}
            >
              <Ionicons name="checkmark-sharp" size={18} color="#FFFFFF" />
              <Text style={styles.confirmButtonText}>Confirm & Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    justifyContent: 'flex-end',
  },
  dismissOverlay: {
    flex: 1,
  },
  sheetContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 24,
    maxHeight: '90%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 20,
  },
  dragNotch: {
    width: 40,
    height: 4,
    backgroundColor: '#E2E8F0',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
  },
  sheetSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  sourceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    gap: 5,
  },
  sourceBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  scrollContent: {
    paddingBottom: 20,
  },
  typeToggleContainer: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  },
  typeToggleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  typeToggleDebitActive: {
    backgroundColor: '#DC2626',
  },
  typeToggleCreditActive: {
    backgroundColor: '#16A34A',
  },
  typeToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
  },
  typeToggleTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  amountInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  currencySymbol: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    marginRight: 6,
  },
  amountInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    paddingVertical: 10,
  },
  textInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: '#0F172A',
  },
  categoryPillsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  categoryPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
  },
  categoryPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  actionButtonRow: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  discardButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
    paddingVertical: 14,
    borderRadius: 14,
    gap: 6,
  },
  discardButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#64748B',
  },
  confirmButton: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 14,
    gap: 6,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  confirmButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

