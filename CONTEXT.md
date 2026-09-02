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
| Persistence | Done — SQLite, write-through, 20 tests |
| Backend / Supabase | Not started — Express has a health route only |
| Merchant memory / LLM categorization | Not started |
| Budgets & analytics | Not started |

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

**Next steps:** see `todo_next.md`. In short — compile the Kotlin if you have an
Android SDK; otherwise build merchant memory, which is unblocked and removes
most of the categorization tedium without needing a device.

## 7. Guidelines for Agents & Teammates

See `rules.md` — it is binding. The points most often violated:

1. **Money is integer paise.** Convert only at the UI boundary, only via `utils/money.ts`.
2. **One parser.** All payment parsing goes through `src/ingestion/`. Never add a second.
3. **Zustand is the single source of truth.** No parallel Context or local mirror.
4. **Parsers are pure and return `null` rather than guessing.** A wrong merchant is worse than a missing one.
5. **Every parser change ships with fixtures**, including reject-cases.
6. Run `npm run typecheck` and `npm test` before pushing — on the merge commit, not just the branch tip. That test suite is the gate protecting `main`; there is no standing reviewer.
7. **Update `todo_next.md` before you finish.** The next agent is briefed by that file alone.
