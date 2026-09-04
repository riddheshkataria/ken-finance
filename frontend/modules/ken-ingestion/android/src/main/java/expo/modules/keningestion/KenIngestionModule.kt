package expo.modules.keningestion

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JavaScript's view of native ingestion and live speech recognition.
 *
 * Native captures and buffers; JavaScript parses, dedupes and decides. This
 * module is only the seam between them — it holds no parsing logic, because a
 * second parser in Kotlin would drift from the tested one in TypeScript.
 */
class KenIngestionModule : Module() {

    private val context: Context
        get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

    private var speechRecognizer: SpeechRecognizer? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // Speech state machine
    private enum class SpeechState { IDLE, STARTING, LISTENING, FINISHING, DESTROYING }
    private var speechState = SpeechState.IDLE
    private var clientErrorRetryCount = 0
    private var isRetryingDefaultLocale = false
    private var pendingLocale: String? = null

    override fun definition() = ModuleDefinition {
        Name("KenIngestion")

        Events(
            EVENT_NAME,
            "KenSpeech.onSpeechStart",
            "KenSpeech.onSpeechEnd",
            "KenSpeech.onSpeechPartialResults",
            "KenSpeech.onSpeechResults",
            "KenSpeech.onSpeechError"
        )

        OnStartObserving {
            IngestionBus.setListener { event ->
                sendEvent(EVENT_NAME, event.toJsMap())
            }
        }

        OnStopObserving {
            IngestionBus.setListener(null)
            mainHandler.post { teardownRecognizer() }
        }

        // --- Permissions -------------------------------------------------

        AsyncFunction("hasSmsPermission") {
            hasPermission(Manifest.permission.RECEIVE_SMS) &&
                hasPermission(Manifest.permission.READ_SMS)
        }

        AsyncFunction("hasNotificationAccess") {
            val isEnabledByCompat = try {
                androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(context)
                    .contains(context.packageName)
            } catch (_: Exception) {
                false
            }

            if (isEnabledByCompat) {
                true
            } else {
                val enabled = Settings.Secure.getString(
                    context.contentResolver,
                    "enabled_notification_listeners"
                )
                enabled?.contains(context.packageName) == true
            }
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

        // --- Live Speech Recognition (STT) -------------------------------

        AsyncFunction("startSpeech") { locale: String? ->
            clientErrorRetryCount = 0
            isRetryingDefaultLocale = false
            pendingLocale = locale
            mainHandler.post { beginSpeechSession(locale) }
            true
        }

        AsyncFunction("stopSpeech") {
            mainHandler.post { stopSpeechInternal() }
            true
        }

        // --- Widget ------------------------------------------------------

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

    /**
     * Top-level entry: tears down any existing recognizer, waits for Android
     * to finish cleanup, then creates a fresh one. The 200ms delay between
     * destroy and create prevents ERROR_CLIENT (5) which fires when the old
     * recognizer's service binding hasn't fully released yet.
     */
    private fun beginSpeechSession(locale: String?) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            sendEvent("KenSpeech.onSpeechError", mapOf(
                "error" to "Speech recognition not available on this device",
                "code" to -1
            ))
            return
        }

        // If there's an existing recognizer, destroy it first and delay the new session
        if (speechRecognizer != null) {
            teardownRecognizer()
            // Give Android time to release the service binding
            mainHandler.postDelayed({ createAndStart(locale) }, 200)
        } else {
            createAndStart(locale)
        }
    }

    /**
     * Creates a fresh SpeechRecognizer, wires up the listener, and calls startListening.
     */
    private fun createAndStart(locale: String?) {
        if (speechState == SpeechState.DESTROYING) {
            // Still tearing down — retry after another delay
            mainHandler.postDelayed({ createAndStart(locale) }, 150)
            return
        }

        speechState = SpeechState.STARTING

        val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
        speechRecognizer = recognizer

        val requestedLocale = locale?.trim()?.takeIf { it.isNotEmpty() }

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                if (speechState == SpeechState.DESTROYING) return
                speechState = SpeechState.LISTENING
                clientErrorRetryCount = 0  // Reset retry count on successful start
                android.util.Log.i(TAG, "SpeechRecognizer: onReadyForSpeech -> LISTENING")
                sendEvent("KenSpeech.onSpeechStart", mapOf<String, Any>())
            }

            override fun onBeginningOfSpeech() {
                android.util.Log.i(TAG, "SpeechRecognizer: onBeginningOfSpeech (speech detected)")
            }

            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() {
                if (speechState == SpeechState.DESTROYING) return
                speechState = SpeechState.FINISHING
                android.util.Log.i(TAG, "SpeechRecognizer: onEndOfSpeech -> FINISHING (processing speech)")
                sendEvent("KenSpeech.onSpeechEnd", mapOf<String, Any>())
            }

