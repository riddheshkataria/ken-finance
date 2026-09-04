# Ken Finance — Agent Handoff & Work Queue

> **You are picking up an in-progress project. Read this whole file before touching anything.**
>
> This file is written to be executed autonomously. It tells you what the
> project is, what state it is actually in, what you must not break, what to
> work on next, and how to know when you are done.

---

## 1. Orientation — read these first, in this order

| File | What it gives you |
|---|---|
| `rules.md` | **Binding** engineering conventions. Not advisory. |
| `plan.md` | Architecture and the reasoning behind it |
| `CONTEXT.md` | Current implementation state & data models |
| `todo_next.md` | This file — prioritized actionable work queue |

**The product in one sentence:** Indian bank and UPI apps tell you *that* you
spent money but never *why*, so Ken captures a spoken note at the moment of
payment — a home-screen widget shows the payment that just landed and offers
one mic button.

---

## 2. Establish your baseline before changing anything

Run these first:

```bash
# Frontend validation
cd frontend
npm install
npm run typecheck   # must print nothing (0 errors)
npm test            # must report 139 pass, 0 fail

# Backend validation
cd ../backend
npm install
npm test 2>/dev/null || node -e "require('./index')"
```

---

## 3. What is actually true right now

### Built, compiled, and verified
- **TASK A: Native Kotlin compilation & Android APK** (`modules/ken-ingestion/`, `frontend/android/`) ✅ **DONE**:
  - `modules/ken-ingestion` compiles clean via Gradle 9.3.1 + JDK 17 (`Task :ken-ingestion:compileDebugKotlin`, `assembleDebug`).
  - Native layouts (`ken_widget.xml`, `ken_voice_capture.xml`) and themes built.
  - Native APK installed and launched on Android emulator (`com.kenfinance.app`).
  - Live SMS capture broadcast receiver verified via emulator (`adb emu sms send`).
  - Unified Indian banking app allowlist across Kotlin and TypeScript.
- **TASK B: Persistence** (`src/store/database.ts`, `schema.ts`, `persistence.ts`) ✅ **DONE**:
  - SQLite, write-through state diffing, hydrates at app start. `amount_minor` is `INTEGER` and `dedupe_key` is `UNIQUE`.
- **TASK C: Merchant memory** (`src/merchants/`, `src/store/useMerchantStore.ts`) ✅ **DONE**:
  - User memory beats shipped dictionary (expanded with 150+ Indian brands), both beat guessing.
- **TASK D: LLM categorization** (`backend/src/categorize.js`, `src/merchants/llmCategorizer.ts`) ✅ **DONE**:
  - Powered by Google Gemini 2.5 Flash (`@google/genai`), batched and gated.
- **TASK E: Supabase sync** (`src/sync/`, `supabase/schema.sql`) ✅ **DONE**:
  - Offline-first, tombstone deletes, pull-before-push merge.
- **TASK F: Budgets and analytics** (`src/analytics/`, `store/useBudgetStore.ts`, `components/InsightsPanel.tsx`) ✅ **DONE**:
  - Safe-to-spend-today, overpacing warnings, merchant leaderboard, recurring detection, transcript search.
- **Voice speech parser & Live Speech-to-Text (STT)** (`modules/ken-ingestion/`, `FloatingMic.tsx`, `kenIngestion.ts`, `voiceParser.ts`) ✅ **DONE**:
  - Live native speech recognition directly integrated in local Expo module (`KenIngestionModule.kt`) using Android's `SpeechRecognizer`.
  - State machine lifecycle (`IDLE → STARTING → LISTENING → FINISHING → DESTROYING`):
    - `onEndOfSpeech` transitions to `FINISHING` so Android's subsequent `onResults` delivery is never prematurely dropped before emission to JS.
    - Added delay and auto-retry for transient `ERROR_CLIENT` (5) and `ERROR_RECOGNIZER_BUSY` (8).
    - Graceful locale fallback on errors 12/13 (unsupported/unavailable language) to system default locale.
    - Suppressed benign transition notices (error 11 `SERVER_DISCONNECTED` and error 7 `NO_MATCH`).
  - Text-only transcription capture: no `.m4a` audio files written to disk; zero audio storage overhead.
  - Safe lazy `getEventEmitter()` resolver in `kenIngestion.ts` without top-level `EventEmitter` static import to prevent uninitialized `globalThis.expo` runtime crashes in Hermes.
  - Safe permission checking in `FloatingMic.tsx`: checks `PermissionsAndroid.check()` first to avoid `E_INVALID_ACTIVITY` crashes when activity isn't attached.
  - Package visibility queries in `AndroidManifest.xml` for `RecognitionService`, `googlequicksearchbox`, `tts`, and `as`.
  - Converts natural spoken English/Hinglish (e.g. repayments, P2P transfers, dining, rent, groceries) with full 6/6 test suite.
