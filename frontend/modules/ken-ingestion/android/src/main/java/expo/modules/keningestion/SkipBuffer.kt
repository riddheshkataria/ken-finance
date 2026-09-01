package expo.modules.keningestion

import android.content.Context
import org.json.JSONArray

/**
 * Skips registered from the widget while JavaScript was not running.
 *
 * Queue ordering is derived in JS (store/queue.ts), so native never reorders
 * anything — it only records that the user asked to move past an item, and JS
 * applies it as a skippedCount increment when it next runs.
 */
object SkipBuffer {

    private const val PREFS_NAME = "ken_skips"
    private const val KEY_IDS = "ids"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun add(context: Context, transactionId: String) {
        val array = read(context)
        array.put(transactionId)
        prefs(context).edit().putString(KEY_IDS, array.toString()).commit()
    }

    @Synchronized
    fun drain(context: Context): List<String> {
        val array = read(context)
        if (array.length() == 0) return emptyList()

        prefs(context).edit().remove(KEY_IDS).commit()

        return (0 until array.length()).mapNotNull { array.optString(it, null) }
    }

    private fun read(context: Context): JSONArray {
        val raw = prefs(context).getString(KEY_IDS, null) ?: return JSONArray()
        return runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
    }
}
