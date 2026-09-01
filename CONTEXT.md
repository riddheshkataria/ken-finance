# Ken Finance — Project Context & Architecture

> **Purpose**: This document serves as the comprehensive context guide for developers and AI coding agents working on **Ken Finance**. It documents the product vision, architecture, current implementation, data models, and guidelines for future development.

---

## 1. Product Vision & Problem Statement

**The Problem**: Traditional expense trackers in India (and globally) show *that* money was spent (e.g., `SWIGGY ₹240` or `UPI/987654321 ₹450`), but never capture **why**. Users forget the context of transactions by the end of the week.

**The Solution**: Capture user intent **at the moment of payment**:
- **Automatic Ingestion**: Ingest transactions via Indian Bank SMS alerts and UPI app notifications (GPay, PhonePe, Paytm, CRED).
- **Instant Voice Capture**: A floating mic / home-screen widget allows the user to speak naturally (e.g., *"Spent 650 at Starbucks for cold brew"* or *"Team lunch, reimbursable"*).
- **Smart Reconciliation Engine**: Matches voice notes with bank SMS/notifications within a $\pm$10-minute window, merging the bank's accurate financial data with the user's rich voice context into a single **`Merged`** transaction.

---

## 2. Repository Layout

```
ken-finance/
├── plan.md                          # Master architectural specification & roadmap
├── CONTEXT.md                       # This context file for AI agents & developers
├── backend/                         # Node.js Express Backend
│   ├── index.js                     # Express server entry point (CORS, JSON, health check)
│   ├── package.json                 # Backend dependencies (express, nodemon, dotenv, cors)
│   └── .env                         # Server environment configuration (PORT=5000)
│
└── frontend/                        # React Native (Expo SDK 57) Client
    ├── App.tsx                      # Main application screen mounting all components
    ├── app.json                     # Expo configuration (name: Ken Finance, slug: ken-finance)
    ├── package.json                 # Frontend dependencies (react-native, expo, zustand, etc.)
    ├── tsconfig.json                # TypeScript compiler configuration
    └── src/
        ├── types/
        │   └── transaction.ts       # Strict Transaction TypeScript interface & enums
        ├── mock/
        │   └── transactions.ts      # Initial mock financial data conforming to strict types
        ├── store/
        │   └── useTransactionStore.ts # Zustand global store (CRUD, auto-reconciliation, state)
        ├── context/
        │   └── TransactionContext.tsx # React Context alternative for transaction state
        ├── components/
        │   ├── FloatingMic.tsx      # Floating mic component (pulsing animation, press-and-hold, live STT)
        │   └── TransactionReviewModal.tsx # Bottom sheet modal for reviewing/editing before saving
        ├── hooks/
        │   └── useSmsListener.ts    # Android SMS listener hook with permission handling
        └── utils/
            ├── voiceParser.ts       # NLP / regex parser extracting structured data from spoken voice
            ├── smsParser.ts         # Regex parser for Indian bank alerts (HDFC, SBI, ICICI, AXIS, etc.)
            └── reconciliationEngine.ts # Levenshtein distance & timestamp matcher for Voice + SMS
```

---

## 3. Strict Data Model (`frontend/src/types/transaction.ts`)

All transactions across the frontend and backend adhere strictly to this schema:

```typescript
export type TransactionCategory =
  | 'Dining'
  | 'Grocery'
  | 'Transport'
  | 'Rent'
  | 'Bills'
  | 'P2P Transfer'
  | 'Investment'
  | 'Others';

export type TransactionType = 'Debit' | 'Credit';

export type TransactionSource = 'Voice-only' | 'SMS-parsed' | 'Merged';

export interface Transaction {
  id: string;                       // UUID string
  amount: number;                   // Transaction value (UI in Rupees, DB in paise)
  title: string;                    // Description (e.g., 'Dinner at Social')
  category: TransactionCategory;    // Strict category enum
  paidTo: string;                   // Merchant or person (e.g., 'Swiggy', 'Rahul Sharma')
  accountInfo: string;              // Account details (e.g., 'HDFC - 4392' or 'Cash/Default')
  transactionType: TransactionType; // 'Debit' | 'Credit'
  timestamp: string;                // ISO 8601 string
  source: TransactionSource;        // 'Voice-only' | 'SMS-parsed' | 'Merged'
}
```