- **Navigation & Screen Sections** (`App.tsx`, `TransactionDetailModal.tsx`) ✅ **DONE**:
  - 4 tabs (⚡ Activity, 🧾 Transactions Ledger, 📊 Budgets/Insights, ⚙️ Sync & Settings) with search, category filtering, inline edit, and raw bank SMS audit payload viewer.
- **139 tests** across all unit test suites with **0 failures**.

---

## 4. NEXT PRIORITY: Backend Database Wiring & Dynamic Ingestion Rules (Task G)

Now that native Android compilation and on-device ingestion are functional, wire the Express backend with Supabase Postgres and dynamic ingestion rules per `plan.md`.

### TASK G1 — Backend Supabase Database Client & Environment
**Goal:** Connect Express backend to Supabase Postgres with service role access.
1. Install `@supabase/supabase-js` in `backend/`.
2. Configure `backend/.env` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`.
3. Create `backend/src/supabase.js` exporting the initialized Supabase client and connection health check.
4. Add `GET /api/health/db` endpoint to verify live database connectivity.

### TASK G2 — Dynamic Versioned Parse Rules API (`GET /api/parse-rules`)
**Goal:** Server-fetched regex rule pack so new bank SMS and UPI notification formats update on devices without app binary releases (`plan.md` §Ingestion pipeline).
1. Create `parse_rules` table in Supabase schema:
   `parse_rules(id, version, bank_key, pattern, field_map jsonb, priority, active, created_at)`
2. Populate base rule pack for major Indian banks (HDFC, SBI, ICICI, Axis, Kotak, PNB, BOB) and UPI apps (GPay, PhonePe, Paytm, CRED).
3. Implement `GET /api/parse-rules` in `backend/src/parseRules.js`:
   - Returns versioned rule array.
   - Supports `?since_version=X` for delta fetching.
4. Update `frontend/src/ingestion/parseEvent.ts` to accept dynamic rules with fallback to shipped regex constants.

### TASK G3 — AI Redacted Message Ingestion & Regex Proposer (`POST /api/ingest/unparsed`)
**Goal:** Self-improving parser (`plan.md` §Unparsed messages).
1. When an incoming message fails all known regex rules, client redacts sensitive PII (masks account numbers to last 4, removes customer names) and posts to `POST /api/ingest/unparsed`.
2. Backend calls Google Gemini 2.5 Flash to:
   - Extract structured financial fields (`amountMinor`, `paidTo`, `refNo`, `accountTail`, `transactionType`).
   - Propose a new regular expression pattern with named capture groups.
3. Inserts candidate rule into Supabase `parse_rules` with `active: false` for admin review and staging.

### TASK G4 — Frontend Dynamic Rule Caching & Periodic Sync
1. In `frontend/src/ingestion/dynamicRules.ts`, fetch `GET /api/parse-rules` on app foreground.
2. Cache rules in local SQLite `parse_rules` table.
3. Seamlessly apply fetched rules in `src/ingestion/parseEvent.ts`.

---

## 5. SUBSEQUENT PHASES

### TASK H — Cloud STT Audio Capture & Hinglish Accuracy
1. Record voice audio files with `expo-audio` / `expo-av`.
2. Provide backend fallback transcription endpoint (`POST /api/transcribe`) using Gemini audio modality for challenging Hinglish accents.

### TASK I — First-Run Onboarding Flow & Permissions Wizard
1. Onboarding wizard explaining the value of instant voice capture and notification permissions.
2. Direct deep linking to Android Notification Access Settings and SMS permissions dialog.

---

## 6. Development & Build Commands

```bash
# Frontend typecheck and unit tests
cd frontend
npm run typecheck
npm test

# Native Android Build & Run (Emulator or Physical Device)
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH

cd frontend
npx expo run:android

# Backend (Gemini 2.5 Flash + Supabase on :5000)
cd backend
npm install
npm run dev
```

---

## 7. Finishing a Session Checklist

Before you stop:
1. `npm run typecheck` and `npm test` both pass (139 passing tests).
2. `CONTEXT.md` updated if implementation state changed.
3. `plan.md` updated if you deviated from architecture.
4. `todo_next.md` updated with completed items and next steps.
