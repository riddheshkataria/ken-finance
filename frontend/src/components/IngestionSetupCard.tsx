import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { IngestionPermissions } from '../hooks/useIngestion';

export interface IngestionSetupCardProps {
  available: boolean;
  permissions: IngestionPermissions;
  onRequestSms: () => void;
  onOpenNotificationSettings: () => void;
}

/**
 * Explains and requests the two capture permissions.
 *
 * Notification access is the one that needs selling: it cannot be granted by
 * a dialog, only by sending the user into Settings > Special app access. A
 * bare "open settings" button with no reason attached is how that step gets
 * abandoned, so the card says what each channel buys before asking.
 *
 * Hidden entirely once both are granted — permanent setup furniture on the
 * main screen is noise.
 */
export const IngestionSetupCard: React.FC<IngestionSetupCardProps> = ({
  available,
  permissions,
  onRequestSms,
  onOpenNotificationSettings,
}) => {
  if (!available) {
    return (
      <View style={[styles.card, styles.unavailableCard]}>
        <Ionicons name="information-circle-outline" size={18} color="#92400E" />
        <Text style={styles.unavailableText}>
          Automatic capture needs the Android development build. Voice logging
          and manual entry work here.
        </Text>
      </View>
    );
  }

  const smsGranted = permissions.sms === true;
  const notificationsGranted = permissions.notifications === true;

  if (smsGranted && notificationsGranted) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Finish setup</Text>
      <Text style={styles.subtitle}>
        Ken reads payment alerts so you only have to say what they were for.
      </Text>

      {!notificationsGranted && (
        <TouchableOpacity
          style={styles.row}
          onPress={onOpenNotificationSettings}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Grant notification access"
        >
          <View style={styles.rowIcon}>
            <Ionicons name="notifications-outline" size={18} color="#2563EB" />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Notification access</Text>
            <Text style={styles.rowSubtitle}>
              Catches GPay, PhonePe and Paytm payments — usually before the bank
              texts, and with the merchant&apos;s real name.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
        </TouchableOpacity>
      )}

      {!smsGranted && (
        <TouchableOpacity
          style={styles.row}
          onPress={onRequestSms}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Grant SMS access"
        >
          <View style={styles.rowIcon}>
            <Ionicons name="chatbox-outline" size={18} color="#2563EB" />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>SMS access</Text>
            <Text style={styles.rowSubtitle}>
              Covers banks that only send texts. Optional — Ken still works
              without it.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
        </TouchableOpacity>
      )}

      <Text style={styles.footnote}>
        Alerts are read on your device. Nothing is uploaded.
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  unavailableCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderColor: '#FDE68A',
  },
  unavailableText: {
    flex: 1,
    color: '#92400E',
    fontSize: 12,
    lineHeight: 17,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  rowSubtitle: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 1,
    lineHeight: 15,
  },
  footnote: {
    fontSize: 10,
    color: '#9CA3AF',
    marginTop: 10,
  },
});
