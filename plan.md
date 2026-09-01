# Ken Finance — Voice-Annotated Expense Tracker

## Context

Indian bank/UPI apps already tell you *that* you spent money. What they never capture is **why**. Existing trackers dump a list of `SWIGGY ₹240` rows and ask you to categorize them later — by which point you've forgotten that the ₹240 was a team lunch you were supposed to expense, and the ₹40 auto was a client visit.

The fix is to collect intent **at the moment of payment**, when it costs the user three seconds instead of three minutes of archaeology. A home-screen widget shows the transaction that just landed and offers one mic button. The user says "team lunch, reimbursable"; that becomes the note, the category, and later the analytics.

Current repo is a bare scaffold: an Express server with a single health route, a default Expo app, no database. Everything below is greenfield.

**Decisions locked in:** Android first (iOS later, data layer kept portable) · on-device speech-to-text with replay-and-correct · Supabase (Postgres + auth + storage) behind the existing Express API.

---

## The constraint that shapes the architecture

Reading bank SMS is the obvious design, and it is the one Google Play rejects.

`READ_SMS`/`RECEIVE_SMS` are restricted permissions with a closed permitted-use list. It does include "SMS-based financial transactions (UPI)" — but scoped to *verifying* transactions, not to personal expense tracking. Expense trackers with SMS auto-import get rejected on exactly this line.

**Decision: both channels run concurrently, with notifications as the one that survives review.**

SMS gives the widest bank coverage and allows historical backfill; notifications sidestep the SMS policy entirely and carry better merchant names. Running both means a single payment arrives two or three times, so deduplication — not capture — is the load-bearing piece.

**Notifications are the primary source, not the fallback.** `NotificationListenerService` is not in the SMS permission group at all, so it sidesteps that policy entirely. It's governed by ordinary sensitive-data rules: prominent disclosure, a privacy policy, and don't exfiltrate more than you need — all satisfiable.

Two things make notifications *better* than SMS here, not merely safer:

1. **A bank SMS still reaches us.** When the bank texts, the default messaging app posts a notification; `EXTRA_BIG_TEXT` carries the full body. We read the SMS content without ever holding an SMS permission.
2. **UPI apps are richer than the bank.** GPay/PhonePe/Paytm/CRED post `You paid ₹240 to Swiggy` — cleaner merchant names than the bank's `UPI/SWGY*ORDER/123456`, and usually **faster** than the SMS.

Honest tradeoffs: notification access is granted in Settings → Special app access, not a normal permission dialog (one-time friction, needs a good onboarding screen); there is **no historical backfill** (SMS inbox can be queried, notifications cannot — day one starts empty); and a muted or instantly-dismissed notification is a missed transaction. Manual entry stays as the safety net.

`READ_SMS` ships alongside it. If Play ever rejects the SMS declaration, removing that permission degrades coverage without breaking the app, because the notification path already carries bank SMS through the messaging app's notification.

---

## Architecture

```
Bank / UPI notification
        │
        ▼
[Kotlin] SmsReceiver + NotificationListener ──► staging buffer (raw, unparsed)
        │                                        │
        │ (posts immediately)                    │ drained on app foreground
        ▼                                        ▼
  Widget update  +  "🎤 Add note" notification   [JS] Parser → dedupe → SQLite
        │
        │ mic tap → PendingIntent
        ▼
[Kotlin] VoiceCaptureActivity (translucent)
   SpeechRecognizer + MediaRecorder in parallel
        │
        └──► transcript + audio file → Room inbox → SQLite → sync queue
                                                          │
                                                          ▼
                                          Express API ──► Supabase Postgres
                                                │
                                                └─► Claude (categorization)
```

**The hot path is entirely native Kotlin.** This is the single most important performance decision in the plan. Booting the React Native bridge to open a microphone takes 1–2 seconds; a user standing at a counter will abandon. Kotlin writes to a staging buffer, and JS drains it later when the app is opened.

**The staging buffer is SharedPreferences-backed JSON, not Room.** It holds a handful of events for minutes at a time, and a `BroadcastReceiver` can be killed the instant `onReceive` returns — a synchronous `commit()` with no codegen, no KSP and no migrations fits that shape. Room would be right only if this became long-lived queryable storage, and it does not: the transaction store lives in JS. `react-native-android-widget` renders the widget's *appearance* from React components, but must not be on the capture path.

### Native module

