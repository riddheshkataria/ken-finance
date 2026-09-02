package expo.modules.keningestion

import android.content.Context

/**
 * What the home-screen widget should currently display.
 *
 * There are two ways this gets set, and the difference matters:
 *
 *  - JavaScript pushes a fully parsed queue head (amount, merchant) whenever
 *    the app runs. This is the good case.
 *  - Native capture happens even when JavaScript is dead, and parsing lives in
 *    JavaScript. Rather than duplicate the parser in Kotlin — two parsers that
 *    drift apart is a worse failure than a vague widget — the widget falls
 *    back to an honest "N new payments" until JS next runs and fills in detail.
 */
object WidgetState {

    private const val PREFS_NAME = "ken_widget_state"
    private const val KEY_TRANSACTION_ID = "transactionId"
    private const val KEY_AMOUNT_MINOR = "amountMinor"
    private const val KEY_MERCHANT = "merchant"
    private const val KEY_PENDING_COUNT = "pendingCount"
    private const val KEY_UNPARSED_COUNT = "unparsedCount"

    data class Snapshot(
        val transactionId: String?,
        /** Integer paise, or null when JS has not parsed this yet. */
        val amountMinor: Long?,
        val merchant: String?,
        /** Payments JS knows about and that still need a note. */
        val pendingCount: Int,
        /** Captured natively but not yet seen by JS. */
        val unparsedCount: Int
    ) {
        /** Total the user should be told about, however it was counted. */
        val totalOutstanding: Int get() = pendingCount + unparsedCount

        val hasParsedHead: Boolean get() = transactionId != null && amountMinor != null
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Called from JavaScript with the real queue head. */
    fun setParsedHead(
        context: Context,
        transactionId: String?,
        amountMinor: Long?,
        merchant: String?,
        pendingCount: Int
    ) {
        prefs(context).edit()
            .putString(KEY_TRANSACTION_ID, transactionId)
            .putLong(KEY_AMOUNT_MINOR, amountMinor ?: -1L)
            .putString(KEY_MERCHANT, merchant)
            .putInt(KEY_PENDING_COUNT, pendingCount)
            // JS has now accounted for everything captured before this call.
            .putInt(KEY_UNPARSED_COUNT, 0)
            .apply()

        KenWidgetProvider.refresh(context)
    }

    /** Called from the capture paths when JS may not be running. */
    @Synchronized
    fun incrementUnparsed(context: Context) {
        val current = prefs(context).getInt(KEY_UNPARSED_COUNT, 0)
        prefs(context).edit().putInt(KEY_UNPARSED_COUNT, current + 1).apply()
        KenWidgetProvider.refresh(context)
    }

    fun read(context: Context): Snapshot {
        val store = prefs(context)
        val amount = store.getLong(KEY_AMOUNT_MINOR, -1L)
        return Snapshot(
            transactionId = store.getString(KEY_TRANSACTION_ID, null),
            amountMinor = if (amount >= 0) amount else null,
            merchant = store.getString(KEY_MERCHANT, null),
            pendingCount = store.getInt(KEY_PENDING_COUNT, 0),
            unparsedCount = store.getInt(KEY_UNPARSED_COUNT, 0)
        )
    }

    /** Formats paise for display, e.g. 24050 -> "₹240.50", 24000 -> "₹240". */
    fun formatPaise(amountMinor: Long): String {
        val whole = amountMinor / 100
        val fraction = (amountMinor % 100).toInt()
        val grouped = groupIndian(whole)
        return if (fraction == 0) "₹$grouped" else "₹$grouped.%02d".format(fraction)
    }

    /**
     * Indian digit grouping: last three digits, then pairs (1,00,000).
     * Written out because android's default Locale formatting is not
     * guaranteed to be en-IN on the user's device.
     */
    private fun groupIndian(value: Long): String {
        val digits = value.toString()
        if (digits.length <= 3) return digits

        val head = digits.substring(0, digits.length - 3)
        val tail = digits.substring(digits.length - 3)

        val grouped = StringBuilder()
        var index = head.length
        while (index > 2) {
            grouped.insert(0, "," + head.substring(index - 2, index))
            index -= 2
        }
        if (index > 0) grouped.insert(0, head.substring(0, index))

        return "$grouped,$tail"
    }
}
