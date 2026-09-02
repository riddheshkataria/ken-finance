/**
 * Budgets, insights and search.
 *
 * The organising idea: "you spent ₹4,200" is a fact the user already knows.
 * Everything shown here is instead something they can act on — what is safe to
 * spend today, which category is running ahead of the month, and what they can
 * find by searching their own words.
 */
import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Transaction, TransactionCategory } from '../types/transaction';
import { formatINR, rupeesToPaise, paiseToRupees } from '../utils/money';
import { currentMonth, periodLabel } from '../analytics/period';
import { allBudgetStatuses, overallBudget, type BudgetMap } from '../analytics/budget';
import {
  detectRecurring,
  merchantLeaderboard,
  searchTransactions,
  sumSpend,
} from '../analytics/insights';

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

export interface InsightsPanelProps {
  visible: boolean;
  transactions: readonly Transaction[];
  budgets: BudgetMap;
  onSetBudget: (category: TransactionCategory, amountMinor: number) => void;
  onClose: () => void;
}

export const InsightsPanel: React.FC<InsightsPanelProps> = ({
  visible,
  transactions,
  budgets,
  onSetBudget,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<TransactionCategory | null>(null);
  const [draftAmount, setDraftAmount] = useState('');

  const now = Date.now();
  const period = useMemo(() => currentMonth(now), [now]);

  const overall = useMemo(
    () => overallBudget(transactions, budgets, period),
    [transactions, budgets, period],
  );
  const statuses = useMemo(
    () => allBudgetStatuses(transactions, budgets, period),
    [transactions, budgets, period],
  );
  const leaderboard = useMemo(
    () => merchantLeaderboard(transactions, period, 5),
    [transactions, period],
  );
  const recurring = useMemo(
    () => detectRecurring(transactions, now),
    [transactions, now],
  );
  const searchResults = useMemo(
    () => (query.trim() ? searchTransactions(transactions, query) : []),
    [transactions, query],
  );

  const beginEdit = (category: TransactionCategory) => {
    setEditing(category);
    const existing = budgets[category];
    setDraftAmount(existing ? String(paiseToRupees(existing)) : '');
  };

  const commitEdit = () => {
    if (!editing) return;
    const rupees = parseFloat(draftAmount);
    // The form takes rupees because that is what people think in; storage
    // stays in paise (rules.md §1).
    onSetBudget(editing, Number.isFinite(rupees) ? rupeesToPaise(rupees) : 0);
    setEditing(null);
    setDraftAmount('');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Insights</Text>
            <Text style={styles.subtitle}>{periodLabel(period)}</Text>
          </View>
          <Pressable onPress={onClose} accessibilityLabel="Close insights">
            <Ionicons name="close" size={26} color="#6B7280" />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {/* The one number people actually act on. */}
          {overall.budgetMinor > 0 && (
            <View style={styles.heroCard}>
              <Text style={styles.heroLabel}>Safe to spend today</Text>
              <Text style={styles.heroValue}>
                {formatINR(overall.safeToSpendTodayMinor)}
              </Text>
              <Text style={styles.heroHint}>
                {formatINR(Math.max(0, overall.remainingMinor))} left ·{' '}
                {period.remainingDays}{' '}
                {period.remainingDays === 1 ? 'day' : 'days'} to go
              </Text>

              <View style={styles.paceRow}>
                <PaceBar
                  label="Month"
                  fraction={overall.periodFraction}
                  color="#94A3B8"
                />
                <PaceBar
                  label="Budget"
                  fraction={overall.spentFraction}
                  color={
                    overall.spentFraction > overall.periodFraction + 0.1
                      ? '#EF4444'
                      : '#10B981'
                  }
                />
              </View>
            </View>
          )}

          {/* Budgets */}
          <Text style={styles.sectionTitle}>Budgets</Text>
          {CATEGORIES.map((category) => {
            const status = statuses.find((item) => item.category === category);
            const budget = budgets[category];

            return (
              <Pressable
                key={category}
                style={styles.budgetRow}
                onPress={() => beginEdit(category)}
                accessibilityLabel={`Set budget for ${category}`}
              >
                <View style={styles.budgetTop}>
                  <Text style={styles.budgetCategory}>{category}</Text>
                  {budget ? (
                    <Text
                      style={[
                        styles.budgetAmount,
                        status?.isOverBudget && styles.overBudget,
                      ]}
                    >
                      {formatINR(status?.spentMinor ?? 0)} / {formatINR(budget)}
                    </Text>
                  ) : (
                    <Text style={styles.setBudget}>Set budget</Text>
                  )}
                </View>

                {status && (
                  <>
                    <View style={styles.track}>
                      <View
                        style={[
                          styles.fill,
                          {
                            width: `${Math.min(100, status.spentFraction * 100)}%`,
                            backgroundColor: status.isOverBudget
                              ? '#EF4444'
                              : status.isOverpacing
                                ? '#F59E0B'
                                : '#10B981',
                          },
                        ]}
                      />
                      {/* Where the month is, so pace is visible at a glance. */}
                      <View
                        style={[
                          styles.paceMarker,
                          { left: `${Math.min(100, status.periodFraction * 100)}%` },
                        ]}
                      />
                    </View>

                    {status.isOverBudget ? (
                      <Text style={styles.warnOver}>
                        {formatINR(Math.abs(status.remainingMinor))} over budget
                      </Text>
                    ) : status.isOverpacing ? (
                      <Text style={styles.warnPace}>
                        Running ahead — {Math.round(status.spentFraction * 100)}% spent,{' '}
                        {Math.round(status.periodFraction * 100)}% through the month
                      </Text>
                    ) : (
                      <Text style={styles.okPace}>
                        {formatINR(status.safeToSpendTodayMinor)}/day for the rest of
                        the month
                      </Text>
                    )}
                  </>
                )}
              </Pressable>
            );
          })}

          {/* Search — the thing only this app can do. */}
          <Text style={styles.sectionTitle}>Search your notes</Text>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color="#9CA3AF" />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="e.g. client meeting, reimbursable"
              placeholderTextColor="#9CA3AF"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={16} color="#9CA3AF" />
              </Pressable>
            )}
          </View>

          {query.trim().length > 0 && (
            <View style={styles.searchSummary}>
              <Text style={styles.searchSummaryText}>
                {searchResults.length}{' '}
                {searchResults.length === 1 ? 'match' : 'matches'} ·{' '}
                {formatINR(sumSpend(searchResults))} total
              </Text>
            </View>
          )}

          {searchResults.slice(0, 20).map((transaction) => (
            <View key={transaction.id} style={styles.resultRow}>
              <View style={styles.resultLeft}>
                <Text style={styles.resultTitle} numberOfLines={1}>
                  {transaction.note ?? transaction.title}
                </Text>
                <Text style={styles.resultMeta}>
                  {transaction.paidTo} ·{' '}
                  {new Date(transaction.timestamp).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </Text>
              </View>
              <Text style={styles.resultAmount}>
                {formatINR(transaction.amountMinor)}
              </Text>
            </View>
          ))}

          {/* Where the money went */}
          <Text style={styles.sectionTitle}>Top merchants this month</Text>
          {leaderboard.length === 0 ? (
            <Text style={styles.empty}>No spending recorded yet</Text>
          ) : (
            leaderboard.map((merchant) => (
              <View key={merchant.key} style={styles.resultRow}>
                <View style={styles.resultLeft}>
                  <Text style={styles.resultTitle}>{merchant.displayName}</Text>
                  <Text style={styles.resultMeta}>
                    {merchant.count}{' '}
                    {merchant.count === 1 ? 'payment' : 'payments'}
                  </Text>
                </View>
                <Text style={styles.resultAmount}>
                  {formatINR(merchant.totalMinor)}
                </Text>
              </View>
            ))
          )}

          {/* Recurring */}
          {recurring.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Looks recurring</Text>
              {recurring.map((item) => (
                <View key={`${item.key}-${item.amountMinor}`} style={styles.resultRow}>
                  <View style={styles.resultLeft}>
                    <Text style={styles.resultTitle}>{item.displayName}</Text>
                    <Text style={styles.resultMeta}>
                      Every ~{item.intervalDays} days · next{' '}
                      {new Date(item.nextExpected).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </Text>
                  </View>
                  <Text style={styles.resultAmount}>
                    {formatINR(item.amountMinor)}
                  </Text>
                </View>
              ))}
            </>
          )}

          <View style={styles.bottomSpace} />
        </ScrollView>

        {/* Budget editor */}
        <Modal visible={editing !== null} transparent animationType="fade">
          <Pressable style={styles.editorBackdrop} onPress={() => setEditing(null)}>
            <Pressable style={styles.editor} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.editorTitle}>{editing} budget</Text>
              <Text style={styles.editorHint}>Monthly limit in rupees</Text>

              <TextInput
                style={styles.editorInput}
                value={draftAmount}
                onChangeText={setDraftAmount}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor="#9CA3AF"
                autoFocus
              />

              <View style={styles.editorActions}>
                <Pressable style={styles.editorCancel} onPress={() => setEditing(null)}>
                  <Text style={styles.editorCancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.editorSave} onPress={commitEdit}>
                  <Text style={styles.editorSaveText}>Save</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
};