---

## 4. Implemented Systems & How They Work

### A. Voice Capture & Parsing (`FloatingMic.tsx` + `voiceParser.ts`)
1. **Interactive Interaction**: Press-and-hold the mic button to stream live transcription. A pulsing animation and live transcript tooltip are displayed.
2. **Cross-Platform Compatibility**:
   - Custom native build: Uses `@react-native-voice/voice`.
   - Web browser: Automatically falls back to the native **Web Speech API** (`webkitSpeechRecognition`).
   - Expo Go sandbox: Shows a quick voice tester / simulator dialog so voice parsing can be tested without native linking.
3. **Voice Parser**: Extracts amount, merchant (`paidTo`), category, purpose (`title`), and transaction type from spoken natural language (e.g., *"Spent 650 at Starbucks for cold brew"* &rarr; `amount: 650`, `paidTo: "Starbucks"`, `title: "Cold Brew"`, `category: "Dining"`, `transactionType: "Debit"`).

### B. Android SMS Bank Ingestion (`useSmsListener.ts` + `smsParser.ts`)
1. **Permission Handling**: Dynamically requests `READ_SMS` and `RECEIVE_SMS` on Android devices via `PermissionsAndroid`.
2. **Bank Filtering**: Detects bank sender headers (`HDFC`, `SBI`, `ICICI`, `AXIS`, `KOTAK`, `PNB`, `IDFC`, `PAYTM`, etc.).
3. **Extraction**: Uses regex to pull numeric amount, account number tail (`*4392`), recipient / VPA (`swiggy@icici`), and debit/credit status.

### C. Reconciliation Engine (`reconciliationEngine.ts`)
When an SMS alert arrives:
1. **Window Check**: Checks if any `Voice-only` transaction exists within $\pm 10\text{ minutes}$.
2. **Amount Parity**: Ensures the amount matches within tolerance ($\le ₹1.00$).
3. **Similarity Check**: Computes **Levenshtein Distance** string similarity between the voice merchant and the SMS VPA / merchant.
4. **Consolidation**: Generates a single **`Merged`** transaction using:
   - `amount`: SMS amount (bank truth)
   - `title`: Voice title (rich user note)
   - `category`: Voice category (user intent)
   - `paidTo`: Cleaned merchant name
   - `accountInfo`: SMS account identifier (e.g., `'HDFC - 4392'`)
   - `source`: `'Merged'`

### D. Review Modal Bottom Sheet (`TransactionReviewModal.tsx`)
- Appears when a voice entry is spoken or when an SMS alert is detected.
- Allows editing all fields (amount, title, category pills, paidTo, accountInfo, Debit/Credit toggle).
- Displays a source badge (`Voice Input`, `SMS Alert`, `Reconciled & Merged`).
- Provides **Confirm & Save** (updates Zustand store) and **Discard** buttons.

---

## 5. Development & Run Commands

### Backend:
```bash
cd backend
npm install
npm run dev     # Runs Express on port 5000 with nodemon auto-reloading
```

### Frontend:
```bash
cd frontend
npm install
npm start       # Starts Expo Metro bundler for mobile testing (Expo Go)
npm run web     # Starts Expo in the web browser
```

---

## 6. Guidelines for AI Agents & Teammates

1. **Maintain Category Integrity**: Always constrain categories to the 8 strict enum values (`'Dining' | 'Grocery' | 'Transport' | 'Rent' | 'Bills' | 'P2P Transfer' | 'Investment' | 'Others'`).
2. **Source of Truth**: When reconciling, the bank (SMS/notification) is the source of truth for **amount**, **accountInfo**, and **timestamp**; the user's voice log is the source of truth for **title** (context) and **category** (intent).
3. **Type Safety**: Always run `npx tsc --noEmit` in `frontend/` after making changes to ensure zero TypeScript errors.
4. **Offline First**: All frontend interactions should read and write through `useTransactionStore` (Zustand) so state remains fast and offline-capable before syncing with the backend database.

