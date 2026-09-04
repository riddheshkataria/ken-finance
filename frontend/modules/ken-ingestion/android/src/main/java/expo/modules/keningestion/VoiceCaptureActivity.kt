package expo.modules.keningestion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.app.Activity
import androidx.core.content.ContextCompat

/**
 * The mic. Launched by a PendingIntent from the widget or the notification.
 *
 * Deliberately plain Android with no React Native involved: booting the RN
 * bridge to open a microphone costs 1-2 seconds, and a user standing at a
 * counter abandons (rules.md §7). Results go to VoiceNoteBuffer for JS to
 * drain later.
 */
class VoiceCaptureActivity : Activity() {

    private var recognizer: SpeechRecognizer? = null

    private var transactionId: String? = null
    private var transcript: String = ""

    private lateinit var statusView: TextView
    private lateinit var transcriptField: EditText
    private lateinit var saveButton: Button
    private lateinit var retryButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.ken_voice_capture)

        transactionId = intent.getStringExtra(KenWidgetProvider.EXTRA_TRANSACTION_ID)

        statusView = findViewById(R.id.capture_status)
        transcriptField = findViewById(R.id.capture_transcript)
        saveButton = findViewById(R.id.capture_save)
        retryButton = findViewById(R.id.capture_retry)

        saveButton.setOnClickListener { saveAndFinish() }
        retryButton.setOnClickListener { startCapture() }
        findViewById<View>(R.id.capture_dismiss).setOnClickListener { finish() }

        if (hasMicPermission()) {
            startCapture()
        } else {
            // A widget tap cannot show a permission dialog from nowhere, so the
            // Activity is the right place to ask.
            requestPermissions(
                arrayOf(Manifest.permission.RECORD_AUDIO),
                REQUEST_MIC_PERMISSION
            )
        }
    }

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MIC_PERMISSION) return

        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            startCapture()
        } else {
            statusView.setText(R.string.ken_mic_denied)
            transcriptField.visibility = View.VISIBLE
            saveButton.visibility = View.VISIBLE
        }
    }

    private fun startCapture() {
        transcript = ""
        transcriptField.setText("")
        transcriptField.visibility = View.GONE
        saveButton.visibility = View.GONE
        retryButton.visibility = View.GONE
        statusView.setText(R.string.ken_listening)

        startRecognition()
    }

    private fun startRecognition() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            statusView.setText(R.string.ken_no_recognizer)
            showEditor()
            return
        }

        releaseRecognizer()

        val newRecognizer = SpeechRecognizer.createSpeechRecognizer(this)
        newRecognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                statusView.setText(R.string.ken_listening)
            }

            override fun onPartialResults(partialResults: Bundle?) {
                firstResult(partialResults)?.let { statusView.text = it }
            }

            override fun onResults(results: Bundle?) {
                transcript = firstResult(results).orEmpty()
                showEditor()
            }

            override fun onError(error: Int) {
                statusView.setText(R.string.ken_didnt_catch)
                showEditor()
            }

            override fun onBeginningOfSpeech() = Unit
            override fun onEndOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
        }

        recognizer = newRecognizer
        runCatching { newRecognizer.startListening(intent) }.onFailure {
            statusView.setText(R.string.ken_didnt_catch)
            showEditor()
        }
    }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }

    /**
     * On-device recognition is unreliable on Hinglish and merchant names, so
     * the transcript is always shown as editable text rather than saved
     * silently. This is the correction step, not a nicety.
     */
    private fun showEditor() {
        releaseRecognizer()

        transcriptField.setText(transcript)
        transcriptField.setSelection(transcript.length)
        transcriptField.visibility = View.VISIBLE
        saveButton.visibility = View.VISIBLE
        retryButton.visibility = View.VISIBLE

        if (transcript.isBlank()) {
            statusView.setText(R.string.ken_type_instead)
        } else {
            statusView.setText(R.string.ken_confirm_note)
        }
    }

    private fun saveAndFinish() {
        val finalText = transcriptField.text?.toString()?.trim().orEmpty()
        if (finalText.isEmpty()) {
            finish()
            return
        }

        VoiceNoteBuffer.add(
            this,
            VoiceNoteBuffer.VoiceNote(
                transactionId = transactionId,
                transcript = finalText,
                audioPath = null,
                capturedAt = System.currentTimeMillis()
            )
        )

        // Chained capture: the queue head advances in JS, but the widget and
        // notification should reflect the answered item immediately.
        PendingNoteNotifier.onNoteSaved(this)
        KenWidgetProvider.refresh(this)

        finish()
    }

    private fun releaseRecognizer() {
        recognizer?.let { active ->
            try {
                active.setRecognitionListener(null)
                active.stopListening()
                active.destroy()
            } catch (_: Exception) {}
        }
        recognizer = null
    }

    override fun onDestroy() {
        releaseRecognizer()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_SOURCE = "source"
        const val SOURCE_WIDGET = "widget"
        const val SOURCE_NOTIFICATION = "notification"

        private const val REQUEST_MIC_PERMISSION = 2001
        private const val TAG = "KenVoiceCapture"
    }
}
