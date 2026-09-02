package expo.modules.keningestion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Voice notes captured natively, waiting for JavaScript to attach them.
 *
 * The capture Activity runs without the React Native bridge so the microphone
 * opens in well under a second (rules.md §7). It therefore cannot write to the
 * JS store directly — it drops the result here, and JS drains it on next run.
 */
object VoiceNoteBuffer {

    private const val PREFS_NAME = "ken_voice_notes"
    private const val KEY_NOTES = "notes"
    private const val MAX_NOTES = 200

    data class VoiceNote(
        /** The transaction this note belongs to; null means "newest pending". */
        val transactionId: String?,
        val transcript: String,
        /** Local path to the recording, so the user can replay and correct. */
        val audioPath: String?,
        val capturedAt: Long
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            if (transactionId != null) put("transactionId", transactionId)
            put("transcript", transcript)
            if (audioPath != null) put("audioPath", audioPath)
            put("capturedAt", capturedAt)
        }

        companion object {
            fun fromJson(json: JSONObject) = VoiceNote(
                transactionId = json.optString("transactionId", "").ifEmpty { null },
                transcript = json.getString("transcript"),
                audioPath = json.optString("audioPath", "").ifEmpty { null },
                capturedAt = json.getLong("capturedAt")
            )
        }
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun add(context: Context, note: VoiceNote) {
        val existing = read(context)

        val trimmed = JSONArray()
        val startAt = maxOf(0, existing.length() - (MAX_NOTES - 1))
        for (index in startAt until existing.length()) {
            trimmed.put(existing.get(index))
        }
        trimmed.put(note.toJson())

        prefs(context).edit().putString(KEY_NOTES, trimmed.toString()).commit()
    }

    @Synchronized
    fun drain(context: Context): List<VoiceNote> {
        val array = read(context)
        if (array.length() == 0) return emptyList()

        prefs(context).edit().remove(KEY_NOTES).commit()

        val notes = mutableListOf<VoiceNote>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            runCatching { VoiceNote.fromJson(item) }.getOrNull()?.let(notes::add)
        }
        return notes
    }

    private fun read(context: Context): JSONArray {
        val raw = prefs(context).getString(KEY_NOTES, null) ?: return JSONArray()
        return runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
    }
}
