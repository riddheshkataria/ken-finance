package expo.modules.keningestion

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Captures payment notifications.
 *
 * This is the ingestion path that does not depend on SMS permissions, and it
 * sees things SMS does not: UPI apps post "You paid ₹240 to Swiggy", which
 * carries a far cleaner merchant name than the bank's "UPI/SWGY*ORDER/123456"
 * and usually arrives first.
 *
 * The user grants access in Settings > Special app access > Notification
 * access; it cannot be requested with a runtime dialog.
 */
class PaymentNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn ?: return
        if (!NotificationAllowlist.allows(notification.packageName)) return

        runCatching {
            val extras = notification.notification?.extras ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()

            // bigText carries the full body; EXTRA_TEXT is often ellipsised.
            // For a bank SMS surfaced by the messaging app, the truncated form
            // frequently cuts off the reference number, which is the primary
            // dedupe signal — so always prefer bigText when present.
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            val body = bigText ?: text ?: return

            if (body.isBlank()) return

            val event = IngestionInbox.Event(
                channel = IngestionInbox.CHANNEL_NOTIFICATION,
                origin = notification.packageName,
                title = title,
                body = body,
                receivedAt = if (notification.postTime > 0) {
                    notification.postTime
                } else {
                    System.currentTimeMillis()
                }
            )

            IngestionInbox.add(applicationContext, event)
            IngestionBus.publish(event)
            PendingNoteNotifier.onEventCaptured(applicationContext)
        }.onFailure { error ->
            Log.w(TAG, "Failed to handle notification", error)
        }
    }

    /** Not used — a dismissed notification does not undo a payment. */
    override fun onNotificationRemoved(sbn: StatusBarNotification?) = Unit

    private companion object {
        const val TAG = "KenNotificationListener"
    }
}