const PaceBar: React.FC<{ label: string; fraction: number; color: string }> = ({
  label,
  fraction,
  color,
}) => (
  <View style={styles.paceItem}>
    <Text style={styles.paceLabel}>{label}</Text>
    <View style={styles.paceTrack}>
      <View
        style={[
          styles.paceFill,
          { width: `${Math.min(100, fraction * 100)}%`, backgroundColor: color },
        ]}
      />
    </View>
    <Text style={styles.paceValue}>{Math.round(fraction * 100)}%</Text>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: { fontSize: 22, fontWeight: '800', color: '#0F172A' },
  subtitle: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  scroll: { padding: 16 },

  heroCard: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
  heroLabel: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
  heroValue: { color: '#FFFFFF', fontSize: 38, fontWeight: '800', marginTop: 4 },
  heroHint: { color: '#CBD5E1', fontSize: 13, marginTop: 4 },
  paceRow: { marginTop: 18, gap: 10 },
  paceItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  paceLabel: { color: '#94A3B8', fontSize: 11, width: 46 },
  paceTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.15)',
    overflow: 'hidden',
  },
  paceFill: { height: '100%', borderRadius: 3 },
  paceValue: { color: '#CBD5E1', fontSize: 11, width: 34, textAlign: 'right' },

  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 10,
  },

  budgetRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  budgetTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  budgetCategory: { fontSize: 15, fontWeight: '600', color: '#0F172A' },
  budgetAmount: { fontSize: 13, color: '#374151', fontWeight: '600' },
  overBudget: { color: '#EF4444' },
  setBudget: { fontSize: 13, color: '#2563EB', fontWeight: '600' },

  track: {
    height: 8,
    backgroundColor: '#F1F5F9',
    borderRadius: 4,
    marginTop: 10,
    overflow: 'visible',
  },
  fill: { height: 8, borderRadius: 4 },
  paceMarker: {
    position: 'absolute',
    top: -2,
    width: 2,
    height: 12,
    backgroundColor: '#0F172A',
    opacity: 0.45,
  },
  warnOver: { fontSize: 12, color: '#EF4444', marginTop: 8, fontWeight: '600' },
  warnPace: { fontSize: 12, color: '#B45309', marginTop: 8 },
  okPace: { fontSize: 12, color: '#059669', marginTop: 8 },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  searchInput: { flex: 1, fontSize: 14, color: '#0F172A', padding: 0 },
  searchSummary: { paddingVertical: 10 },
  searchSummaryText: { fontSize: 12, color: '#6B7280', fontWeight: '600' },

  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  resultLeft: { flex: 1, marginRight: 12 },
  resultTitle: { fontSize: 14, color: '#0F172A', fontWeight: '600' },
  resultMeta: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  resultAmount: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  empty: { fontSize: 13, color: '#9CA3AF', paddingVertical: 8 },
  bottomSpace: { height: 40 },

  editorBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: 32,
  },
  editor: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20 },
  editorTitle: { fontSize: 17, fontWeight: '700', color: '#0F172A' },
  editorHint: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  editorInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 14,
  },
  editorActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  editorCancel: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#F1F5F9',
  },
  editorCancelText: { fontSize: 15, fontWeight: '600', color: '#475569' },
  editorSave: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#2563EB',
  },
  editorSaveText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
