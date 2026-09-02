package expo.modules.keningestion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Captures incoming SMS.
 *
 * Registered statically in the manifest so it fires even when the app has
 * never been opened this boot. It does the least possible work: buffer the
 * message and return. All parsing happens in JavaScript.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        runCatching {
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return

            // A bank alert is routinely longer than 160 characters and arrives
            // as several PDUs in a single intent. Concatenating by sender
            // rebuilds the original text; handling parts individually would
            // split the amount away from the merchant and parse to nothing.
            val bySender = LinkedHashMap<String, StringBuilder>()
            var receivedAt = System.currentTimeMillis()

            for (message in messages) {
                val sender = message.originatingAddress ?: continue
                val body = message.messageBody ?: continue
                bySender.getOrPut(sender) { StringBuilder() }.append(body)
                if (message.timestampMillis > 0) {
                    receivedAt = message.timestampMillis
                }
            }

            for ((sender, body) in bySender) {
                val event = IngestionInbox.Event(
                    channel = IngestionInbox.CHANNEL_SMS,
                    origin = sender,
                    title = null,
                    body = body.toString(),
                    receivedAt = receivedAt
                )

                // Buffer first, publish second: the buffer is what survives if
                // no JS listener is attached.
                IngestionInbox.add(context, event)
                IngestionBus.publish(event)
                PendingNoteNotifier.onEventCaptured(context)
            }
        }.onFailure { error ->
            // Never crash the receiver — a malformed PDU must not stop future
            // messages from being captured.
            Log.w(TAG, "Failed to handle incoming SMS", error)
        }
    }

    private companion object {
        const val TAG = "KenSmsReceiver"
    }
}
