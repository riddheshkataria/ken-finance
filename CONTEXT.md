# Ken Finance — Project Context & Architecture

> **Purpose**: Current implementation state for developers and AI coding agents working on **Ken Finance**.
>
> **Reading order for a new agent:** `rules.md` (binding conventions) → `plan.md` (architecture and roadmap) → this file → `todo_next.md` (what to do next, written to be executed autonomously).

---

## 1. Product Vision & Problem Statement

**The Problem**: Traditional expense trackers show *that* money was spent (`SWIGGY ₹240`) but never capture **why**. Users forget the context of a payment within days.

**The Solution**: Capture intent **at the moment of payment**:

- **Dual-channel ingestion** — bank SMS *and* UPI app notifications (GPay, PhonePe, Paytm, CRED), running concurrently.
- **Instant voice capture** — a home-screen widget and a notification action, both opening a native mic sheet in well under a second.
- **Two-way matching** — a spoken note recorded before or during payment reconciles against the bank record that follows; a bank record with no note joins a queue asking the user what it was for.

---

## 2. Repository Layout

```
ken-finance/
├── rules.md                         # Binding engineering conventions — read first
├── plan.md                          # Architecture & roadmap
├── CONTEXT.md                       # This file
├── backend/                         # Node.js Express backend (health route only so far)
└── frontend/                        # React Native (Expo SDK 57) client
    ├── App.tsx
    ├── modules/ken-ingestion/       # Local Expo module — all Android native code
    │   ├── expo-module.config.json
    │   └── android/src/main/
    │       ├── AndroidManifest.xml
    │       ├── java/expo/modules/keningestion/
    │       │   ├── KenIngestionModule.kt        # JS bridge
    │       │   ├── SmsReceiver.kt               # SMS capture
    │       │   ├── PaymentNotificationListener.kt
    │       │   ├── IngestionInbox.kt            # staging buffer
    │       │   ├── VoiceNoteBuffer.kt           # captured notes awaiting JS
    │       │   ├── SkipBuffer.kt                # widget skips awaiting JS
    │       │   ├── WidgetState.kt               # what the widget displays
    │       │   ├── KenWidgetProvider.kt         # home-screen widget
    │       │   ├── VoiceCaptureActivity.kt      # the mic sheet
    │       │   └── PendingNoteNotifier.kt       # single updating notification
    │       └── res/                             # layouts, strings, theme
    └── src/
        ├── types/transaction.ts     # Transaction interface & enums
        ├── ingestion/               # PURE: parse -> dedupe -> materialise
        │   ├── types.ts             #   IngestionEvent, rejection reasons
        │   ├── extractors.ts        #   pure field extraction
        │   ├── parseEvent.ts        #   the single parsing entry point
        │   ├── dedupe.ts            #   cross-channel deduplication
        │   ├── ingest.ts            #   parse + dedupe as one step
        │   ├── ingestion.test.ts    #   27 tests
        │   └── __fixtures__/        #   redacted message corpus
        ├── store/
        │   ├── useTransactionStore.ts  # Zustand — single source of truth
        │   └── queue.ts             #   pending-note queue selectors
        ├── hooks/useIngestion.ts    # subscribes both channels, drains buffers
        ├── native/kenIngestion.ts   # JS bridge wrapper (degrades gracefully)
        ├── components/              # FloatingMic, TransactionReviewModal
        ├── utils/
        │   ├── money.ts             # rupee <-> paise, the only place converting
        │   ├── voiceParser.ts       # spoken text -> structured fields
        │   └── reconciliationEngine.ts  # voice <-> bank matching
        └── mock/transactions.ts
```

---

## 3. Data Model (`frontend/src/types/transaction.ts`)

**Money is `amountMinor`: an integer number of paise. Never a float, never rupees.** See rules.md §1.

```typescript
interface Transaction {
  id: string;
  amountMinor: number;          // 24000 === ₹240.00
  title: string;
  category: TransactionCategory; // closed enum of 8
  paidTo: string;
  accountInfo: string;
  transactionType: 'Debit' | 'Credit';
  timestamp: string;             // ISO 8601

  source: 'Voice-only' | 'SMS-parsed' | 'Notification-parsed' | 'Merged' | 'Manual';
  channel: 'sms' | 'notification' | 'voice' | 'manual';

  refNo: string | null;          // bank reference / UPI RRN — primary dedupe key
  accountTail: string | null;
  dedupeKey: string;
  rawPayload: string | null;     // original message, kept forever

  status: 'pending_note' | 'complete' | 'ignored' | 'needs_review';
  skippedCount: number;
  lastPromptedAt: string | null;

  note: string | null;
  transcript: string | null;
  audioPath: string | null;
}
```

---

## 4. Implemented Systems

### A. Dual-channel ingestion (`src/ingestion/`, `modules/ken-ingestion/`)

Native captures, JavaScript decides. There is **one** parsing path; nothing else in the app may parse a payment.