Write **one Kotlin Expo module** (~400 lines) rather than depending on three community libraries. `expo-widgets` is iOS-only; the SMS libraries are tested up to Expo SDK 50 and this project is on 57. The module owns:

- `SmsReceiver` (static registration, multipart reassembly)
- `NotificationListenerService` + package allowlist (bank apps, UPI apps, messaging apps)
- `AppWidgetProvider` + `RemoteViews` updates
- `VoiceCaptureActivity` (translucent, `showWhenLocked`)
- `PendingNoteNotifier` — one in-place-updating notification with a mic action
- The staging buffers and their JS bridge

Android details that will bite otherwise: widgets are `RemoteViews` and **cannot** record audio or host arbitrary views — the mic must be a `PendingIntent`. Android 12+ requires explicit `FLAG_IMMUTABLE`/`FLAG_MUTABLE` on every `PendingIntent`. Background activity starts are blocked on 12+, but a widget tap is user-initiated and therefore allowed. `updatePeriodMillis` has a 30-minute floor — irrelevant, since we push updates imperatively.

---

## Data model

Mirrored between on-device SQLite (source of truth, offline-first) and Supabase Postgres.

**Money is `amount_minor BIGINT` — paise, never floats.** Non-negotiable in a finance app; `0.1 + 0.2` problems become silent wrong balances.

```
users(id, phone, tz, currency, created_at)
accounts(id, user_id, bank_name, account_tail, type, display_name)
categories(id, user_id NULL=global, name, icon, color, parent_id, is_income)
merchants(id, user_id, raw_pattern, normalized_name, default_category_id, seen_count)

transactions(
  id uuid, user_id, account_id,
  amount_minor bigint,                    -- paise
  direction  ('debit' | 'credit'),
  occurred_at timestamptz,
  merchant_raw, merchant_id,
  category_id, note, note_source ('voice'|'manual'|'auto'|'none'),
  transcript, audio_path,                 -- audio kept for replay-and-correct
  ref_no, source ('notification'|'sms'|'manual'),
  dedupe_key UNIQUE,
  confidence real,
  status ('pending_note'|'complete'|'ignored'|'needs_review'),
  skipped_count int default 0,            -- queue ordering + rot detection
  last_prompted_at timestamptz,
  raw_payload jsonb,
  created_at, updated_at, deleted_at
)

budgets(id, user_id, category_id, period, amount_minor, starts_on, rollover)
parse_rules(id, version, bank_key, pattern, field_map jsonb, priority, active)
```

`raw_payload` keeps the original text forever — every parser bug is then retroactively fixable without having lost data.

---

## Ingestion pipeline

**Parse.** A versioned JSON rule pack stored in `parse_rules` and fetched at runtime, so a new bank's format ships **without an app release**. Regex per bank extracting: amount, direction, account tail, merchant/VPA, timestamp, reference number.

Real-world shapes to cover:
```
Sent Rs.240.00 From HDFC Bank A/C x1234 To SWIGGY On 01/09/26 Ref 123456789012
Dear UPI user A/C X1234 debited by 240.0 on date 01Sep26 trf to SWIGGY Refno 1234
INR 240.00 debited from A/c XX1234 on 01-09-26 to VPA swiggy@ybl (UPI Ref 1234)
You paid ₹240 to Swiggy                                    ← GPay, cleanest
```

**Dedupe is the make-or-break step.** One payment fires a GPay notification *and* a bank SMS notification, sometimes two SMS. Double-counting destroys trust in the numbers faster than any other bug.
- Primary: exact match on `ref_no` when present.
- Fallback: `(amount_minor, account_tail, ±180s)` window.
- Prefer the UPI-app record when both arrive (better merchant name), but keep the bank's `ref_no`.

**Reject aggressively.** OTPs, promotional offers ("Get a loan!"), balance alerts, failed/reversed transactions, and collect *requests* (money asked for, not paid) must never become transactions. A false positive is worse than a miss.

**Unparsed messages** go to Express → Claude structured extraction → returns the fields *plus a proposed regex*, which is queued for review and then shipped to every user via the rule pack. The parser improves itself. **Redact before sending** (account numbers to last 4, strip names and ref numbers) and make this path opt-in.

---

## Widget + voice capture

The centerpiece. Flow:

1. Listener catches a debit → parse → SQLite → `status = 'pending_note'`
2. **Two nudges fire at once:**
   - Widget re-renders: `₹240 · Swiggy · 2m ago` + a large mic button
   - High-priority notification with a `🎤 Add note` action
