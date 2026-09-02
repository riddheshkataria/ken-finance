/**
 * Category picker.
 *
 * This is where merchant memory learns. Without a way for the user to correct
 * a category, the memory can never fill up and the whole feature is inert —
 * so this modal is load-bearing, not decoration.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Transaction, TransactionCategory } from '../types/transaction';
import { formatINR } from '../utils/money';

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

const CATEGORY_COLORS: Readonly<Record<TransactionCategory, string>> = {
  Dining: '#F59E0B',
  Grocery: '#10B981',
  Transport: '#3B82F6',
  Rent: '#8B5CF6',
  Bills: '#EF4444',
  'P2P Transfer': '#EC4899',
  Investment: '#06B6D4',
  Others: '#6B7280',
};

export interface CategoryPickerProps {
  transaction: Transaction | null;
  onSelect: (category: TransactionCategory) => void;
  onDismiss: () => void;
}

export const CategoryPicker: React.FC<CategoryPickerProps> = ({
  transaction,
  onSelect,
  onDismiss,
}) => {
  if (!transaction) return null;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
    >
      <Pressable style={styles.backdrop} onPress={onDismiss}>
        {/* Stops a tap inside the sheet from dismissing it. */}
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.handle} />

          <Text style={styles.title}>Categorise this payment</Text>
          <Text style={styles.subtitle}>
            {formatINR(transaction.amountMinor)} · {transaction.paidTo}
          </Text>

          {/* The promise that makes correcting worth the tap. */}
          <View style={styles.learnNote}>
            <Ionicons name="sparkles-outline" size={14} color="#2563EB" />
            <Text style={styles.learnNoteText}>
              Future payments to {transaction.paidTo} will use this
              automatically
            </Text>
          </View>

          <View style={styles.grid}>
            {CATEGORIES.map((category) => {
              const isSelected = category === transaction.category;
              const color = CATEGORY_COLORS[category];

              return (
                <Pressable
                  key={category}
                  onPress={() => onSelect(category)}
                  style={[
                    styles.pill,
                    { borderColor: isSelected ? color : '#E5E7EB' },
                    isSelected && { backgroundColor: `${color}18` },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`Set category to ${category}`}
                >
                  <View style={[styles.dot, { backgroundColor: color }]} />
                  <Text
                    style={[
                      styles.pillText,
                      isSelected && { color, fontWeight: '700' },
                    ]}
                  >
                    {category}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable style={styles.cancel} onPress={onDismiss}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 32,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E5E7EB',
    marginBottom: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0F172A',
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 4,
  },
  learnNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 14,
  },
  learnNoteText: {
    flex: 1,
    fontSize: 12,
    color: '#1D4ED8',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 18,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pillText: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '600',
  },
  cancel: {
    marginTop: 20,
    alignItems: 'center',
    paddingVertical: 12,
  },
  cancelText: {
    fontSize: 15,
    color: '#6B7280',
    fontWeight: '600',
  },
});