1. `SmsReceiver` (static manifest registration, so it fires before the app is ever opened) reassembles multipart SMS by sender and buffers the text.
2. `PaymentNotificationListener` filters to an app allowlist and prefers `EXTRA_BIG_TEXT`, because the truncated `EXTRA_TEXT` often cuts off the reference number.
3. Both write to `IngestionInbox` and publish to `IngestionBus`. JS drains the buffer on foreground and receives live events when running.
4. `parseIngestionEvent` extracts amount (in paise), direction, merchant/VPA, account tail, reference number and date, and **rejects** OTPs, promotions, collect requests, failed transactions, balance alerts and future-dated mandates.
5. `findDuplicate` collapses the same payment seen on both channels — reference number first, then amount + account tail within 3 minutes. `mergeDuplicate` keeps the UPI app's clean merchant name while adopting the bank's reference number.

**Why both channels?** Play restricts `READ_SMS` to a permitted-use list that excludes expense tracking, so the notification path is the one that survives review; SMS gives wider bank coverage. Running both makes deduplication the critical component, not capture.

### B. Pending-note queue (`src/store/queue.ts`)

Bank events arrive as `status: 'pending_note'` and form an ordered backlog.

- Ordered `skippedCount ASC, timestamp ASC` — oldest first, skipped items sunk. Ordering is **derived**, never stored; a persisted position drifts when a late notification arrives out of order.
- **Widget tap** opens the queue head. **Notification tap** opens the payment it came from — that one is fresh, and forcing recall of an older payment first is the friction this app exists to remove.
- Escape hatches: skip (sinks it), ignore, and auto-retire to `needs_review` after 3 skips or 7 days. A widget showing an item the user cannot clear teaches them to ignore the widget.

### C. Voice capture (`VoiceCaptureActivity`)

Plain Android with **no React Native on the path** — booting the bridge costs 1–2s and the user abandons. Uses `SpeechRecognizer` with `en-IN` and `EXTRA_PREFER_OFFLINE`.

**Known constraint:** on most devices `SpeechRecognizer` takes exclusive hold of the microphone, so the parallel `MediaRecorder` capture usually fails and `audioPath` is null. Recognition is what must work; the raw recording is best-effort. The transcript is therefore **always** shown as editable text before saving — correction is the normal flow, not an error path.

### D. Reconciliation (`src/utils/reconciliationEngine.ts`)

When a bank record arrives, any `Voice-only` transaction within ±10 minutes, matching on amount (±₹1, in paise) and merchant similarity (Levenshtein), is merged. Bank wins on `amountMinor`, `accountInfo`, `timestamp`, `refNo`; voice wins on `title`, `category`, `note`.

---

## 5. Development & Run Commands

```bash
# Frontend
cd frontend
npm install
npm run typecheck    # tsc --noEmit — must be clean before every commit
npm test             # 27 tests, node:test via tsx
npx expo prebuild -p android   # required: native modules mean no Expo Go
npx expo run:android           # or open frontend/android/ in Android Studio

# Backend
cd backend && npm install && npm run dev   # Express on :5000
```

**Testing in Android Studio:** the emulator's Extended Controls → Phone → SMS sends a real SMS through the actual `SmsReceiver`, so the SMS path is testable without spending money. UPI app notifications cannot be produced on an emulator — use the module's `simulateEvent` for those.

---

### E. Persistence (`store/database.ts`, `store/schema.ts`, `store/persistence.ts`)

SQLite via `expo-sqlite`, structured so the parts that can hold bugs are
testable without a device:

- `schema.ts` is pure — DDL, row mapping, bind-parameter ordering. `amount_minor`
  is `INTEGER NOT NULL` and `dedupe_key` is `UNIQUE`, so a double-counted
  payment is rejected by the database and not only by app logic.
- `database.ts` owns the connection and migrations (`PRAGMA user_version`), and
  degrades to a no-op if SQLite cannot open — the app runs in memory rather
  than refusing to start.
- `persistence.ts` diffs successive store states and writes only what changed.
  It is wired as a `subscribe` at module scope, so **any action added later is
  persisted automatically** rather than silently not being saved.

The store hydrates via `hydrate()` at app start and remains the single
in-memory source of truth; SQLite is a write-through cache behind it, not a
second store.

---

### F. Merchant memory (`merchants/`, `store/useMerchantStore.ts`)

Categorise a merchant once, and every later payment to it is automatic. Three
tiers, resolved cheapest first: **user memory → shipped dictionary → null**.
Returning null rather than guessing keeps a wrong category from being silently
applied.

The load-bearing piece is `merchants/normalize.ts`. The same shop arrives as
`swiggy@ybl`, `UPI/SWGY*ORDER/123456`, `SWIGGY LIMITED` and `Swiggy` depending
on channel, and all four must collapse to one key or memory never hits. The
opposite failure matters just as much: `Swiggy` and `Swiggy Instamart` are
different businesses in different categories, so descriptive words are
preserved and only legal suffixes and payment-rail noise are stripped.
`AMBIGUOUS_PREFIXES` stops a bare prefix match filing an Instamart grocery run
as Dining.