3. Tap mic → `PendingIntent` → `VoiceCaptureActivity` (translucent bottom sheet, mic live in <300ms)
4. `SpeechRecognizer` **and** `MediaRecorder` run in parallel — the audio file is what makes replay-and-correct possible
5. Transcript appears inline with a ~2s auto-confirm, plus **`▶ Replay`** and **`Edit`**
6. Save → Room → SQLite → sync queue → Supabase
7. Widget advances to the next item in the pending queue, or shows `All caught up ✓`

### The pending-note queue

Multiple unlogged payments must not collapse into "only the latest one is reachable." Every transaction with `status = 'pending_note'` sits in an ordered backlog, and the user works it down one at a time.

**Ordering:** `ORDER BY skipped_count ASC, occurred_at ASC` — oldest-first FIFO, with skipped items sinking to the back. Never persist an explicit `queue_position`; it drifts the moment a late notification arrives out of order.

**Widget** always renders the head of the queue plus a backlog count:

```
┌────────────────────────────┐
│  ₹240 · Swiggy · 2m ago    │
│         (  🎤  )           │
│  +4 more to log      Skip  │
└────────────────────────────┘
```

`RemoteViews` can't render a scrollable list well — show the head and the count, nothing more.

**Chained capture is the main UX win.** After a note is saved, if the queue is non-empty the capture Activity does **not** dismiss — it slides to the next item and re-arms the mic. Four pending payments become one continuous 20-second session instead of four separate home-screen trips.

**Entry point decides the starting item.** Strict oldest-first is right for the widget, but wrong for the notification: if you just paid for lunch and the queue head is yesterday's ₹40 auto, forcing you to recall the auto first is exactly the friction this app exists to remove.

- Tap mic on the **notification** → jump straight to *that* transaction (it's fresh — capture it while it's free), then continue into the queue
- Tap mic on the **widget** → start at the queue head

**A blocking queue needs escape hatches, or it rots.** If the head is something genuinely unrecallable, it must not wall off everything behind it:

- **Skip** → `skipped_count++`, sinks to the back, user moves on
- **Ignore** → `status = 'ignored'` for transfers to self, ATM withdrawals, anything not worth a note
- **Auto-retire** → after 3 skips or 7 days, `status = 'needs_review'`; it leaves the widget queue entirely and lands in an in-app list. The widget must never show a permanently stuck item, because one un-clearable card teaches the user to ignore the widget for good.

**One notification, not N.** Post a single notification that updates in place with the queue head and count. Five separate notifications for five payments is how the feature gets muted in week one.

**Snapshot on open.** If a new payment lands while the capture Activity is in the foreground, don't reorder underneath the user — snapshot the queue when the Activity opens and re-read it after each save.

**Build the notification action alongside the widget.** The widget is the ask, but it's passive — it only helps if the user happens to be on their home screen. The notification reaches them wherever they are, costs almost nothing extra once the Activity exists, and will drive most of the real capture. The widget then does what it's genuinely good at: the ambient `3 uncategorized` nudge that makes the backlog visible.

Expect the Android 12+ green microphone indicator during recording — that's correct and unavoidable behaviour.

**On-device STT caveat, per your call:** Android's `SpeechRecognizer` is mediocre on Hinglish and merchant names. "Chai with the team" may come back as "chai with the tim". The replay-and-edit UI is therefore load-bearing, not a nicety — budget real design time for it. Keep the transcription call behind an interface so a cloud model can be swapped in later without touching the capture flow.

---

## Categorization

Three tiers, cheapest first:

1. **Merchant memory** — user categorizes `Swiggy` once, every future Swiggy is automatic. Free, instant, and after a few weeks covers ~80% of transactions. This alone solves most of the tedium complaint.
2. **Shipped merchant dictionary** — a few hundred common Indian merchants pre-mapped, so the app isn't useless on day one.
3. **Claude** — only for genuinely new merchants, using the voice transcript as the signal. "Chai with the team" → `Food & Drink`, note preserved, `reimbursable` tag inferred.

Use `claude-opus-5` via `@anthropic-ai/sdk` in the Express layer, with structured outputs (`output_config: { format: ... }`) so the response is schema-valid. Prompt-cache the category taxonomy and few-shot examples — they're identical on every call, so cache reads cut input cost ~10x. Route non-urgent backfill through the **Batch API at 50% cost**.

