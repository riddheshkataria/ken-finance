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
 *
 * Requesting SMS permission is deliberately absent: RECEIVE_SMS and READ_SMS
 * are ordinary runtime permissions, so React Native's PermissionsAndroid
 * handles them once the manifest declares them. Reimplementing the request
 * here would mean owning the activity-result plumbing for no benefit.
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
                    "capturedAt" to note.capturedAt.toDouble()
                )
            }
        }

        AsyncFunction("drainSkips") {
            SkipBuffer.drain(context)
        }

        // --- Widget ------------------------------------------------------

        /**
         * Parameters are explicit rather than a loose map: Expo converts
         * primitives reliably, and amounts arrive as Double because
         * JavaScript numbers have no integer type on the bridge. The value is
         * still integer paise — it is converted, never rounded.
         */
        AsyncFunction("updateWidget") { transactionId: String?,
                                        amountMinor: Double?,
                                        merchant: String?,
                                        pendingCount: Int ->
            WidgetState.setParsedHead(
                context = context,
                transactionId = transactionId,
                amountMinor = amountMinor?.toLong(),
                merchant = merchant,
                pendingCount = pendingCount
            )
            PendingNoteNotifier.show(context)
        }

        /** Dev affordance: pushes a fake event through the real native path. */
        AsyncFunction("simulateEvent") { channel: String,
                                         origin: String,
                                         title: String?,
                                         body: String ->
            val event = IngestionInbox.Event(
                channel = channel,
                origin = origin,
                title = title,
                body = body,
                receivedAt = System.currentTimeMillis()
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
        // Double, not Long: the bridge has no integer type and a Long can be
        // silently truncated on the way across.
        "receivedAt" to receivedAt.toDouble()
    )

    private companion object {
        const val EVENT_NAME = "KenIngestion.event"
    }
}
