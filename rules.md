# Ken Finance — Engineering Rules

> **Read this before writing any code.** Multiple people and AI agents work in this repo. These rules exist so that independently-written code composes instead of colliding. If a rule blocks something genuinely necessary, change the rule in a commit that says why — don't quietly work around it.

**Reading order for a new agent:** `rules.md` (this file) → `plan.md` (architecture & roadmap) → `CONTEXT.md` (current implementation state) → `todo_next.md` (what to do next).

---

## 1. Money — the one rule that is never bent

**Money is always an integer number of paise. Never a float. Never rupees in storage.**

```ts
amountMinor: number   // 24000 === ₹240.00        ✅
amount: number        // 240.00                    ❌ never
```

Floating point silently corrupts financial totals (`0.1 + 0.2 !== 0.3`). A rounding error in a budget app destroys the user's trust in every number on the screen, and it is unrecoverable after data exists.

- Convert at the **UI boundary only**, via `src/utils/money.ts` — never inline arithmetic like `amount * 100`.
- Any field holding money ends in `Minor`: `amountMinor`, `budgetMinor`, `balanceMinor`.
- Parsers return `amountMinor`. Display code calls `formatINR(amountMinor)`.

## 2. Types

- `strict: true` is on and stays on. **`npx tsc --noEmit` must pass with zero errors before every commit.**
- No `any`. Use `unknown` and narrow it. If you truly need an escape hatch, write `// eslint-disable` with a one-line reason.
- Never widen a union to `string` to make an error go away — fix the call site.
- `TransactionCategory` is a **closed enum of 8 values**. Adding a category means updating the enum, the category pills UI, and the LLM prompt taxonomy together, in one commit.
- Shared types live in `src/types/`. Do not redeclare a shape that already exists there.

## 3. State

- **Zustand (`src/store/useTransactionStore.ts`) is the single source of truth for transactions.** Do not add a parallel Context, reducer, or local mirror of the same data.
- All reads and writes go through the store so the app stays offline-first.
- Updates are immutable — always `map`/`filter`/spread, never mutate a draft in place.
- Derived values (totals, queue order, budget burn) are **selectors**, never duplicated state fields.

## 4. Ingestion & parsing

- Every incoming payment event — SMS *or* notification — enters through the **one** unified pipeline in `src/ingestion/`. Do not parse a payment anywhere else.
- **Parsers are pure functions.** `(input) => result | null`. No I/O, no store access, no `Date.now()` inside — take the timestamp as an argument so tests are deterministic.
- A parser that cannot confidently extract a field returns `null` for it. **Never invent a value.** A missing merchant is fine; a wrong merchant is a bug the user has to hunt down later.
- Every parser change ships with fixtures in `src/ingestion/__fixtures__/`. Bugs get a fixture reproducing them **before** the fix.
- Reject-cases are as important as parse-cases: OTPs, promotional offers, balance alerts, failed/reversed transactions, and collect *requests* must produce `null` and have fixtures proving it.
- Keep the original message in `rawPayload` forever. It makes every future parser bug retroactively fixable.

## 5. Reconciliation — who wins

When a voice note and a bank event describe the same payment:

| Field | Source of truth |
|---|---|
| `amountMinor`, `accountInfo`, `timestamp`, `refNo` | **Bank** (SMS / notification) |
| `title`, `note`, `category`, intent | **User's voice** |
| `paidTo` | Voice if human-readable, else cleaned bank merchant |

Deduplicate on `refNo` first; fall back to `(amountMinor, accountTail, ±180s)`. One real payment must never become two rows — double-counting is the fastest way to make the app untrustworthy.

## 6. Files & naming

```
src/
  types/         shared TypeScript interfaces and enums
  ingestion/     SMS + notification capture, parsing, dedupe   (pure)
  store/         Zustand store and selectors
  hooks/         React hooks (subscriptions, side effects)
  components/    presentational React components
  screens/       full screens composed from components
  utils/         pure helpers (money, dates, strings)
  native/        JS bridge to the Kotlin module
```

- Components: `PascalCase.tsx`. Hooks: `useCamelCase.ts`. Utils: `camelCase.ts`.
- One component per file, named the same as the file.
- **Components must not contain parsing, reconciliation, or money arithmetic.** If a component is doing that, it belongs in `utils/` or `ingestion/`.
- Order imports: React → third-party → internal (`src/...`) → types.

## 7. Native (Kotlin) code

- All native Android code lives in **one** Expo module. Do not scatter native code across community packages that go stale.
- The **voice-capture path stays off the React Native bridge.** Booting the bridge to open a microphone costs 1–2s and the user abandons. Kotlin writes to a staging buffer; JS drains it later.
- **Native never calls into JS as its system of record.** It writes to the staging buffers (`IngestionInbox`, `VoiceNoteBuffer`, `SkipBuffer`) and only then publishes a best-effort live event. A `BroadcastReceiver` fires whether or not React Native is alive, so anything that depends on the bridge being up will drop payments.
- **No parsing in Kotlin.** A second parser would drift from the tested one in `src/ingestion/`. Native captures raw text; JS decides what it means.
- Every `PendingIntent` sets `FLAG_IMMUTABLE` or `FLAG_MUTABLE` explicitly (required on Android 12+).

## 8. Comments

Explain **why**, not what. The code already says what.

```ts
// Bank SMS timestamps lag the actual payment by up to 90s, so widen
// the match window rather than trusting the bank's clock.        ✅
// loop through transactions                                       ❌
```

Every non-obvious regex gets one comment with a sample of the string it matches.

## 9. Git

**Code changes go on a branch; the branch is merged to `main` by whoever wrote it.**

- Branches: `feat/…`, `fix/…`, `docs/…`, `refactor/…`.
- Merge with `--no-ff` so the branch stays legible in history.
- **A pull request is optional, not a gate.** There is no standing reviewer, so waiting on review just parks work. Open a PR when you actually want a second opinion — a risky migration, a schema change, anything touching money — otherwise merge it yourself.
- **Documentation-only changes may go straight to `main`.** Branching a typo fix in `CONTEXT.md` is ceremony.
- **The real gate is the test suite, not review.** `npm run typecheck` and `npm test` must both pass *on the merge commit* before you push — not just on the branch tip. That is what protects `main` here, so never push through a red one.
- Imperative subject line under ~72 chars, then a body explaining *why*.
- Never commit `.env`, API keys, or real SMS/transaction data — fixtures must be redacted (account tails masked, names removed).
- Never commit generated output: `frontend/android/` and `frontend/ios/` come from `expo prebuild` and are gitignored deliberately.

## 10. For AI agents specifically

- **Read `plan.md` and `CONTEXT.md` before changing architecture.** If your change contradicts them, update the docs in the same commit — stale docs are worse than none.
- Prefer editing existing files over creating parallel ones. If you find yourself writing `smsParserV2.ts`, stop and refactor the original instead.
- Do not add a dependency without saying why in the commit body. Check whether an existing dep already does the job.
- Do not reformat or restructure files you weren't asked to touch — it buries the real diff and causes conflicts with other agents' work.
- **Update `todo_next.md` before you finish** — tick off what you completed, add what you discovered, correct what turned out to be wrong. The next agent is briefed by that file and nothing else, so leaving it stale strands them.
- When you finish, state plainly what you verified by running it versus what you only wrote. Android native code cannot be verified without a device or emulator; say so rather than implying it works.