            override fun onError(error: Int) {
                if (speechState == SpeechState.DESTROYING) return
                android.util.Log.w(TAG, "SpeechRecognizer: onError -> code $error")

                // --- Silently suppress benign errors ---

                // ERROR_SERVER_DISCONNECTED (11): benign socket close during transitions
                if (error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED) return

                // ERROR_NO_MATCH (7): user didn't say anything — not a real error,
                // just means the session timed out with silence. Send to JS as info,
                // not a hard failure.
                if (error == SpeechRecognizer.ERROR_NO_MATCH) {
                    speechState = SpeechState.IDLE
                    android.util.Log.i(TAG, "SpeechRecognizer: no speech detected")
                    sendEvent("KenSpeech.onSpeechError", mapOf("error" to "No speech detected", "code" to error))
                    return
                }

                // --- Auto-retry on transient errors ---

                // ERROR_CLIENT (5): Previous recognizer not fully torn down, or
                // service binding race. Retry up to MAX_CLIENT_RETRIES times with
                // increasing delay.
                if (error == SpeechRecognizer.ERROR_CLIENT && clientErrorRetryCount < MAX_CLIENT_RETRIES) {
                    clientErrorRetryCount++
                    val delay = 200L * clientErrorRetryCount  // 200ms, 400ms
                    android.util.Log.w(TAG, "ERROR_CLIENT — retry $clientErrorRetryCount/$MAX_CLIENT_RETRIES after ${delay}ms")
                    teardownRecognizer()
                    mainHandler.postDelayed({ createAndStart(requestedLocale ?: pendingLocale) }, delay)
                    return
                }

                // ERROR_RECOGNIZER_BUSY (8): Another session is still active.
                // Tear down and retry once after a delay.
                if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY && clientErrorRetryCount < 1) {
                    clientErrorRetryCount++
                    android.util.Log.w(TAG, "ERROR_RECOGNIZER_BUSY — tearing down and retrying after 300ms")
                    teardownRecognizer()
                    mainHandler.postDelayed({ createAndStart(requestedLocale ?: pendingLocale) }, 300)
                    return
                }

                // ERROR_LANGUAGE_NOT_SUPPORTED (12) / ERROR_LANGUAGE_UNAVAILABLE (13):
                // Fall back to system default locale once.
                if ((error == 12 || error == 13) && !isRetryingDefaultLocale && requestedLocale != null) {
                    isRetryingDefaultLocale = true
                    android.util.Log.w(TAG, "Locale $requestedLocale unavailable (error $error). Retrying with system default.")
                    teardownRecognizer()
                    mainHandler.postDelayed({ createAndStart(null) }, 200)
                    return
                }

                // --- Non-recoverable error — report to JS ---
                speechState = SpeechState.IDLE
                val message = when (error) {
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Speech timeout"
                    SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Permission missing"
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network error"
                    SpeechRecognizer.ERROR_CLIENT -> "Client error (retries exhausted)"
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy (retries exhausted)"
                    SpeechRecognizer.ERROR_SERVER -> "Server error"
                    10 -> "Too many requests"
                    12 -> "Language not supported"
                    13 -> "Language unavailable"
                    else -> "Recognition error code: $error"
                }
                sendEvent("KenSpeech.onSpeechError", mapOf("error" to message, "code" to error))
            }

            override fun onResults(results: Bundle?) {
                if (speechState == SpeechState.DESTROYING) return
                speechState = SpeechState.IDLE
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull() ?: ""
                android.util.Log.i(TAG, "SpeechRecognizer: onResults -> '$text'")
                sendEvent("KenSpeech.onSpeechResults", mapOf("text" to text))
            }

            override fun onPartialResults(partialResults: Bundle?) {
                if (speechState == SpeechState.DESTROYING) return
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull() ?: ""
                if (text.isNotEmpty()) {
                    android.util.Log.d(TAG, "SpeechRecognizer: onPartialResults -> '$text'")
                    sendEvent("KenSpeech.onSpeechPartialResults", mapOf("text" to text))
                }
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            if (requestedLocale != null) {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, requestedLocale)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, requestedLocale)
            }
        }

        try {
            recognizer.startListening(intent)
        } catch (e: Exception) {
            speechState = SpeechState.IDLE
            sendEvent("KenSpeech.onSpeechError", mapOf(
                "error" to (e.message ?: "Failed to start recognition"),
                "code" to -1
            ))
        }
    }

    private fun stopSpeechInternal() {
        if (speechState != SpeechState.LISTENING && speechState != SpeechState.STARTING) return
        speechState = SpeechState.FINISHING
        android.util.Log.i(TAG, "stopSpeechInternal -> calling stopListening()")
        try {
            speechRecognizer?.stopListening()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Error stopping speech", e)
        }
    }

    /**
     * Tears down the recognizer synchronously. Safe to call multiple times.
     * Sets state to DESTROYING while in progress, then IDLE when done.
     */
    private fun teardownRecognizer() {
        val recognizer = speechRecognizer ?: run {
            speechState = SpeechState.IDLE
            return
        }
        speechState = SpeechState.DESTROYING
        speechRecognizer = null
        try {
            recognizer.setRecognitionListener(null)
            recognizer.cancel()
            recognizer.destroy()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Error destroying speech recognizer", e)
        }
        speechState = SpeechState.IDLE
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED

    private fun IngestionInbox.Event.toJsMap(): Map<String, Any?> = mapOf(
        "channel" to channel,
        "origin" to origin,
        "title" to title,
        "body" to body,
        "receivedAt" to receivedAt.toDouble()
    )

    private companion object {
        const val EVENT_NAME = "KenIngestion.event"
        const val TAG = "KenIngestion"
        const val MAX_CLIENT_RETRIES = 2
    }
}
