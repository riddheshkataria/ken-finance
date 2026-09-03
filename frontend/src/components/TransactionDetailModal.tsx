import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Transaction, TransactionCategory, TransactionType } from '../types/transaction';
import { formatINR, paiseToRupees, rupeesToPaise } from '../utils/money';

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

const getCategoryColor = (category: TransactionCategory): string => {
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

export interface TransactionDetailModalProps {
  visible: boolean;
  transaction: Transaction | null;
  onClose: () => void;
  onSave: (id: string, updates: Partial<Transaction>) => void;
  onDelete: (id: string) => void;
  onAddNote?: (transaction: Transaction) => void;
}

export const TransactionDetailModal: React.FC<TransactionDetailModalProps> = ({
  visible,
  transaction,
  onClose,
  onSave,
  onDelete,
  onAddNote,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(transaction?.title ?? '');
  const [draftAmountRupees, setDraftAmountRupees] = useState(
    transaction ? paiseToRupees(transaction.amountMinor).toString() : '',
  );
  const [draftCategory, setDraftCategory] = useState<TransactionCategory>(transaction?.category ?? 'Others');
  const [draftPaidTo, setDraftPaidTo] = useState(transaction?.paidTo ?? '');
  const [draftAccountInfo, setDraftAccountInfo] = useState(transaction?.accountInfo ?? '');
  const [draftType, setDraftType] = useState<TransactionType>(transaction?.transactionType ?? 'Debit');
  const [draftNote, setDraftNote] = useState(transaction?.note ?? '');
  const [showRawPayload, setShowRawPayload] = useState(false);

  // Sync state whenever transaction changes or opens
  useEffect(() => {
    if (transaction) {
      setDraftTitle(transaction.title);
      setDraftAmountRupees(paiseToRupees(transaction.amountMinor).toString());
      setDraftCategory(transaction.category);
      setDraftPaidTo(transaction.paidTo);
      setDraftAccountInfo(transaction.accountInfo);
      setDraftType(transaction.transactionType);
      setDraftNote(transaction.note ?? '');
      setIsEditing(false);
      setShowRawPayload(false);
    }
  }, [transaction]);

  if (!transaction || !visible) return null;

  const handleSave = () => {
    const numAmount = parseFloat(draftAmountRupees);
    if (isNaN(numAmount) || numAmount < 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount.');
      return;
    }

    onSave(transaction.id, {
      title: draftTitle.trim() || 'Transaction',
      amountMinor: rupeesToPaise(numAmount),
      category: draftCategory,
      paidTo: draftPaidTo.trim() || 'Unknown',
      accountInfo: draftAccountInfo.trim() || 'Default',
      transactionType: draftType,
      note: draftNote.trim() || null,
      status: 'complete',
    });

    setIsEditing(false);
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete Transaction',
      `Are you sure you want to delete "${transaction.title}" (${formatINR(transaction.amountMinor)})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            onDelete(transaction.id);
            onClose();
          },
        },
      ],
    );
  };

  const isDebit = (isEditing ? draftType : transaction.transactionType) === 'Debit';
  const categoryColor = getCategoryColor(isEditing ? draftCategory : transaction.category);
  const formattedDate = new Date(transaction.timestamp).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Top App Header */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn} accessibilityLabel="Close details">
            <Ionicons name="close" size={24} color="#0F172A" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Transaction Details</Text>
          <TouchableOpacity
            onPress={() => (isEditing ? handleSave() : setIsEditing(true))}
            style={[styles.headerBtn, isEditing && styles.saveBtnActive]}
          >
            <Text style={[styles.headerBtnText, isEditing && styles.saveBtnTextActive]}>
              {isEditing ? 'Save' : 'Edit'}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Amount Hero Box */}
          <View style={styles.amountCard}>
            {isEditing ? (
              <View style={styles.editAmountContainer}>
                <View style={styles.typeToggleRow}>
                  <TouchableOpacity
                    style={[styles.typeToggleBtn, draftType === 'Debit' && styles.typeDebitActive]}
                    onPress={() => setDraftType('Debit')}
                  >
                    <Text style={[styles.typeToggleText, draftType === 'Debit' && styles.typeTextActive]}>
                      Debit (Spent)
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.typeToggleBtn, draftType === 'Credit' && styles.typeCreditActive]}
                    onPress={() => setDraftType('Credit')}
                  >
                    <Text style={[styles.typeToggleText, draftType === 'Credit' && styles.typeTextActive]}>
                      Credit (Received)
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.rupeeInputRow}>
                  <Text style={styles.rupeePrefix}>₹</Text>
                  <TextInput
                    style={styles.amountInput}
                    value={draftAmountRupees}
                    onChangeText={setDraftAmountRupees}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor="#94A3B8"
                    autoFocus
                  />
                </View>
              </View>
            ) : (
              <View style={styles.viewAmountContainer}>
                <Text style={[styles.bigAmountText, isDebit ? styles.debitColor : styles.creditColor]}>
                  {isDebit ? '-' : '+'}{formatINR(transaction.amountMinor)}
                </Text>
                <View style={[styles.typeBadge, isDebit ? styles.debitBadge : styles.creditBadge]}>
                  <Text style={[styles.typeBadgeText, isDebit ? styles.debitColor : styles.creditColor]}>
                    {transaction.transactionType}
                  </Text>
                </View>
              </View>
            )}
          </View>

          {/* Details Section */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionHeading}>Summary</Text>

            {/* Title / Purpose */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Title</Text>
              {isEditing ? (
                <TextInput
                  style={styles.textInput}
                  value={draftTitle}
                  onChangeText={setDraftTitle}
                  placeholder="e.g. Dinner with friends"
                  placeholderTextColor="#94A3B8"
                />
              ) : (
                <Text style={styles.fieldValue}>{transaction.title}</Text>
              )}
            </View>

            {/* Merchant / Paid To */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>{isDebit ? 'Paid To' : 'Received From'}</Text>
              {isEditing ? (
                <TextInput
                  style={styles.textInput}
                  value={draftPaidTo}
                  onChangeText={setDraftPaidTo}
                  placeholder="e.g. Swiggy, Rahul Sharma"
                  placeholderTextColor="#94A3B8"
                />
              ) : (
                <Text style={styles.fieldValue}>{transaction.paidTo}</Text>
              )}
            </View>

            {/* Category Picker */}
            <View style={styles.categorySection}>
              <Text style={styles.fieldLabel}>Category</Text>
              {isEditing ? (
                <View style={styles.pillsWrap}>
                  {CATEGORIES.map((cat) => {
                    const active = draftCategory === cat;
                    const catCol = getCategoryColor(cat);
                    return (
                      <TouchableOpacity
                        key={cat}
                        style={[
                          styles.catPill,
                          active && { backgroundColor: `${catCol}25`, borderColor: catCol },
                        ]}
                        onPress={() => setDraftCategory(cat)}
                      >
                        <Text style={[styles.catPillText, active && { color: catCol, fontWeight: '700' }]}>
                          {cat}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <View style={[styles.categoryBadge, { backgroundColor: `${categoryColor}20`, borderColor: `${categoryColor}50` }]}>
                  <Text style={[styles.categoryBadgeText, { color: categoryColor }]}>{transaction.category}</Text>
                </View>
              )}
            </View>

            {/* Account Info */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Account / Mode</Text>
              {isEditing ? (
                <TextInput
                  style={styles.textInput}
                  value={draftAccountInfo}
                  onChangeText={setDraftAccountInfo}
                  placeholder="e.g. HDFC - 4392, Cash"
                  placeholderTextColor="#94A3B8"
                />
              ) : (
                <Text style={styles.fieldValue}>{transaction.accountInfo}</Text>
              )}
            </View>
          </View>

          {/* Spoken Voice Note Context */}
          <View style={styles.sectionCard}>
            <View style={styles.cardHeaderRow}>
              <View style={styles.cardTitleGroup}>
                <Ionicons name="mic-circle" size={20} color="#2563EB" />
                <Text style={styles.sectionHeading}>Voice Note & Intent</Text>
              </View>
              {onAddNote && (
                <TouchableOpacity
                  style={styles.addNoteBtn}
                  onPress={() => {
                    onClose();
                    onAddNote(transaction);
                  }}
                >
                  <Ionicons name="mic" size={14} color="#2563EB" />
                  <Text style={styles.addNoteBtnText}>Record Note</Text>
                </TouchableOpacity>
              )}
            </View>

            {isEditing ? (
              <TextInput
                style={[styles.textInput, styles.noteTextArea]}
                value={draftNote}
                onChangeText={setDraftNote}
                placeholder="Spoken note or reason for expense..."
                placeholderTextColor="#94A3B8"
                multiline
                numberOfLines={3}
              />
            ) : transaction.note ? (
              <View style={styles.noteBox}>
                <Text style={styles.noteText}>&quot;{transaction.note}&quot;</Text>
              </View>
            ) : (
              <Text style={styles.emptyFieldText}>No note attached yet. Tap &apos;Record Note&apos; to add context.</Text>
            )}

            {transaction.transcript && (
              <View style={styles.transcriptRow}>
                <Text style={styles.transcriptLabel}>Original transcript:</Text>
                <Text style={styles.transcriptValue}>{transaction.transcript}</Text>
              </View>
            )}
          </View>

          {/* Audit & Sync Metadata */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionHeading}>Ingestion & Sync Info</Text>

            <View style={styles.metaGrid}>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Source</Text>
                <View style={styles.sourceBadge}>
                  <Text style={styles.sourceBadgeText}>{transaction.source}</Text>
                </View>
              </View>

              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Status</Text>
                <Text style={styles.metaValue}>
                  {transaction.status === 'complete'
                    ? 'Completed'
                    : transaction.status === 'pending_note'
                    ? 'Awaiting Note'
                    : transaction.status}
                </Text>
              </View>

              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Bank Ref / RRN</Text>
                <Text style={styles.metaValue}>{transaction.refNo ?? 'None'}</Text>
              </View>

              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Timestamp</Text>
                <Text style={styles.metaValue}>{formattedDate}</Text>
              </View>

              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Cloud Sync</Text>
                <View style={styles.syncStatusRow}>
                  <Ionicons
                    name={transaction.syncedAt ? 'cloud-done-outline' : 'cloud-offline-outline'}
                    size={14}
                    color={transaction.syncedAt ? '#10B981' : '#F59E0B'}
                  />
                  <Text style={[styles.metaValue, { marginLeft: 4 }]}>
                    {transaction.syncedAt ? 'Synced' : 'Local (Pending Sync)'}
                  </Text>
                </View>
              </View>
            </View>

            {/* Expandable Raw Ingestion Payload */}
            {transaction.rawPayload && (
              <View style={styles.rawSection}>
                <TouchableOpacity
                  style={styles.rawHeader}
                  onPress={() => setShowRawPayload(!showRawPayload)}
                >
                  <Text style={styles.rawHeaderText}>
                    {showRawPayload ? 'Hide' : 'View'} Original Message
                  </Text>
                  <Ionicons
                    name={showRawPayload ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color="#64748B"
                  />
                </TouchableOpacity>
                {showRawPayload && (
                  <View style={styles.rawBox}>
                    <Text style={styles.rawText}>{transaction.rawPayload}</Text>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Delete Action Button */}
          <TouchableOpacity
            style={styles.deleteActionBtn}
            onPress={confirmDelete}
            accessibilityLabel="Delete this transaction"
          >
            <Ionicons name="trash-outline" size={18} color="#EF4444" />
            <Text style={styles.deleteActionText}>Delete Transaction</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  headerBtn: {
    padding: 6,
    borderRadius: 8,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0F172A',
  },
  headerBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2563EB',
  },
  saveBtnActive: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  saveBtnTextActive: {
    color: '#FFFFFF',
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
    gap: 14,
  },
  amountCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  viewAmountContainer: {
    alignItems: 'center',
    gap: 8,
  },
  bigAmountText: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  debitColor: {
    color: '#EF4444',
  },
  creditColor: {
    color: '#10B981',
  },
  typeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  debitBadge: {
    backgroundColor: '#FEE2E2',
  },
  creditBadge: {
    backgroundColor: '#D1FAE5',
  },
  typeBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  editAmountContainer: {
    width: '100%',
    alignItems: 'center',
    gap: 14,
  },
  typeToggleRow: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    padding: 3,
    width: '100%',
  },
  typeToggleBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  typeDebitActive: {
    backgroundColor: '#EF4444',
  },
  typeCreditActive: {
    backgroundColor: '#10B981',
  },
  typeToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
  },
  typeTextActive: {
    color: '#FFFFFF',
  },
  rupeeInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rupeePrefix: {
    fontSize: 28,
    fontWeight: '700',
    color: '#0F172A',
    marginRight: 6,
  },
  amountInput: {
    fontSize: 30,
    fontWeight: '800',
    color: '#0F172A',
    minWidth: 120,
    textAlign: 'center',
    borderBottomWidth: 2,
    borderBottomColor: '#2563EB',
    paddingVertical: 4,
  },
  sectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 12,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sectionHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  addNoteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  addNoteBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2563EB',
  },
  fieldRow: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  fieldValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0F172A',
  },
  textInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#0F172A',
  },
  noteTextArea: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  noteBox: {
    backgroundColor: '#EFF6FF',
    borderLeftWidth: 3,
    borderLeftColor: '#2563EB',
    padding: 12,
    borderRadius: 8,
  },
  noteText: {
    fontSize: 14,
    color: '#1E40AF',
    fontStyle: 'italic',
    lineHeight: 20,
  },
  transcriptRow: {
    marginTop: 4,
    gap: 2,
  },
  transcriptLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94A3B8',
  },
  transcriptValue: {
    fontSize: 12,
    color: '#64748B',
  },
  emptyFieldText: {
    fontSize: 13,
    color: '#94A3B8',
    fontStyle: 'italic',
  },
  categorySection: {
    gap: 6,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  categoryBadgeText: {
    fontSize: 13,
    fontWeight: '700',
  },
  pillsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  catPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
  },
  catPillText: {
    fontSize: 12,
    color: '#475569',
  },
  metaGrid: {
    gap: 10,
  },
  metaItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  metaLabel: {
    fontSize: 13,
    color: '#64748B',
  },
  metaValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0F172A',
  },
  syncStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sourceBadge: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  sourceBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  rawSection: {
    marginTop: 6,
  },
  rawHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  rawHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  rawBox: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
  },
  rawText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#94A3B8',
    lineHeight: 16,
  },
  deleteActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FEE2E2',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 8,
  },
  deleteActionText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#EF4444',
  },
});
