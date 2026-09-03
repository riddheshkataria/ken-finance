package expo.modules.keningestion

/**
 * Delivers captured events to JavaScript while the app is running.
 *
 * Capture always writes to IngestionInbox first and publishes here second, so
 * a payment is never lost just because no listener was attached. This is a
 * fast path for the foreground case, not the system of record.
 */
object IngestionBus {

    @Volatile
    private var listener: ((IngestionInbox.Event) -> Unit)? = null

    fun setListener(newListener: ((IngestionInbox.Event) -> Unit)?) {
        listener = newListener
    }

    fun publish(event: IngestionInbox.Event) {
        // Never let a JS-side failure take down the capture path.
        runCatching { listener?.invoke(event) }
    }
}

/**
 * Apps whose notifications may describe a payment.
 *
 * This gate decides what is even buffered, so that notifications from
 * unrelated apps are never written to disk. JavaScript applies the same list
 * again before parsing — the two serve different purposes (privacy here,
 * correctness there) and must be updated together. The JS copy lives in
 * src/ingestion/extractors.ts as NOTIFICATION_PACKAGE_ALLOWLIST.
 */
object NotificationAllowlist {
    val PACKAGES = setOf(
        "com.google.android.apps.nbu.paisa.user", // Google Pay India
        "com.phonepe.app",
        "net.one97.paytm",
        "in.amazon.mShop.android.shopping",       // Amazon Pay
        "com.dreamplug.androidapp",               // CRED
        "org.npci.upi.ppbl",                      // BHIM UPI
        "com.navi.finance",                       // Navi
        "money.fi.app",                           // Fi Money
        "money.jupiter",                          // Jupiter
        "indwin.c3.shareapp",                     // Slice
        "com.supermoney.app",                     // Super.money
        "com.google.android.apps.messaging",      // Google Messages (bank SMS)
        "com.samsung.android.messaging",
        "com.android.mms"
    )

    fun allows(packageName: String?): Boolean =
        packageName != null && PACKAGES.contains(packageName)
}
