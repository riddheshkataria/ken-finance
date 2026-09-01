package expo.modules.keningestion

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JavaScript's view of native ingestion.
 *
 * Native captures and buffers; JavaScript parses, dedupes and decides. This
 * module is only the seam between them — it holds no parsing logic, because a
 * second parser in Kotlin would drift from the tested one in TypeScript.
 */
class KenIngestionModule : Module() {

    private val context: Context
        get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

    override fun definition() = ModuleDefinition {
        Name("KenIngestion")

        Events(EVENT_NAME)

        OnStartObserving {
            // Live delivery while the app is foregrounded. The inbox remains
            // the system of record for everything captured while it was not.
            IngestionBus.setListener { event ->
                sendEvent(EVENT_NAME, event.toJsMap())
            }
        }

        OnStopObserving {
            IngestionBus.setListener(null)
        }

        // --- Permissions -------------------------------------------------

        AsyncFunction("hasSmsPermission") {
            hasPermission(Manifest.permission.RECEIVE_SMS) &&
                hasPermission(Manifest.permission.READ_SMS)
        }

        AsyncFunction("requestSmsPermission") { promise: expo.modules.kotlin.Promise ->
            // Expo's permission helper handles the activity result plumbing.
            val activity = appContext.activityProvider?.currentActivity
            if (activity == null) {
                promise.resolve(false)
                return@AsyncFunction
            }

            androidx.core.app.ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS),
                REQUEST_SMS_PERMISSION
            )

            // The dialog is asynchronous and Android gives no callback here;
            // JS re-reads state on the next foreground via refreshPermissions.
            promise.resolve(
                hasPermission(Manifest.permission.RECEIVE_SMS) &&
                    hasPermission(Manifest.permission.READ_SMS)
            )
        }

        /**
         * Notification access is a "special app access" toggle, not a runtime
         * permission — there is no dialog to show, only a settings screen.
         */
        AsyncFunction("hasNotificationAccess") {
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                "enabled_notification_listeners"
            )
            enabled?.contains(context.packageName) == true
        }

        AsyncFunction("openNotificationAccessSettings") {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }

        // --- Buffers -----------------------------------------------------

        AsyncFunction("drainInbox") {
            IngestionInbox.drain(context).map { it.toJsMap() }
        }

        AsyncFunction("drainVoiceNotes") {
            VoiceNoteBuffer.drain(context).map { note ->
                mapOf(
                    "transactionId" to note.transactionId,
                    "transcript" to note.transcript,
                    "audioPath" to note.audioPath,
                    "capturedAt" to note.capturedAt
                )
            }
        }

        AsyncFunction("drainSkips") {
            SkipBuffer.drain(context)
        }

        // --- Widget ------------------------------------------------------

        AsyncFunction("updateWidget") { payload: Map<String, Any?> ->
            WidgetState.setParsedHead(
                context = context,
                transactionId = payload["transactionId"] as? String,
                amountMinor = (payload["amountMinor"] as? Number)?.toLong(),
                merchant = payload["merchant"] as? String,
                pendingCount = (payload["pendingCount"] as? Number)?.toInt() ?: 0
            )
            PendingNoteNotifier.show(context)
        }

        /** Dev affordance: push a fake event through the real native path. */
        AsyncFunction("simulateEvent") { payload: Map<String, Any?> ->
            val event = IngestionInbox.Event(
                channel = payload["channel"] as? String ?: IngestionInbox.CHANNEL_SMS,
                origin = payload["origin"] as? String ?: "AD-HDFCBK",
                title = payload["title"] as? String,
                body = payload["body"] as? String ?: "",
                receivedAt = (payload["receivedAt"] as? Number)?.toLong()
                    ?: System.currentTimeMillis()
            )
            IngestionInbox.add(context, event)
            IngestionBus.publish(event)
            PendingNoteNotifier.onEventCaptured(context)
        }
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED

    private fun IngestionInbox.Event.toJsMap(): Map<String, Any?> = mapOf(
        "channel" to channel,
        "origin" to origin,
        "title" to title,
        "body" to body,
        "receivedAt" to receivedAt
    )

    private companion object {
        const val EVENT_NAME = "KenIngestion.event"
        const val REQUEST_SMS_PERMISSION = 4001
    }
}
