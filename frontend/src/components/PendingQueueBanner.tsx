import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Transaction } from '../types/transaction';
import { formatINR } from '../utils/money';

export interface PendingQueueBannerProps {
  head: Transaction | null;
  remaining: number;
  onAddNote: (transaction: Transaction) => void;
  onSkip: (transaction: Transaction) => void;
  onIgnore: (transaction: Transaction) => void;
}

/**
 * The in-app mirror of the widget queue.
 *
 * The widget is the fast path, but it only helps if the user is on their home
 * screen. Someone who opens the app should see the same backlog and be able
 * to clear it here, with the same escape hatches — an item that can only be
 * answered from a widget is an item that never gets answered.
 */
export const PendingQueueBanner: React.FC<PendingQueueBannerProps> = ({
  head,
  remaining,
  onAddNote,
  onSkip,
  onIgnore,
}) => {
  if (!head) return null;

  const relative = formatRelative(head.timestamp);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>What was this for?</Text>
        {remaining > 0 && (
          <Text style={styles.backlog}>+{remaining} more</Text>
        )}
      </View>

      <View style={styles.mainRow}>
        <View style={styles.details}>
          <Text style={styles.amount}>{formatINR(head.amountMinor)}</Text>
          <Text style={styles.merchant} numberOfLines={1}>
            {head.paidTo} · {relative}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.micButton}
          onPress={() => onAddNote(head)}
          accessibilityLabel="Add a note to this payment"
        >
          <Ionicons name="mic" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.actionsRow}>
        <TouchableOpacity onPress={() => onSkip(head)} style={styles.textAction}>
          <Text style={styles.textActionLabel}>Skip for now</Text>
        </TouchableOpacity>
        <View style={styles.actionDivider} />
        <TouchableOpacity onPress={() => onIgnore(head)} style={styles.textAction}>
          <Text style={styles.textActionLabel}>Not worth a note</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

/**
 * Relative time is what makes a payment recognisable — "2m ago" jogs the
 * memory in a way that a timestamp does not.
 */
function formatRelative(timestamp: string): string {
  const elapsedMs = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(elapsedMs)) return '';

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#111827',
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  eyebrow: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  backlog: {
    color: '#9CA3AF',
    fontSize: 11,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  details: {
    flex: 1,
  },
  amount: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '700',
  },
  merchant: {
    color: '#9CA3AF',
    fontSize: 13,
    marginTop: 2,
  },
  micButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#374151',
    paddingTop: 10,
  },
  textAction: {
    flex: 1,
    alignItems: 'center',
  },
  textActionLabel: {
    color: '#D1D5DB',
    fontSize: 12,
  },
  actionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 14,
    backgroundColor: '#374151',
  },
});
