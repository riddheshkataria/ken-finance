package expo.modules.keningestion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Staging buffer between native capture and JavaScript.
 *
 * Both capture paths — the SMS receiver and the notification listener — write
 * here, and JS drains it when the app next runs. Native must never call into
 * JS directly: a BroadcastReceiver fires whether or not React Native is alive,
 * and waiting on the bridge would drop payments (rules.md §7).
 *
 * Backed by SharedPreferences rather than Room deliberately. The buffer holds
 * a handful of events for minutes at a time, and a BroadcastReceiver can be
 * killed the instant onReceive returns — a synchronous commit with no codegen,
 * no KSP and no database migrations is the right shape for that. Room would be
 * the right call only if this became long-lived queryable storage, which it is
 * not; the transaction store lives in JS.
 */
object IngestionInbox {

    private const val PREFS_NAME = "ken_ingestion_inbox"
    private const val KEY_EVENTS = "events"

    /**
     * Hard cap so a misbehaving sender cannot grow the buffer without bound
     * while the app sits unopened. Oldest entries are dropped first.
     */
    private const val MAX_EVENTS = 500

    const val CHANNEL_SMS = "sms"
    const val CHANNEL_NOTIFICATION = "notification"

    data class Event(
        val channel: String,
        val origin: String,
        val title: String?,
        val body: String,
        val receivedAt: Long
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("channel", channel)
            put("origin", origin)
            if (title != null) put("title", title)
            put("body", body)
            put("receivedAt", receivedAt)
        }

        companion object {
            fun fromJson(json: JSONObject): Event = Event(
                channel = json.getString("channel"),
                origin = json.getString("origin"),
                title = if (json.has("title")) json.getString("title") else null,
                body = json.getString("body"),
                receivedAt = json.getLong("receivedAt")
            )
        }
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Appends an event. Synchronized because the SMS receiver and the
     * notification listener run on different threads and can fire for the
     * same payment within milliseconds of each other.
     *
     * Uses commit() rather than apply(): a BroadcastReceiver may be torn down
     * as soon as onReceive returns, and an async write would be lost.
     */
    @Synchronized
    fun add(context: Context, event: Event) {
        val existing = readArray(context)

        // Drop from the front once the cap is hit; the newest payment matters
        // more than one the user ignored for weeks.
        val trimmed = JSONArray()
        val startAt = maxOf(0, existing.length() - (MAX_EVENTS - 1))
        for (index in startAt until existing.length()) {
            trimmed.put(existing.get(index))
        }
        trimmed.put(event.toJson())

        prefs(context).edit().putString(KEY_EVENTS, trimmed.toString()).commit()
    }

    /** Returns everything buffered and clears it, as one atomic step. */
    @Synchronized
    fun drain(context: Context): List<Event> {
        val array = readArray(context)
        if (array.length() == 0) return emptyList()

        prefs(context).edit().remove(KEY_EVENTS).commit()

        val events = mutableListOf<Event>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            runCatching { Event.fromJson(item) }.getOrNull()?.let(events::add)
        }
        return events
    }

    @Synchronized
    fun size(context: Context): Int = readArray(context).length()

    private fun readArray(context: Context): JSONArray {
        val raw = prefs(context).getString(KEY_EVENTS, null) ?: return JSONArray()
        return runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
    }
}
