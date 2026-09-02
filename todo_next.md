# Ken Finance — What's Next

> Living backlog, ordered by what unblocks the most. See `rules.md` for binding
> conventions, `plan.md` for architecture, `CONTEXT.md` for current state.
>
> **Status at time of writing:** the decision layer (parse, dedupe, queue) is
> built and tested. The capture layer (Kotlin) is written but has never been
> compiled. Nothing has ingested a real payment yet.

---

## 0. Blocking everything — get the Kotlin to compile

Nothing below can be validated until the native module builds. This needs a
machine with the Android SDK installed.

- [ ] `cd frontend && npx expo prebuild -p android --clean`
- [ ] `npx expo run:android` (or open `frontend/android/` in Android Studio)
- [ ] Fix the first round of Kotlin compile errors — the code has been reviewed
      but never compiled, so expect ordinary ones: import paths, Expo Modules
      API signatures, resource references
- [ ] Confirm `NativeModules.KenIngestion` is defined at runtime. If it is
      `undefined`, every bridge call silently no-ops and the app will look
      like it works while capturing nothing

**Known risk areas, in rough order of likelihood**

1. `expo-module-gradle-plugin` availability and whether the `android` block in
   `modules/ken-ingestion/android/build.gradle` conflicts with what it sets
2. `AsyncFunction` signatures in `KenIngestionModule.kt` — multi-parameter
   lambdas and nullable arguments are the fiddliest part of the Expo API
3. `R` resource resolution inside the module (layouts, strings, plurals)
4. `android:showWhenLocked` on the capture Activity requires API 27; `minSdk`
   is 24, so lint may complain even though it is ignored at runtime

---

## 1. Prove ingestion end to end

Once it builds, verify the pipeline against real inputs rather than fixtures.

- [ ] **SMS path** — Android Studio → Extended Controls → Phone → SMS. Send a
      real bank-shaped message. This exercises the actual `SmsReceiver`, so no
      real money is needed
- [ ] **Notification path** — cannot be emulated. Use the module's
      `simulateEvent`, then confirm on a physical device with a real UPI app
- [ ] **Dedupe in the wild** — make one ₹1 UPI payment with both channels
      granted. Assert exactly one transaction row. This is the single most
      important manual check; everything downstream is worthless if payments
      double-count
- [ ] **Widget** — place it, inject an event, confirm it re-renders in ~1s
- [ ] **Capture latency** — time mic tap to microphone-live. Target <300ms; if
      it exceeds ~800ms something has pulled the RN bridge onto the hot path
- [ ] Add fixtures for every real message shape encountered, especially any
      that parse wrong. Bugs get a fixture *before* the fix (rules.md §4)

---

## 2. Persistence — currently everything is lost on app restart

The store is in-memory Zustand seeded from mock data. This is the largest
functional gap after capture.

- [ ] Local SQLite (`expo-sqlite`) as the source of truth, with the Zustand
      store hydrating from it. Offline-first is non-negotiable: SMS arrives
      when there is no network and must never be dropped
- [ ] Migration from the current in-memory shape; write it now while there is
      no real user data
- [ ] Supabase project — Postgres schema mirroring `Transaction`, phone-OTP
      auth, storage bucket for audio
- [ ] Sync queue with conflict handling. Device wins on `note`/`category`;
      server wins on nothing yet, since there is one client
- [ ] Wire the existing Express server as the API layer — it is still just a
      health route

**Schema note:** `amount_minor BIGINT`, never a float, on the server too.
A `UNIQUE` constraint on `dedupe_key` so double-counting is caught at the
database level and not only in app logic.

---

## 3. Kill the categorization tedium

The original problem. Three tiers, cheapest first.

- [ ] **Merchant memory** — categorize `Swiggy` once, every future Swiggy is
      automatic. Free, instant, and after a few weeks covers most volume.
      Build this before touching an LLM; it does the bulk of the work
- [ ] **Shipped merchant dictionary** — a few hundred common Indian merchants
      pre-mapped so the app is not useless on day one
- [ ] **Claude fallback** — only for genuinely new merchants, using the voice
      transcript as the signal. `claude-opus-5` via `@anthropic-ai/sdk` in the
      Express layer, structured outputs, taxonomy prompt-cached. Route
      backfill through the Batch API at 50% cost
- [ ] Decide on model tier with real data, not upfront. `claude-haiku-4-5` is
      ~5x cheaper and adequate for short-text classification

---

## 4. The payoff — budgets and analytics

None of this exists yet. It is the reason to keep using the app.

- [ ] Monthly budget per category
- [ ] **Burn rate vs. days remaining** — not "you spent ₹4,200" but "70%
      through the month, 90% through the food budget"
- [ ] **Safe-to-spend-today** — the one number people actually act on
- [ ] Merchant leaderboard
- [ ] Recurring-subscription detection (same merchant, same amount, ~30d)
- [ ] Weekly review notification — the natural moment to drain the backlog
- [ ] **Search over transcripts** — "what did I spend on client meetings?"
      This is what the voice notes uniquely unlock and no other tracker has

---

## 5. Known issues to fix

- [ ] **Replay-and-correct is half-built.** `SpeechRecognizer` takes exclusive
      hold of the microphone on most devices, so the parallel `MediaRecorder`
      usually fails and `audioPath` stays null. Editing the transcript works;
      replaying the audio usually will not. Options: accept transcript-only
      editing, or move to the cloud STT path (record with `expo-audio`,
      transcribe server-side) which also fixes Hinglish accuracy
- [ ] **Two allowlists must stay in sync** — `NotificationAllowlist.PACKAGES`
      in Kotlin (privacy gate: what gets buffered at all) and
      `NOTIFICATION_PACKAGE_ALLOWLIST` in TypeScript (correctness gate: what
      gets parsed). Different purposes, same list. Consider generating one
      from the other
- [ ] **Parse rules are hardcoded.** `plan.md` calls for a server-fetched
      versioned rule pack so a new bank ships without an app release. Worth
      doing before there are real users on old versions
- [ ] **No historical backfill.** The app starts empty. `READ_SMS` allows
      querying the SMS inbox via `ContentResolver` — not implemented
- [ ] `FloatingMic` still assumes it creates a new transaction in some paths;
      audit it against the queue flow now that notes can attach to existing
      payments

---

## 6. Before anyone else installs this

- [ ] Privacy policy — required for both the SMS declaration and notification
      access, and it needs to be truthful about what leaves the device
- [ ] Play Console permissions declaration for SMS. Expect rejection: the
      permitted-use list covers UPI transaction *verification*, not expense
      tracking. The notification path is designed to survive that outcome, so
      confirm the app is genuinely usable with `READ_SMS` removed
- [ ] Onboarding that explains notification access before dumping the user in
      Settings (the card exists; the full first-run flow does not)
- [ ] Redaction audit — confirm nothing sends raw message text anywhere, and
      that fixtures in the repo stay fabricated (rules.md §9)
