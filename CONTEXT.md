# Ken Finance — Project Context & Architecture

> **Purpose**: Current implementation state for developers and AI coding agents working on **Ken Finance**.
>
> **Reading order for a new agent:** `rules.md` (binding conventions) → `plan.md` (architecture and roadmap) → this file → `todo_next.md` (what to do next, written to be executed autonomously).

---

## 1. Product Vision & Problem Statement

**The Problem**: Traditional expense trackers show *that* money was spent (`SWIGGY ₹240`) but never capture **why**. Users forget the context of a payment within days.

**The Solution**: Capture intent **at the moment of payment**:

- **Dual-channel ingestion** — bank SMS *and* UPI app notifications (GPay, PhonePe, Paytm, CRED), running concurrently.
- **Instant voice capture** — a home-screen widget, floating in-app mic, and notification action, opening a native mic sheet in well under a second.
- **Two-way matching** — a spoken note recorded before or during payment reconciles against the bank record that follows; a bank record with no note joins a queue asking the user what it was for.
- **Offline-first with AI categorization & Cloud Sync** — 3-tier categorization (User Memory → Shipped Dictionary → Google Gemini 2.5 Flash), local SQLite write-through caching, and Supabase cloud synchronization with tombstone deletes.

---

## 2. Repository Layout

```
ken-finance/
├── rules.md                         # Binding engineering conventions — read first
├── plan.md                          # Architecture & roadmap
├── CONTEXT.md                       # This file
├── todo_next.md                     # Actionable work queue for agents
├── backend/                         # Node.js Express backend + Google Gemini 2.5 Flash
│   ├── .env                         # PORT=5000, GEMINI_API_KEY
│   ├── index.js                     # Express API entry point
│   └── src/categorize.js            # @google/genai batch categorization with structured JSON schemas
└── frontend/                        # React Native (Expo SDK 57) client
    ├── .env                         # EXPO_PUBLIC_API_URL, EXPO_PUBLIC_SUPABASE_URL, etc.
    ├── App.tsx                      # Main app shell with 4-tab navigation (Activity, Ledger, Budgets, Sync)
    ├── modules/ken-ingestion/       # Local Expo module — Android native Kotlin
    │   ├── expo-module.config.json
    │   └── android/src/main/
    │       ├── AndroidManifest.xml
    │       ├── java/expo/modules/keningestion/
    │       │   ├── KenIngestionModule.kt        # JS bridge & Android Intents
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
        │   ├── useTransactionStore.ts  # Zustand — single source of truth for transactions
        │   ├── useBudgetStore.ts       # Zustand — monthly budgets per category (SQLite backed)
        │   ├── useMerchantStore.ts     # Zustand — learned merchant memory rules
        │   ├── database.ts             # SQLite connection & schema migrations
        │   ├── schema.ts               # Pure SQL DDL & row mapping
        │   ├── persistence.ts          # State-diffing SQLite write-through subscription
        │   └── queue.ts                # Pending-note queue derivation
        ├── merchants/
        │   ├── normalize.ts            # Merchant key normalization
        │   ├── dictionary.ts           # Shipped 150+ merchant dictionary
        │   ├── lookup.ts               # Tier resolution logic
        │   └── llmCategorizer.ts       # Client transport for backend Gemini endpoint
        ├── analytics/
        │   ├── budget.ts               # Safe-to-spend-today & overpacing selectors
        │   ├── insights.ts             # Recurring subscriptions & merchant leaderboard
        │   └── period.ts               # Local-time monthly period boundaries
        ├── sync/
        │   ├── merge.ts                # Pure conflict resolution & tombstone merge
        │   ├── syncEngine.ts           # Pull/push cycle coordination
        │   ├── supabaseClient.ts       # Supabase Postgres REST client
        │   └── watermark.ts            # High-water mark tracker
        ├── hooks/useIngestion.ts    # Subscribes both channels, drains buffers
        ├── native/kenIngestion.ts   # JS bridge wrapper with Android Settings intents
        ├── components/
        │   ├── FloatingMic.tsx            # In-app speech-to-text recording
        │   ├── IngestionSetupCard.tsx     # Permission status & direct settings link
        │   ├── PendingQueueBanner.tsx     # "What was this for?" queue backlog banner
        │   ├── TransactionDetailModal.tsx # Full transaction viewer, editor, and audit
        │   ├── InsightsPanel.tsx          # Analytics, budgets, and transcript search
        │   └── CategoryPicker.tsx         # 8-category selector pill modal
        ├── utils/
        │   ├── money.ts                 # Rupee <-> paise (INTEGER only)
        │   ├── voiceParser.ts           # Natural language voice speech -> transaction
        │   ├── voiceParser.test.ts      # Unit tests for voice parsing
        │   └── reconciliationEngine.ts  # Voice <-> bank matching
        └── mock/transactions.ts         # Rich multi-category dummy dataset
```

---

## 3. Data Model (`frontend/src/types/transaction.ts`)