Learning is wired to `updateTransaction` — setting a category by hand is the
teaching signal. The `CategoryPicker` sheet is what makes that reachable;
without it the memory could never fill up.

---

### G. LLM categorization (`backend/src/categorize.js`, `merchants/llmCategorizer.ts`)

The third and only paid tier, reached when user memory and the dictionary have
both missed. Everything about it is shaped around calling it rarely:

- `selectNeedingLlm` filters to `source: 'none'` **and** requires a note —
  with no note the model has nothing the regex did not already have.
- Requests are batched (one round trip for up to 50), and the taxonomy system
  prompt is `cache_control`-cached, so most input cost becomes a cache read.
- `effort: 'low'` — classification does not need deliberation.
- Only **high-confidence** answers are written into merchant memory.
  Remembering a guess would let one model mistake apply to every future
  payment to that merchant, and memory outranks the dictionary so it could
  override a correct shipped answer.

The client re-validates every returned category against the enum, so a drift
between the backend's copy of the list and the frontend's degrades to
"uncategorised" rather than corrupting data. Failure at any point returns an
empty result: a missing category costs one tap, a thrown error would break
ingestion.

Runs without a key — `/api/categorize` returns 503 and the app falls back to
asking the user, which is what merchant memory learns from anyway.

---

### H. Budgets & analytics (`analytics/`, `store/useBudgetStore.ts`, `components/InsightsPanel.tsx`)

Pure selectors over the transaction list; nothing here is stored state except
the budgets themselves.

The framing throughout: "you spent ₹4,200" is a fact the user already knows,
so every number here is one they can act on instead.

- **Safe to spend today** — remaining budget divided by remaining days.
  Divisions floor rather than round: telling someone they can spend ₹1 more
  than they can is the one rounding direction that costs them.
- **Overpacing** — 90% of the food budget is fine on the 28th and a problem on
  the 10th, so spend fraction is compared against period fraction rather than
  against the limit alone.
- **Recurring detection** requires three occurrences and regular gaps. Two
  identical payments to one merchant is a coincidence often enough that a
  false "you have a subscription" would be worse than missing a real one.
- **Transcript search** is the thing no other tracker can do — "client
  meeting" appears in no bank message, only in what the user said while
  paying.

Periods use local time deliberately: a budget month is the calendar month the
user experiences, and a UTC boundary would silently move 31 January's spending
into February.

Credits and `ignored` transactions are excluded from all spend maths; ignored
is usually a transfer to self, which would otherwise inflate every total for
money that never left the user's control.

---

## 6. Current Status

All of the below is merged to `main`.

| Area | State |
|---|---|
| Money as integer paise | Done |
| Ingestion pipeline (parse, dedupe, reject) | Done — 27 tests |
| Pending-note queue | Done — tested |
| Setup + queue UI | Done — typechecks, not exercised on a device |
| Native module (Kotlin) | Written, **never compiled** — no Android SDK on the authoring machine |
| Widget + voice capture | Written, **never run** |
| Persistence | Done — SQLite, write-through, 20 tests (schema v2) |
| Backend | Express + POST /api/categorize. No database, no auth, no sync |
| Supabase | Not started |
| Merchant memory | Done — 19 tests |
| LLM categorization | Done — 13 tests. Endpoint verified; a real Claude call has never run (no API key here) |
| Budgets & analytics | Done — 28 tests (schema v3) |

### The honest summary

Everything from parsing through storage is built and tested: a payment that
reaches the pipeline is deduped, queued, and survives restart. What is not
proven is the step before all of that — **capture** — because the Kotlin has
never been compiled. **No real payment has gone through this app end to end.**
A passing test suite here means the decision logic is correct, not that the
product works.

The trap most likely to mislead you: if `NativeModules.KenIngestion` is
`undefined` at runtime, every bridge call silently no-ops. The app will look
like it is working while capturing nothing — check this explicitly rather than
inferring from the UI.

**Next steps:** see `todo_next.md`. The remaining blocked work is Task A —
compiling the Kotlin — which needs a machine with the Android SDK. Everything
that can be built without a device is done.

## 7. Guidelines for Agents & Teammates

See `rules.md` — it is binding. The points most often violated:

1. **Money is integer paise.** Convert only at the UI boundary, only via `utils/money.ts`.
2. **One parser.** All payment parsing goes through `src/ingestion/`. Never add a second.
3. **Zustand is the single source of truth.** No parallel Context or local mirror.
4. **Parsers are pure and return `null` rather than guessing.** A wrong merchant is worse than a missing one.
5. **Every parser change ships with fixtures**, including reject-cases.
6. Run `npm run typecheck` and `npm test` before pushing — on the merge commit, not just the branch tip. That test suite is the gate protecting `main`; there is no standing reviewer.
7. **Update `todo_next.md` before you finish.** The next agent is briefed by that file alone.
