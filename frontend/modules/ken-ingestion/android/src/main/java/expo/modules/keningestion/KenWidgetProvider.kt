package expo.modules.keningestion

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews

/**
 * The home-screen widget: the payment awaiting a note, and a mic to answer it.
 *
 * A widget is RemoteViews — it cannot record audio or host arbitrary views, so
 * the mic is a PendingIntent that launches VoiceCaptureActivity. Updates are
 * pushed imperatively from capture and from JS; updatePeriodMillis has a
 * 30-minute floor and is useless for this.
 */
class KenWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (widgetId in appWidgetIds) {
            appWidgetManager.updateAppWidget(widgetId, buildViews(context))
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)

        if (intent.action == ACTION_SKIP) {
            val transactionId = intent.getStringExtra(EXTRA_TRANSACTION_ID)
            if (transactionId != null) {
                // Recorded for JS to apply; the queue order itself is derived
                // in JS so native only registers the intent to skip.
                SkipBuffer.add(context, transactionId)
            }
            refresh(context)
        }
    }

    companion object {
        const val ACTION_SKIP = "expo.modules.keningestion.WIDGET_SKIP"
        const val EXTRA_TRANSACTION_ID = "transactionId"

        /** Re-renders every placed instance of the widget. */
        fun refresh(context: Context) {
            runCatching {
                val manager = AppWidgetManager.getInstance(context)
                val component = ComponentName(context, KenWidgetProvider::class.java)
                val ids = manager.getAppWidgetIds(component)
                if (ids.isEmpty()) return

                val views = buildViews(context)
                for (widgetId in ids) {
                    manager.updateAppWidget(widgetId, views)
                }
            }
        }

        private fun buildViews(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.ken_widget)
            val state = WidgetState.read(context)

            when {
                state.hasParsedHead -> {
                    views.setTextViewText(
                        R.id.widget_amount,
                        WidgetState.formatPaise(state.amountMinor ?: 0L)
                    )
                    views.setTextViewText(
                        R.id.widget_merchant,
                        state.merchant ?: context.getString(R.string.ken_unknown_merchant)
                    )
                    views.setViewVisibility(R.id.widget_mic, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_skip, View.VISIBLE)
                }

                state.totalOutstanding > 0 -> {
                    // Captured but not yet parsed — JS has not run since. Say
                    // something true rather than guessing at the amount.
                    views.setTextViewText(
                        R.id.widget_amount,
                        context.resources.getQuantityString(
                            R.plurals.ken_new_payments,
                            state.totalOutstanding,
                            state.totalOutstanding
                        )
                    )
                    views.setTextViewText(
                        R.id.widget_merchant,
                        context.getString(R.string.ken_tap_to_log)
                    )
                    views.setViewVisibility(R.id.widget_mic, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_skip, View.GONE)
                }

                else -> {
                    views.setTextViewText(
                        R.id.widget_amount,
                        context.getString(R.string.ken_all_caught_up)
                    )
                    views.setTextViewText(R.id.widget_merchant, "")
                    views.setViewVisibility(R.id.widget_mic, View.GONE)
                    views.setViewVisibility(R.id.widget_skip, View.GONE)
                }
            }

            val remaining = state.totalOutstanding - if (state.hasParsedHead) 1 else 0
            views.setTextViewText(
                R.id.widget_backlog,
                if (remaining > 0) {
                    context.getString(R.string.ken_more_to_log, remaining)
                } else {
                    ""
                }
            )

            views.setOnClickPendingIntent(R.id.widget_mic, micIntent(context, state))
            views.setOnClickPendingIntent(R.id.widget_skip, skipIntent(context, state))

            return views
        }

        private fun micIntent(context: Context, state: WidgetState.Snapshot): PendingIntent {
            val intent = Intent(context, VoiceCaptureActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                // No transaction id means "start at the queue head", which is
                // exactly what a widget tap should do.
                putExtra(EXTRA_TRANSACTION_ID, state.transactionId)
                putExtra(VoiceCaptureActivity.EXTRA_SOURCE, VoiceCaptureActivity.SOURCE_WIDGET)
            }

            // FLAG_IMMUTABLE is required from Android 12; the extras are fixed
            // at creation so there is nothing for a recipient to fill in.
            return PendingIntent.getActivity(
                context,
                REQUEST_MIC,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun skipIntent(context: Context, state: WidgetState.Snapshot): PendingIntent {
            val intent = Intent(context, KenWidgetProvider::class.java).apply {
                action = ACTION_SKIP
                putExtra(EXTRA_TRANSACTION_ID, state.transactionId)
            }

            return PendingIntent.getBroadcast(
                context,
                REQUEST_SKIP,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private const val REQUEST_MIC = 1001
        private const val REQUEST_SKIP = 1002
    }
}
