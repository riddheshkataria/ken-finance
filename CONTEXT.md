# Ken Finance — Project Context & Architecture

> **Purpose**: Current implementation state for developers and AI coding agents working on **Ken Finance**.
>
> **Reading order for a new agent:** `rules.md` (binding conventions) → `plan.md` (architecture and roadmap) → this file → `todo_next.md` (what to do next, written to be executed autonomously).

---

## 1. Product Vision & Problem Statement

**The Problem**: Traditional expense trackers show *that* money was spent (`SWIGGY ₹240`) but never capture **why**. Users forget the context of a payment within days.

**The Solution**: Capture intent **at the moment of payment**:

- **Dual-channel ingestion** — bank SMS *and* UPI app notifications (GPay, PhonePe, Paytm, CRED), running concurrently.
- **Instant voice capture** — home-screen widget, in-app floating mic, and notification actions opening native mic sheet in <300ms.
- **Two-way matching** — a spoken note recorded before or during payment reconciles against the bank record that follows; a bank record with no note joins a queue asking the user what it was for.
- **Offline-first with AI categorization & Cloud Sync** — 3-tier categorization (User Memory → Shipped Dictionary → Google Gemini 2.5 Flash), local SQLite write-through caching, and Supabase cloud synchronization with tombstone deletes.
- **Dynamic Rule Pack & Self-Improving Ingestion** — Server-fetched versioned regex rules from Supabase `parse_rules` so new bank formats ship without app binary updates, plus Gemini-powered regex generation for unparsed messages.

---

## 2. Repository Layout

```
ken-finance/
├── rules.md                         # Binding engineering conventions — read first
├── plan.md                          # Architecture & roadmap
├── CONTEXT.md                       # This file
├── todo_next.md                     # Actionable work queue for agents
├── supabase/
│   └── schema.sql                   # Supabase Postgres schema (tables, RLS, indexes)
├── backend/                         # Node.js Express backend + Google Gemini 2.5 Flash + Supabase
│   ├── .env                         # PORT, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
│   ├── index.js                     # Express API entry point & route mounts
│   └── src/
│       ├── categorize.js            # @google/genai batch categorization with structured JSON schemas
│       ├── supabase.js              # Supabase Postgres server client & connection health
│       ├── parseRules.js            # Versioned bank regex rule pack API (GET /api/parse-rules)
│       └── unparsedIngest.js        # AI extraction & regex rule generation (POST /api/ingest/unparsed)
└── frontend/                        # React Native (Expo SDK 57) client
    ├── .env                         # EXPO_PUBLIC_API_URL, EXPO_PUBLIC_SUPABASE_URL, etc.
    ├── App.tsx                      # 4-tab navigation (Activity, Ledger, Budgets, Sync)
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
        │   ├── extractors.ts        #   pure field extraction & package allowlist
        │   ├── parseEvent.ts        #   single parsing entry point (supports dynamic rule pack)
        │   ├── dedupe.ts            #   cross-channel deduplication
        │   ├── ingest.ts            #   parse + dedupe as one step
        │   ├── ingestion.test.ts    #   27 tests
        │   └── __fixtures__/        #   redacted message corpus
        ├── store/
        │   ├── useTransactionStore.ts  # Zustand — transactions & sync coordination
        │   ├── useBudgetStore.ts       # Zustand — category budgets (SQLite backed)
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
        │   ├── voiceParser.ts           # Spoken natural language -> transaction
        │   ├── voiceParser.test.ts      # Unit tests for voice parsing
        │   └── reconciliationEngine.ts  # Voice <-> bank matching
        └── mock/transactions.ts         # Multi-category dummy dataset
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

## 4. Backend & Database Architecture

```
                                    Express Server (:5000)
                                   ┌───────────────────────────────────────────────┐
Client App                         │  • POST /api/categorize (Gemini Flash LLM)   │
(React Native) ───────────────────►│  • GET  /api/parse-rules (Dynamic Bank Regex)│
       │                           │  • POST /api/ingest/unparsed (AI Rule Proposer)│
       │                           │  • GET  /api/health (Server & DB Health)     │
       │                           └───────────────────────┬───────────────────────┘
       │                                                   │
       │ Direct Supabase REST (Auth RLS)                   │ Supabase Service Client
       ▼                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             Supabase Postgres Database                           │
│  • public.transactions  (User expenses, dedupe_key UNIQUE, amount_minor BIGINT) │
│  • public.merchants     (Learned user merchant rules)                            │
│  • public.budgets       (Monthly category budget targets)                        │
│  • public.parse_rules   (Server-distributed bank & UPI regex rule pack)         │
│  • public.unparsed_logs (Redacted unparsed payloads for regex training)          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

1. **Database Schema (`supabase/schema.sql`)**:
   - `amount_minor` is `BIGINT` with explicit check constraints `amount_minor = trunc(amount_minor)`.
   - `UNIQUE(user_id, dedupe_key)` enforces deduplication at the database level.
   - Row Level Security (RLS) enabled on all user tables with `auth.uid() = user_id`.
   - `deleted_at` timestamps act as tombstones so hard deletes propagate across offline devices without resurrecting rows.

2. **Backend API Endpoints**:
   - `POST /api/categorize`: Batched categorization for unknown merchants with notes using Google Gemini 2.5 Flash (`@google/genai`).
   - `GET /api/parse-rules`: Returns versioned bank regex patterns (HDFC, SBI, ICICI, Axis, Kotak, GPay, PhonePe, Paytm, CRED) fetched dynamically by client.
   - `POST /api/ingest/unparsed`: Ingests redacted unparsed SMS/notification bodies &rarr; Gemini parses fields & drafts candidate regex into `parse_rules`.
   - `GET /api/health`: Health status of server and Supabase connection.

---

## 5. Current Implementation State

| Area | State |
|---|---|
| Native Kotlin Ingestion & Android Build | **Compiled & Verified** (Gradle 9.3.1 + JDK 17, APK installed on emulator, SMS receiver tested) |
| Native Speech-to-Text (STT) & Live Capture | **Verified on Android** (State machine: IDLE→STARTING→LISTENING→FINISHING→DESTROYING; avoids onResults drops; auto-retries transient ERROR_CLIENT (5) & BUSY (8); fallback on error 12/13; lazy EventEmitter resolver; safe permission checks; live pulsing mic UI) |
| Money as integer paise | Verified |
| Ingestion pipeline (parse, dedupe, reject) | Verified — 27 tests |
| Pending-note queue | Verified — 5 tests |
| App Navigation & Ledger UI | Implemented — 4 tabs (Activity, Ledger, Budgets, Sync) |
| Transaction Detail & Edit Modal | Implemented — edit, delete, voice note, raw payload viewer |
| Voice Speech Parser | Verified — 6 tests (repayments, credits, debits) |
| Persistence (SQLite) | Verified — 20 tests (schema v4) |
| Merchant memory | Verified — 19 tests |
| LLM Categorization (Gemini 2.5 Flash) | Verified — 13 tests |
| Supabase Sync Engine | Verified — 27 tests (pure merge logic) |
| Budgets & Analytics | Verified — 28 tests (schema v3) |
| **Total Test Suite** | **139 passing tests (0 failures)** |
