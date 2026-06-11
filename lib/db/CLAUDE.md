# lib/db — Firestore client + the two-ledger credit model

The Firestore singleton, Zod-backed converters, typed collection/doc helpers, and the credit gate that meters generation. `firestore.ts` owns the wire (lazy singleton, `withConverter` reads parse through Zod); `types.ts` owns every document schema. The non-obvious part is the credit gate, below.

## Two ledgers, different lifecycles

Cost and quota live in **separate collections** so an admin intervention on one never disturbs the other:

- `usage/{userId}/months/{period}` (`UsageDoc`) — the ACTUAL dollar cost, **accumulate-only**. Resets never touch it. Its sole gate consumer is the invisible `$50` backstop (`ACTUAL_COST_BACKSTOP_USD`), read via `getMonthlyUsage`. The user never sees this dollar figure.
- `credits/{userId}/months/{period}` (`CreditMonthDoc`) — the **resettable** user-facing gate. Balance is derived, not stored: `allowance(2000) + bonus − consumed`.
- `credits/{userId}/grants/{id}` (`CreditGrantDoc`) — append-only admin audit of every `reset` / `grant`, written in the **same transaction** as the balance change so effect and audit commit together or not at all.

**A missing credit doc reads as a full 2000 balance everywhere** — gate (`getCurrentCreditBalance` → `creditBalance(undefined)`) and dashboard (`getCreditSummary`'s `snap.exists` defaults) both share that rule, so a never-touched month needs no pre-seeding write to read correctly. That, plus per-month doc IDs, is the entire "monthly refill, no cron": the first chargeable turn of a month lazily seeds *that* month's doc with explicit `{allowance, consumed, bonus}` (`allowance` has no Zod default — its value is credit policy, seeded in code). There is no future-month pre-seeding.

## Pricing + the charge signal

Build = 100 credits, edit = 5 (`chargeAmount(appReady)` — same `appReady` boolean the route uses to pick the editing prompt). `isChargeableTurn` decides charge vs. free continuation off the **last message's role**: a fresh instruction ends with `user` (charge); an answered-`askQuestions` auto-resend ends with the SA's `assistant` (free, belongs to the run already charged). It MUST read the **raw `body.messages`**, never the route's last-user-message-only cache-expiry transform — that transform leaves a `user` message last on every POST and would charge every clarification round-trip.

## Reserve-before-run

A Firestore transaction in `reserveCredits` debits credits up front (read-check-write the literal `consumed + cost`, not `FieldValue.increment`, so the cap holds atomically under contention). The route places it after every pre-stream rejection point, so a booked charge is never stranded by an early return. The refund folds into the idempotent `UsageAccumulator.flush()`, gated `didReserve && (runFailed || costEstimate === 0)` and targeting the period **captured at reservation** (`chargePeriod`), so a flush that crosses midnight un-books the right month. A **failed run still accrues actual-$** — the backstop must see retry-spam — only the credits are refunded; the two decisions are independent.

## Client vs server split

- `creditPolicy.ts` — **client-safe**: pure constants + rules (`chargeAmount`, `isChargeableTurn`, `creditBalance`), every import `import type` so no Firestore enters a bundle. Imported by the chat gate, the `ChatInput` send-button cost chip, and `AccountMenu`. Dropping a `type` keyword would drag `@google-cloud/firestore` client-side — keep every import type-only.
- `credits.ts` — the **server** ledger: `reserveCredits` / `refundReservation` / `resetCredits` / `grantCredits` / `getCreditSummary` / `getCurrentCreditBalance`, all Firestore transactions.

The reservation/refund/reset/grant transactions read through `docs.creditMonthRaw` (the converter-less ref), not the converter ref: a `withConverter` `tx.get()` routes the snapshot through `schema.parse`, which throws inside the transaction on a partially-seeded doc. They read raw, supply the missing-doc defaults in code, and merge back. Settled non-transactional reads (`getCreditSummary`, `getCurrentCreditBalance`) use the converter ref — a settled doc is always complete.

## Finalization invariant — run-completion, not the request

In `/api/chat`, finalization (the charge-vs-refund credit decision + run summary + actual-$ accrual) runs **once, on the run's true terminal state**, server-side, via the route's `finalizeRun()`. It is driven by the agent drain COMPLETING (`consumeStream()` advancing the tool loop to its terminal state), NOT by the browser connection: a closed tab neither cancels the run (no `req.signal` is forwarded into the agent anymore) nor finalizes it. The drain reaching its end is what keys the flush, so a zero-step model error — which fires no agent callback at all — still finalizes and the request can't hang.

A failure (a fatal `{type:"error"}` stream chunk, or an init throw) funnels through `failRun()` → `markRunFailed()` + `flush()` (refund; actual-$ still accrues so the `$50` backstop sees retry-spam) and only THEN `failApp()` — and only if the refund actually committed. A stranded refund leaves a failed build `generating` so the **reaper** retries it, mirroring `reapStaleGenerating`'s refund-before-flip discipline. A non-fatal `tool-error` chunk is NOT a run failure (the SA loop recovers from it); the route keys failure on the fatal chunk type, not on any `onError` firing.

The one terminal state no in-process callback can reach — a hard process kill — is settled by the stale-`generating` reaper (`reapStaleGenerating`), which refunds the stranded build reservation off the durable `reservation` marker on the app doc. Edits stay `complete` (never `generating`), so a hard-killed edit's 5-credit hold is an accepted residual. A clean build run flips `generating → complete` at the route's drain end (`completeApp` — status-only; the chained intermediate saves own the blueprint). EVERY chargeable build-mode POST against an existing app re-enters the reaper's coverage the same way: the chat route claims the run window (`claimBuildRun`, awaited, fresh `updated_at`) before its concurrency check — the same write-then-check ordering `createApp` uses for fresh builds — transactionally flipping `error` (a retry), `complete` (a new instruction into a finished build, e.g. the reply after a purely conversational first turn), or a paused `generating`+`awaiting_input` row to a live `generating`, so a hard-killed run's reservation refunds exactly like a first build's whatever shape the row started in. The claim is a transaction because same-app contenders share one row (which `hasActiveGeneration` excludes as the contender's own): the compare-and-flip is what arbitrates them — the loser throws `BuildRunConflictError` and the route 429s it without touching the winner's live lock. The claim returns the shape it moved the app out of, and every pre-stream bail-out (concurrency 429, out-of-credits, reservation failure) restores exactly that shape — a rejected request must never leave a previously-`complete` app anywhere but `complete`.

## Period leaf

`period.ts` is a deliberate dependency-free leaf holding `getCurrentPeriod` (UTC `yyyy-mm`). Both ledgers key on it, and `usage` imports the refund from `credits`; keeping the shared function out of `usage` breaks what would otherwise be a `usage ↔ credits` import cycle (`usage → credits → period`).