**Money is `amountMinor`: an integer number of paise. Never a float, never rupees.** See `rules.md §1`.

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

  updatedAt: string;
  deletedAt: string | null;      // Tombstone for sync
  syncedAt: string | null;
}
```

---

## 4. Implemented Systems

### A. Dual-channel ingestion (`src/ingestion/`, `modules/ken-ingestion/`)
Native captures, JavaScript decides. There is **one** parsing path; nothing else in the app may parse a payment.
1. `SmsReceiver` reassembles multipart SMS by sender and buffers the text.
2. `PaymentNotificationListener` filters to an app allowlist and extracts `EXTRA_BIG_TEXT`.
3. Both write to `IngestionInbox` and publish to `IngestionBus`.
4. `parseIngestionEvent` extracts amount (in paise), direction, merchant/VPA, account tail, reference number, and date. Rejects OTPs, promotions, collect requests, failed transactions, and balance alerts.
5. `findDuplicate` collapses the same payment seen on both channels.

### B. Pending-note queue (`src/store/queue.ts`)
Bank events arrive as `status: 'pending_note'` and form an ordered backlog:
- Ordered `skippedCount ASC, timestamp ASC` (oldest first, skipped items sunk).
- Widget tap opens the queue head. Notification tap opens the specific payment.
- Auto-retires after 3 skips or 7 days.

### C. Voice parsing & Intent Capture (`src/utils/voiceParser.ts`)
Spoken phrases like `"tanmay sent me 230 he owed me for food"` or `"spent 650 at Starbucks for cold brew"` are converted into:
- Integer amount in paise (`23000` or `65000`).
- Direction (`Credit` for incoming repayments/transfers, `Debit` for spending).
- Subject/Person (`Tanmay`, `Starbucks`).
- Category (`Dining`, `Grocery`, `Transport`, `Rent`, `Bills`, `P2P Transfer`, `Investment`, `Others`).
- Title/Reason (`Food`, `Cold Brew`).

### D. App Navigation & Detailed Ledger (`App.tsx`, `TransactionDetailModal.tsx`)
- 4 navigation tabs:
  - ⚡ **Activity**: Net balance cards, permissions card, pending queue banner, recent transaction stream, and floating mic.
  - 🧾 **Transactions**: Full ledger with real-time text search (titles, merchants, voice notes, transcripts, reference numbers), category filter pills, and direction filters.
  - 📊 **Budgets**: Full-featured analytics with safe-to-spend-today, overpacing alerts, category budgets, recurring subscriptions, and merchant leaderboard.
  - ⚙️ **Sync**: Supabase cloud status, pending push count, manual sync button, AI merchant memory stats, and data reset buttons.
- Tapping any transaction opens `TransactionDetailModal` with full edit/save, delete confirmation, voice note recording, and raw bank SMS audit payload viewer.

### E. Persistence (`store/database.ts`, `store/schema.ts`, `store/persistence.ts`)
SQLite via `expo-sqlite`:
- `schema.ts` is pure DDL, row mapping, and parameter binding (`amount_minor INTEGER`, `dedupe_key UNIQUE`).
- `database.ts` owns connection and schema migrations (`PRAGMA user_version`).
- `persistence.ts` diffs Zustand store state and writes changes automatically.

### F. Merchant memory (`merchants/`, `store/useMerchantStore.ts`)
Three tiers: **User Memory → Shipped Dictionary → Google Gemini LLM**.
Normalisation in `normalize.ts` collapses rail noise (`UPI/SWGY*ORDER/123456`, `SWIGGY LIMITED` &rarr; `swiggy`) while preserving distinct businesses (`Swiggy` vs `Swiggy Instamart`).

### G. LLM Categorization (`backend/src/categorize.js`, `merchants/llmCategorizer.ts`)
Powered by Google Gemini 2.5 Flash (`@google/genai`).
- Batched up to 50 items with structured schema output.
- Gated to unknown merchants with notes. High-confidence answers are written into merchant memory.

### H. Supabase Sync (`sync/`, `supabase/schema.sql`)
Offline-first with pure conflict resolution:
- Tombstone deletes (`deletedAt !== null`).
- `syncedAt` set to row's own `updatedAt`.
- Pull before push with last-write-wins merge.

---

## 5. Development & Run Commands

```bash
# Frontend
cd frontend
npm install
npm run typecheck    # tsc --noEmit — 0 errors
npm test             # 139 tests passing across 35 test suites
npx expo start       # Run Expo development server

# Backend
cd backend
npm install
npm run dev          # Express + Gemini 2.5 Flash on :5000
```

---

## 6. Current Status & Verification

| Area | State |
|---|---|
| Money as integer paise | Verified |
| Ingestion pipeline (parse, dedupe, reject) | Verified — 27 tests |
| Pending-note queue | Verified — 5 tests |
| App Navigation & Ledger UI | Implemented & verified (React 19 compatible) |
| Transaction Detail & Edit Modal | Implemented & verified |
| Voice Speech Parser | Verified — 6 tests (repayments, credits, debits) |
| Native module (Kotlin) | Written (ready for Android build testing) |
| Persistence (SQLite) | Verified — 20 tests (schema v4) |
| Backend (Google Gemini) | Verified — 13 tests (Node.js Express + Gemini 2.5 Flash) |
| Supabase Cloud Sync | Verified — 27 tests (pure merge logic) |
| Budgets & Analytics | Verified — 28 tests (schema v3) |
| Total Test Suite | **139 passing tests (0 failures)** |
