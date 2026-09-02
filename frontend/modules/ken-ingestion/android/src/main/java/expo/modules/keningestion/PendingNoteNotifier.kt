package expo.modules.keningestion


import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Prompts the user to say what a payment was for, moments after it happens.
 *
 * The widget is the ask, but it is passive — it only helps if the user happens
 * to be looking at their home screen. This reaches them wherever they are, and
 * costs almost nothing once VoiceCaptureActivity exists.
 *
 * Exactly one notification, updated in place. Five separate notifications for
 * five payments is how the feature gets muted in week one.
 */
object PendingNoteNotifier {

    private const val CHANNEL_ID = "ken_pending_notes"
    private const val NOTIFICATION_ID = 4201
    private const val REQUEST_OPEN = 3001

    /** Called from both capture paths when a new payment lands. */
    fun onEventCaptured(context: Context) {
        WidgetState.incrementUnparsed(context)
        show(context)
    }

    /** Called once a note has been attached, to reflect the smaller backlog. */
    fun onNoteSaved(context: Context) {
        val state = WidgetState.read(context)
        if (state.totalOutstanding <= 1) {
            // That was the last one — clear rather than show "0 to log".
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
            return
        }
        show(context)
    }

    fun show(context: Context) {
        val state = WidgetState.read(context)
        if (state.totalOutstanding <= 0) {
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
            return
        }

        ensureChannel(context)

        val title = if (state.hasParsedHead) {
            val amount = WidgetState.formatPaise(state.amountMinor ?: 0L)
            val merchant = state.merchant ?: context.getString(R.string.ken_unknown_merchant)
            context.getString(R.string.ken_notif_title_parsed, amount, merchant)
        } else {
            context.resources.getQuantityString(
                R.plurals.ken_new_payments,
                state.totalOutstanding,
                state.totalOutstanding
            )
        }

        val remaining = state.totalOutstanding - if (state.hasParsedHead) 1 else 0
        val body = if (remaining > 0) {
            context.getString(R.string.ken_more_to_log, remaining)
        } else {
            context.getString(R.string.ken_what_was_this_for)
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(captureIntent(context, state))
            .addAction(
                android.R.drawable.ic_btn_speak_now,
                context.getString(R.string.ken_add_note),
                captureIntent(context, state)
            )
            .build()

        runCatching {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        }
    }

    /**
     * Tapping the notification opens the payment it is about, rather than the
     * head of the queue: it is fresh, and making the user first recall an
     * older payment is the friction this app exists to remove.
     */
    private fun captureIntent(context: Context, state: WidgetState.Snapshot): PendingIntent {
        val intent = Intent(context, VoiceCaptureActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            putExtra(KenWidgetProvider.EXTRA_TRANSACTION_ID, state.transactionId)
            putExtra(VoiceCaptureActivity.EXTRA_SOURCE, VoiceCaptureActivity.SOURCE_NOTIFICATION)
        }

        return PendingIntent.getActivity(
            context,
            REQUEST_OPEN,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.ken_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = context.getString(R.string.ken_channel_description)
            setShowBadge(true)
        }

        manager.createNotificationChannel(channel)
    }
}
