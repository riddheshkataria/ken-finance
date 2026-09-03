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
| `CONTEXT.md` | Current implementation state |
| `todo_next.md` | This file — what to do next |

**The product in one sentence:** Indian bank and UPI apps tell you *that* you
spent money but never *why*, so Ken captures a spoken note at the moment of
payment — a home-screen widget shows the payment that just landed and offers
one mic button.

---

## 2. Establish your baseline before changing anything

Run these first:

```bash
cd frontend
npm install
npm run typecheck   # must print nothing (0 errors)
npm test            # must report 139 pass, 0 fail
```

---

## 3. What is actually true right now

Every task from architecture through native compilation is built and verified.

### Built, compiled, and verified
- **TASK A: Native Kotlin compilation & Android APK** (`modules/ken-ingestion/`, `frontend/android/`) ✅ **DONE**:
  - `modules/ken-ingestion` compiles clean via Gradle 9.3.1 + JDK 17 (`Task :ken-ingestion:compileDebugKotlin`, `assembleDebug`).
  - Native layouts (`ken_widget.xml`, `ken_voice_capture.xml`) and themes built.
  - Native APK installed and launched on Android emulator.
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
- **Voice speech parser** (`src/utils/voiceParser.ts`) ✅ **DONE**:
  - Converts natural spoken English/Hinglish (e.g. `"tanmay sent me 230 he owed me for food"`) into structured transactions with credit/debit recognition.
- **Navigation & Screen Sections** (`App.tsx`, `TransactionDetailModal.tsx`) ✅ **DONE**:
  - 4 tabs (⚡ Activity, 🧾 Transactions Ledger, 📊 Budgets/Insights, ⚙️ Sync & Settings) with search, category filtering, inline edit, and raw bank SMS audit payload viewer.
- **139 tests** across all unit test suites with **0 failures**.

---

## 4. Development & Build Commands

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

# Backend (Gemini 2.5 Flash API on :5000)
cd backend
npm run dev
```

---

## 5. Summary of Tasks Status

- [x] **TASK A: Native Kotlin Module & Android Build**
- [x] **TASK B: SQLite Offline Persistence**
- [x] **TASK C: Merchant Memory Normalisation**
- [x] **TASK D: Google Gemini Categorization Backend**
- [x] **TASK E: Supabase Postgres Offline-First Sync**
- [x] **TASK F: Budgets, Pacing, and Analytics**
- [x] **App UI: 4-Tab Navigation & Transaction Detail View**
- [x] **Voice Parser: Incoming Transfer & Repayment Recognition**
- [x] **Unified Allowlist & 150+ Merchant Dictionary Expansion**
