package expo.modules.keningestion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.File

/**
 * The mic. Launched by a PendingIntent from the widget or the notification.
 *
 * Deliberately plain Android with no React Native involved: booting the RN
 * bridge to open a microphone costs 1-2 seconds, and a user standing at a
 * counter abandons (rules.md §7). Results go to VoiceNoteBuffer for JS to
 * drain later.
 */
class VoiceCaptureActivity : ComponentActivity() {

    private var recognizer: SpeechRecognizer? = null
    private var recorder: MediaRecorder? = null
    private var audioFile: File? = null

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
            ActivityCompat.requestPermissions(
                this,
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

        // Best effort only. On most devices SpeechRecognizer takes exclusive
        // hold of the microphone, so a parallel raw recording frequently fails
        // to start. Recognition is the feature that must work; the audio file
        // is what enables replay-and-correct, so we try for it and carry on
        // without it when the device refuses.
        startRecordingBestEffort()
        startRecognition()
    }

    private fun startRecordingBestEffort() {
        runCatching {
            val target = File(filesDir, "voice_notes").apply { mkdirs() }
                .resolve("note_${System.currentTimeMillis()}.m4a")

            val newRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            newRecorder.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setOutputFile(target.absolutePath)
                prepare()
                start()
            }

            recorder = newRecorder
            audioFile = target
        }.onFailure { error ->
            // Expected on most devices. Not an error the user should see.
            Log.i(TAG, "Parallel audio capture unavailable; transcript only", error)
            releaseRecorder(deleteFile = true)
        }
    }

    private fun startRecognition() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            statusView.setText(R.string.ken_no_recognizer)
            showEditor()
            return
        }

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
                // A busy microphone almost always means our own MediaRecorder
                // won the race. Drop the recording and retry transcript-only
                // rather than failing the capture.
                if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY && recorder != null) {
                    releaseRecorder(deleteFile = true)
                    startRecognition()
                    return
                }

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
            // en-IN handles Indian-accented English and the Hinglish that
            // shows up in these notes far better than the en-US default.
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
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
        releaseRecorder(deleteFile = false)
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
                audioPath = audioFile?.absolutePath,
                capturedAt = System.currentTimeMillis()
            )
        )

        // Chained capture: the queue head advances in JS, but the widget and
        // notification should reflect the answered item immediately.
        PendingNoteNotifier.onNoteSaved(this)
        KenWidgetProvider.refresh(this)

        finish()
    }

    private fun releaseRecorder(deleteFile: Boolean) {
        recorder?.let { active ->
            runCatching { active.stop() }
            runCatching { active.release() }
        }
        recorder = null

        if (deleteFile) {
            audioFile?.delete()
            audioFile = null
        }
    }

    private fun releaseRecognizer() {
        recognizer?.let { active ->
            runCatching { active.stopListening() }
            runCatching { active.destroy() }
        }
        recognizer = null
    }

    override fun onDestroy() {
        releaseRecorder(deleteFile = false)
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