Rough economics: ~₹0.40/transaction uncached at Opus pricing, but tier 1 absorbs ~80% of volume and caching cuts most of the rest — landing near **₹10–20/user/month** at ~200 transactions. If that's still too high, `claude-haiku-4-5` ($1/$5 per 1M vs $5/$25) is roughly 5x cheaper and adequate for short-text classification; that's a cost/quality call worth making with real data rather than upfront.

---

## Budgets & analytics

The payoff that makes the captured notes worth having:

- Monthly budget per category, with **burn rate vs. days remaining** — not just "you spent ₹4,200" but "you're 70% through the month and 90% through the food budget"
- **Safe-to-spend-today** — the single number people actually act on
- Merchant leaderboard, recurring-subscription detection (same merchant, same amount, ~30d cadence)
- Weekly review notification — the natural moment to clean up anything still `pending_note`
- Free-text search over transcripts: *"what did I spend on client meetings?"* — this is the feature the voice notes uniquely unlock, and no other tracker has it

---

## Phases

| # | Phase | Outcome |
|---|-------|---------|
| 0 | **Foundations** — `expo prebuild` → dev build, Supabase project + schema + phone-OTP auth, shared types | Expo Go no longer works; dev loop changes |
| 1 | **Native ingestion** — Kotlin notification listener → Room → JS bridge | Raw payments land in the DB |
| 2 | **Parser + list UI** — rule pack, dedupe, transaction list, manual categorize | **App is genuinely useful here** |
| 3 | **Widget + voice capture** — `AppWidgetProvider`, `VoiceCaptureActivity`, pending-note queue with chained capture, notification action | The differentiator ships |
| 4 | **Smart categorization** — merchant memory → dictionary → Claude | Tedium actually disappears |
| 5 | **Budgets + analytics** | The reason to keep using it |

Phase 2 is the honest MVP line — everything after it is leverage on a product that already works.

**Phase 0 has a consequence worth stating plainly:** native modules mean no more Expo Go. Every developer needs a custom dev client installed, and testing requires a real device (notification listeners and widgets don't meaningfully work on emulators).

---

## Verification

**Parser — the one thing that must be tested properly.** Build a fixture corpus of ~200 real, redacted notification and SMS bodies as JSON, and run the parser over it in Jest asserting every extracted field. This is how you develop parsing without spending real money on test transactions, and it's the regression net when you add a new bank. Include the reject cases (OTPs, promos, collect requests) as explicit expected-nulls.

**Dedupe:** feed paired GPay + bank-SMS fixtures for the same payment; assert exactly one transaction row.

**Ingestion:** dev-only screen that injects a fake notification payload directly into the Room inbox, bypassing the listener.

**Widget and ingestion in Android Studio:** the emulator covers most of this. Extended Controls → Phone → SMS sends a real bank-shaped SMS through the actual `SmsReceiver`, so the SMS path needs no real money to test. `adb shell dumpsys notification` confirms the listener is bound. UPI app notifications cannot be produced on an emulator — use `simulateEvent` for those. A physical device is only needed for genuine bank/UPI notifications and for judging real microphone accuracy.

**Queue:** inject 4 fake transactions with staggered timestamps; assert the widget shows the oldest and `+3 more`, that chained capture walks all four without returning to the home screen, that a skipped item reappears at the back, and that an item skipped 3 times leaves the widget for `needs_review`.

**Capture latency:** time from mic tap to microphone-live. Target <300ms; if it exceeds ~800ms, something has pulled the RN bridge onto the hot path.

**End-to-end:** make one real ₹1 UPI payment → widget updates → voice note → transcript saved → row synced to Supabase with correct paise value and category.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Play rejects even notification access | Prominent disclosure + privacy policy; manual entry keeps the app functional without it; sideload build as fallback |
| On-device STT too weak for Hinglish | Replay-and-edit UI is built from day one; transcription sits behind a swappable interface |
| Bank changes SMS format | Rule pack is server-fetched — fix ships without an app release; `raw_payload` allows retroactive reparse |
| Double-counted transactions | Dedupe fixtures in CI; `dedupe_key` is a DB-level UNIQUE constraint, not just app logic |
| Pending queue grows faster than the user clears it | Skip/Ignore always available; auto-retire after 3 skips or 7 days so the widget never shows an un-clearable card; weekly review notification to drain the backlog |
| User never grants notification access | Onboarding screen that explains the value before sending them to Settings, with a deep link |
| No historical data on install | Set expectations in onboarding; optional CSV/statement import as a later phase |
