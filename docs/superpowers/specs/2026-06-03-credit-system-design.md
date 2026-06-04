# Credit System — Design Spec

**Date:** 2026-06-03
**Status:** Approved design (rev 4); implementation plan written; pending final go.
**Branch/worktree:** `worktree-credit-system`

> **Rev history.** Rev 1 → a 5-lens adversarial review found 2 critical + 12 major issues; the biggest was that "charge once per `runId`" is wrong because a `runId` spans an entire mounted *sitting*. **Rev 2** re-based the charge on a per-POST, server-observable **last-message-role** signal and reworked reservation/migration/constants (see "Review resolutions" appendix). **Rev 3** — after surfacing to the user that rev 2 had silently drifted from their picked charging unit — adopts **tiered per-instruction pricing: build = 100 credits, edit = 5**, so iterating feels nearly free while builds remain the meaningful unit. The amount keys off `appReady` (already the build-vs-edit signal). **Rev 4** (this rev, per user direction): (a) **refund a failed run** — a build that fails to validate or an edit that breaks the app refunds its reserved credits (the primary support fix; actual $ still accrues so the $50 backstop guards retry-spam), with a **refund toast**; (b) the migration **explicitly seeds** credits create-only rather than relying on permanent runtime lazy-init. Everything else from rev 2–3 stands. **Rev 5** (implementation, Task 7 review): added the **client-disconnect (abort) finalization invariant** to §7 after review found the original gate's abort listener flushed the accumulator mid-flight — refunding a real run and erasing its cost. The fix threads `abortSignal` into the stream and makes the execute `finally` the sole authoritative charge-vs-refund flush. **Rev 6** (migration, per user direction): the cost-restore switches from rev-2's conservative verified-only restore to **re-baselining `usage.cost_estimate` from the run-ledger** (the authoritative per-run record; usage docs under-count fleet-wide). The rev-2 hazard analysis is NOT dropped — it's reframed as the migrator's per-cell guard checklist (§9a): the ledger total is accurate (one doc per `runId`, no thread double-count; `recover-app` clones nothing) but per-`(user,period)` writes still need cross-month flagging, and the current month is gated separately from closed months because it feeds the live `$50` backstop. The read-only scan is built + run first so the apply is confirmed on real deltas.

## 1. Why

Today a user is gated by a **per-month dollar cap** (`MONTHLY_SPEND_CAP_USD`, default $15, `lib/db/usage.ts`) checked against `usage/{userId}/months/{period}.cost_estimate`. Two problems:

1. **Overspend by construction.** Dollar cost never lands exactly on $15, so the last generation always pushes a user *over* the cap (a single cache-expired opus-4-8 edit was $15–$19 in PROD: alohi $18.77, mmaher $15.02). The cap stops you *after* you've gone over, not before you start what you can't afford.
2. **Resets destroy cost truth.** "Resetting" a user means hand-blanking `cost_estimate` — the same field that *is* the cost record. PROD proof: the untampered run ledger totals **$122.28**, the monthly usage docs claim **$89.12** → the **$33 gap is cost hidden by manual resets**. There is no way to comp a user without lying to reporting.

The fix is the model every credit product converges on: **separate the gating ledger from the cost ledger.** Credits become the user-facing, resettable quota; actual dollar cost lives in a ledger that resets never touch.

### Goals
- Replace the dollar cap with a **credit balance** as the user-facing gate.
- **Reserve credits before a generation runs** so spend can never overshoot mid-action.
- Track **actual dollar cost** in a ledger that admin resets never mutate.
- Make "reset a user's usage" a **first-class, audited credit grant** — zero effect on cost reporting.
- Surface, per user: **credits used (this period AND lifetime), credits remaining, actual $ cost (this period AND lifetime)**, and a **reset/grant action**.
- Keep an **invisible actual-$ runaway backstop** so flat-credit pricing can't be abused on the shared Anthropic key.
- Replace the user's own dollar usage bar (`AccountMenu`) with a credit balance.

### Non-goals
- **Selling credits.** Users are the internal `@dimagi.com` allowlist; credits are a free monthly allowance, not a SKU. No $/credit *price*, no Stripe, no margin.
- **Gating MCP.** `lib/mcp/context.ts` has no Anthropic client — "the MCP server does not reason; the client does." MCP incurs **zero Nova-side LLM cost** (the external Claude Code client pays for its own reasoning), so MCP stays ungated. The gate lives only in `/api/chat`, where the dollar cap lives now.
- **Per-model / per-tier credit pricing.** A generation is a flat 100 credits regardless of model or conversation length. Variance is absorbed by the backstop + the actual-cost ledger (which gives the data to add tiering later if warranted).

## 2. Locked decisions

| Lever | Decision |
|---|---|
| **Charging unit** | Per **new user instruction** — see §2a. **Tiered: build = 100 credits, edit = 5 credits**, reserved up front. Clarification answers and the rest of a multi-turn generation are free. |
| **Denomination** | Penny-anchored: **1 credit = $0.01**. **Build = 100 ($1), edit = 5 ($0.05)**. **Monthly allowance = 2,000 credits** (≈20 builds, or hundreds of edits). |
| **Build vs edit** | **Build 100, edit 5.** Edits are deliberately cheap so iterating feels nearly free — *priced on perceived value, decoupled* from the fact that an edit currently costs MORE in dollars than a build (the cache-expiry artifact). The $50 backstop + cost ledger gate and track the real dollars; credits meaningfully gate builds, the backstop gates edit runaways until the artifact is optimized. |
| **Rollover** | **None** — allowance is a fresh 2,000 each calendar month, realized as per-period docs; no cron, no carryover. |
| **Cost backstop** | **$50/user/month of actual cost**, invisible, hard. Never trips in normal use; caps a worst-case runaway. |

### 2a. What is one chargeable generation? (the crux, re-derived from the real flow)

A `runId` is **not** one generation — it spans an entire mounted sitting (`components/chat/ChatContainer.tsx` resets `runIdRef` only when the session/`buildId` identity changes, i.e. on reload/navigation; `lib/db/runSummary.ts`: "a runId spans every request in the same thread"). Charging per `runId` would charge once per sitting and let a user edit unboundedly for 100 credits.

`askQuestions` (`lib/agent/tools/askQuestions.ts`) is a **stream-ending** tool: the request ends with the question, the user taps options, and the client **auto-resends** (`ChatContainer.tsx::shouldAutoResend`) — which fires exactly when **the last message is an `assistant` message** carrying an answered `askQuestions`. A fresh user instruction always appends a **`user`** message.

**Therefore the chargeable signal — observable at the top of every POST, with no client cooperation and no spoof surface — read from the RAW incoming `body.messages` (see the trap below):**

```
CHARGE (a new generation)  ⇔  the last entry in body.messages is a `user` message.
FREE  (a continuation)     ⇔  the last entry is an `assistant` message
                              (an answered-askQuestions auto-resend).

AMOUNT  =  appReady ? CREDITS_PER_EDIT (5) : CREDITS_PER_BUILD (100)
           (appReady already splits build vs edit mode in the route: `editing = !!appReady`)
```

- A **build** instruction (appReady false) ending in a `user` message → **charges 100**.
- Each subsequent **edit** instruction (appReady true) ending in a `user` message → **charges 5**.
- A clarification round-trip within either (auto-resend) ends with an `assistant` message → **free**; it belongs to the generation already charged when the user's instruction kicked it off.
- Per-POST, so each charge is independent: no `runId`-spanning idempotency marker, and the phantom-refund class of bug (a later turn refunding an earlier turn's charge) cannot occur.

> **Trap (load-bearing):** the route's message strategy sends *last-user-message-only* after prompt-cache expiry. The charge signal MUST read the **raw `body.messages`** (and `body`'s `appReady`), *before* any message-strategy transform — reading the transformed array would make the last role always `user` and silently break the clarification-free property. `appReady` comes from the raw request body, so the amount is unaffected, but the charge-or-not signal is.

**Accepted wart (now trivial):** a non-mutating user message (rare chit-chat / a question to the SA) ends with a `user` message and so charges — but in edit mode that's only **5 credits**, negligible. (A build-mode message essentially always generates.) The real mutation of a generation may land in a *later* continuation turn, so a "refund if this turn produced no mutation" rule would wrongly refund the question-asking first turn of a build; refund is therefore reserved for **hard failures only** (zero billable cost — the SA didn't run). In Nova the chat *is* the build surface, so non-instruction messages are rare anyway.

## 3. Constants

Credit constants are **gate/quota policy**, not model-keyed config. They live with the gate they govern — a new **`lib/db/credits.ts`** that owns the credit ledger, exactly where `MONTHLY_SPEND_CAP_USD` lives today (next to `getMonthlyUsage`), **not** in `lib/models.ts` (which holds only model-keyed IDs/pricing). The env-var override is dropped (credits are not per-environment tunable).

```ts
// lib/db/credits.ts
export const CREDITS_PER_DOLLAR       = 100;   // 1 credit = $0.01 (re-exported for the admin/user $ hint)
export const CREDITS_PER_BUILD        = 100;   // a new-app generation ($1)
export const CREDITS_PER_EDIT         = 5;     // an edit to an existing app ($0.05) — kept cheap so iterating feels free
export const MONTHLY_CREDIT_ALLOWANCE = 2000;  // ≈20 builds, or hundreds of edits; resets monthly, no rollover
export const ACTUAL_COST_BACKSTOP_USD = 50;    // invisible runaway guard (the real cost gate for edit runaways)
```

## 4. Data model — two ledgers

### 4a. Actual-cost ledger (the truth; resets never touch it)
**Unchanged storage, changed contract.** `usage/{userId}/months/{period}` (`UsageDoc`) **remains** the monthly per-user cost rollup, written by `UsageAccumulator.flush()` via `incrementUsage` exactly as today (its only writer — verified). The contract change: it is now **accumulate-only / monotonic** — incremented by `flush()`, **never zeroed or decremented**; resets live exclusively in `credits/`. `cost_estimate` means real dollars spent. Lifetime actual cost = sum of a user's usage months (this rollup survives app deletion; the per-run ledger does not). The per-run ledger (`apps/{appId}/runs/{runId}.costEstimate`) is unchanged.

### 4b. Credits ledger (the gate; resettable)
**New collection**, period-keyed like usage:
```
credits/{userId}/months/{yyyy-mm}   → CreditMonthDoc   (the O(1) balance for the gate)
credits/{userId}/grants/{grantId}   → CreditGrantDoc   (append-only admin audit)
```
`CreditMonthDoc`: `allowance:number` (2000), `consumed:number`, `bonus:number`, `updated_at`. **Balance = `allowance + bonus − consumed`.**

`CreditGrantDoc` (one per admin action — the comp audit trail per Stripe/Orb/Metronome): `amount`, `type:"reset"|"grant"`, `actor`, `actor_email`, `reason:string|null`, `period`, `ts`.

**Reads bypass the Zod converter via a raw doc ref** for the gate transaction (see §5b): a `withConverter` `tx.get()` routes through `schema.parse`, which `lib/db/runSummary.ts` documents as a throw hazard on a partially-initialized existing doc. The reservation supplies `{allowance:2000, consumed:0, bonus:0}` defaults in code when the doc is missing (`snap.exists === false` → no parse) and tx.set the seeded doc + debit together. Writes (`FieldValue.increment`) pass through cleanly. **A missing credit doc is treated everywhere — gate and dashboard — as a full `2000/2000` balance**, so no pre-seeding write is required for correct day-one reads.

## 5. Credit lifecycle

### 5a. Monthly allowance
Implicit and lazy: a new month's first chargeable turn creates the period doc seeded `allowance:2000, consumed:0, bonus:0` inside the reservation transaction (explicit values, **not** a Zod default). No cron, no rollover.

### 5b. Reserve (the no-overshoot mechanism)
A chargeable turn (§2a) reserves `cost = appReady ? CREDITS_PER_EDIT : CREDITS_PER_BUILD` **before the SA runs**, as a **`db.runTransaction` over the raw `credits/{userId}/months/{period}` ref** (mirroring `writeRunSummary`, not the unconditional `incrementUsage` set-merge):
1. `tx.get(rawRef)`. If missing → balance = 2000; else compute `allowance + bonus − consumed` from raw data.
2. If `balance < cost` → throw `OutOfCredits` (route → 429).
3. Else `tx.set(rawRef, {allowance, bonus, consumed: consumed+cost, updated_at}, {merge:true})`.

The transaction closes the cross-app concurrent-new-run race (`hasActiveGeneration` locks per-app and fails *open*, so it does not). The reservation records on the accumulator seed: `didReserve = true`, the **reserved amount** (so the refund returns exactly what was taken), and the **charge period**.

### 5c. Refund (failed run OR zero-cost no-op)
A reserved turn is refunded when the run **fails** — it ended in error / the app failed to validate / the app was left in an error state — **or** produced zero billable cost. `flush()` refunds **iff `didReserve && (runFailed || costEstimate === 0)`**, decrementing `consumed` by the **reserved amount** (5 or 100, captured at reservation) on the **charge period captured at reservation** (not `getCurrentPeriod()` at flush — a post-UTC-midnight flush would refund the wrong month).

`runFailed` is set by the route's single failure funnel `app/api/chat/route.ts::handleRouteError` (every stream/init error + `failApp` path flows through it). This is the **primary support fix**: ~half of reset requests were users who hit an error and retried — so a build that fails to validate refunds its 100, and an edit that breaks the app refunds its 5. The user retries on a fresh (re-charged, possibly re-refunded) run.

Two deliberate properties:
- **Actual $ still accrues on a failed run** (the SA ran; `cost_estimate` increments as today) — so the **$50 backstop still sees retry-spam** and is the guard against farming refunds (which is also self-defeating: forcing an app into error loses access to that app).
- **`didReserve` gates the refund**, so a free continuation (which never reserved) cannot phantom-refund; there is no cross-turn marker at all.

**Refund toast.** When a run is refunded, the route emits a transient `data-credit-refund` part (`{ amount }`) from inside `handleRouteError` (guarded to fire once, only when the run reserved); the client shows a toast: *"This generation ran into an error, so you weren't charged — your N credits were refunded."* The toast is optimistic (emitted at failure-detection inside the stream); the actual decrement lands in `flush()` (its write catches its own error — a rare refund-write failure is logged, not surfaced).

### 5d. Reset / grant (admin, comp pattern)
Both are a **single transaction/batch** spanning the month doc **and** the new `CreditGrantDoc`, so balance and audit commit atomically:
- **Reset**: set current period `consumed = 0` → balance restored → user unblocked. Appends `CreditGrantDoc{type:"reset"}`.
- **Grant**: `bonus += amount`. Appends `CreditGrantDoc{type:"grant"}`.
Admin-only; **never touches `usage/` (cost reporting)** by construction.

## 6. The gate (`/api/chat`)

Replaces the dollar-cap block. **Placement matters:** the credit *read* (fast-fail) sits where the dollar cap is today (top of handler), but the transactional *reserve* must run **after** `runId`/`appId` resolution and after every pre-stream rejection point (`createApp` 503, ownership 404, `hasActiveGeneration` 429) so no early return follows a reservation and leaks it. Order:

1. **Determine chargeable + amount** from the RAW `body.messages` (last role `user`?) and `body.appReady` (`appReady ? 5 : 100`) — read before any message-strategy transform (§2a trap).
2. **Fast-fail read** (top of handler, fail-closed → 503 on Firestore error):
   - **Backstop (every POST, incl. continuations):** `usage.cost_estimate >= ACTUAL_COST_BACKSTOP_USD` → 429, generic message (no "$50" leaked).
   - **Balance (chargeable POSTs only):** read via `getCurrentCreditBalance` (a single current-period doc read — the gate only needs the scalar balance, not the fuller `getCreditSummary` the user/admin surfaces use); if balance `< cost` (5 or 100) → 429 `out_of_credits` ("You're out of credits for this month — they refresh on the 1st."). Avoids creating an orphan app in the common out-of-credits case.
3. Resolve `appId` (`createApp` lock for new builds), verify ownership, `hasActiveGeneration`.
4. **Reserve** (chargeable POSTs only): the §5b transaction. The rare race (passed step 2, lost at step 3's transaction) → `failApp` + 429. The marker-read/transaction failure is **fail-closed → 503**, never a silent skip-the-charge.
5. Build accumulator (`didReserve`, charge period), stream, `flush()` (refund per §5c).

`errorClassifier.ts`'s `spend_cap_exceeded` member → `out_of_credits` (a closed union → `tsc` enforces full rename; `McpErrorType` inherits it; no persisted `error_type` carries the old literal). `app/api/user/usage/route.ts` returns credit balance/allowance/consumed.

## 7. Debit integration
The **reserve** lives in the route gate (§6). The **refund** folds into the existing idempotent `flush()` (`_finalized`-guarded; first call wins → never double-refunds), gated on `didReserve && (runFailed || costEstimate === 0)` against the captured charge period. `runFailed` is a flag set via `usage.markRunFailed()`, called inside `handleRouteError` (the one place that already classifies the error + calls `failApp`). The same spot emits the transient `data-credit-refund` part (once, when the run reserved). No new finalize path; no new failure funnel.

**Client-disconnect (abort) finalization — anti-abuse invariant.** A client disconnect must never refund a real in-flight run nor erase its accrued actual-$ cost (either would be a farm-able hole: disconnect mid-build → free, cost-invisible run). The model call is cancelled by threading `abortSignal: req.signal` into the agent stream, but already-streamed steps still accrue cost. Three rules enforce this, all landed in Task 7:
1. The **execute `finally`'s `usage.flush()` is the sole authoritative** charge-vs-refund decision — it runs only after the stream reaches its true final state (completed, cancelled, or errored), so it sees the real final `costEstimate`. `onFinish` keeps a fire-and-forget fallback flush; both are idempotent.
2. The `req.signal` `"abort"` listener flushes **only the log writer**, never the accumulator. A mid-flight accumulator snapshot has `costEstimate === 0`; flushing it would refund the reservation and latch `_finalized`, no-op'ing the real flush — finalizing a cost-accruing run as a free refunded build.
3. `handleRouteError` **short-circuits on `req.signal.aborted`** (a disconnect can still surface a throw when `writer.write` hits the torn-down stream). On a true abort it does not `markRunFailed`/`failApp`/refund-toast — the `finally` flush decides purely on the final `costEstimate` (0 steps → refund, ≥1 step → keep the charge).

This invariant was surfaced by the Task 7 code review (the original draft's abort listener flushed the accumulator) and is the reason the gate threads `abortSignal` and centralizes finalization in the `finally`.

## 8. Admin & user surface

Per memory: **frontend tasks load the `frontend-design` skill and build from `@/components/shadcn` (`base-nova`), not raw Base UI**; icons from `@iconify/react/offline` (Tabler). The `AlertDialog` shadcn component exists.

### 8a. User table (`lib/db/admin.ts::getAdminUsersWithStats`, `app/(app)/admin/user-table.tsx`, `lib/admin/types.ts`)
`AdminUserRow` gains: `credits_used` + `credits_remaining` + `credits_allowance` (this period), `credits_used_lifetime`, and `cost_lifetime` — **both lifetime figures rendered as columns/figures, not summed by eye** (satisfies the user's explicit "total credits" *and* "total cost"). `cost` (this-period actual $) stays, relabelled as true cost. Headline `AdminStats` adds fleet credits consumed. Lifetime credits used = Σ `consumed` across credit months; lifetime cost = Σ `cost_estimate` across usage months — **distinct metrics** (flat pricing decouples them; do not derive one from the other).

### 8b. User detail (`app/(app)/admin/users/[id]/`)
- Per-period table gains credit columns (allowance / consumed / bonus / balance) beside actual-cost columns, **with a totals row** (lifetime credits used + lifetime cost).
- **Reset / grant action** (the headline feature): a shadcn `AlertDialog`-confirmed control → the new admin endpoint; optional reason; renders the `credits/{userId}/grants` audit trail.

### 8c. Admin endpoint (establishes the first admin *write* route)
No existing admin write route to mirror (all `app/api/admin/**` are `GET`; the one admin mutation, impersonation, goes through Better Auth's client). New **`POST app/api/admin/users/[id]/credits`**, `requireAdmin(req)` gate, `ApiError`/`handleApiError` envelope (the convention that carries over), performing the §5d transaction. Documented as establishing the pattern, not following one.

### 8d. The user's own view (`components/ui/AccountMenu.tsx`)
Convert the usage bar from `$cost / $cap` to **`credits remaining / 2,000`**: update its `UsageData` interface, `usageRatio` → `consumed/allowance`, and `getBarGradient` threshold to the credit balance. The dollar figure is removed from the user's view (it was the "feels like dollars" surface). `app/api/user/usage/route.ts` returns the credit shape; pick **one** response shape (credits), not a straddle.

### 8e. Refund toast (chat surface — `components/chat/ChatContainer.tsx`)
The client's existing `onData` handler (which already routes `data-run-id`, `data-app-id`, `data-error`, …) gains a `data-credit-refund` case that fires a toast via Nova's toast provider: *"This generation ran into an error, so you weren't charged — your N credits were refunded."* One toast per refunded run.

### 8f. Send-button cost indicator (cost transparency before sending)
Next to the chat send button, a subtle chip shows what the action about to be sent will cost — `chargeAmount(appReady)` from the **client-safe `creditPolicy`** (100 for a build, 5 for an edit) — with a hover tooltip: *"This build will use 100 credits"* / *"Edits use 5 credits — clarifying questions are free,"* plus *"You have N credits left this month"* (balance from the same usage fetch `AccountMenu` uses, via a shared `useCreditBalance` hook). `appReady` is read from the same client state the composer already puts on the request, so the displayed cost can never disagree with the actual charge. This is the single source of cost truth surfaced to the user before they commit.

## 9. Migration (one-off; scan + dry-run migrate; deleted after apply)

Per memory: BOTH a read-only scan and a migrator (dry-run default, `--apply`); user owns the decision; deleted after the apply output is captured; runs **post-merge** against PROD (the worktree never touches PROD). Reuses the read-only `scripts/inspect-usage.ts` / collection-group patterns.

### 9a. Restore actual-cost truth — re-baseline from the run-ledger (Rev 6, per user direction)
The usage docs historically under-count actual cost (fleet ≈ $89) vs the run-ledger (≈ $122) — the per-run summaries at `apps/{appId}/runs/{runId}` are the authoritative record. **Per user direction (chose "re-baseline everyone from the run-ledger" over the conservative verified-only restore), the migration re-baselines `usage.cost_estimate` from the run-ledger.** But "the ledger total is accurate" does NOT make "overwrite every `(user, period)` cell" safe — the migrator writes per cell, and the rev-1/rev-2 hazards below all live at the per-cell level. They are NOT obsolete; they are the **migrator's guard checklist**, and the **read-only scan is built + run first** so the user confirms on real deltas, not on argument.

**Verified-in-source (clears the fleet total, not the cells):** `writeRunSummary` writes ONE doc per `runId`, accumulating `costEstimate` via `FieldValue.increment` across every turn in the thread — so summing run docs never double-counts a thread (one doc per thread, not per turn). `recover-app` only flips status on the **existing** app doc; it never clones an app or copies runs, so the `apps.owner` join can't double-count via a duplicate app. My operational reset zeroed only the usage docs, never the ledger — so the ledger still holds mmaher's/alohi's true costs and re-baseline restores them from the truer source automatically (no recorded-constant needed; the recorded figures 15.015480 / 18.767942 / orphan 4.67965175 remain only as scan cross-checks).

**Per-cell caveats the re-baseline MUST handle (the surviving rev-2 hazards):**
- **Cross-month threads.** A run doc stamps its whole-thread `costEstimate` at `finishedAt`'s month (scalar-overwrite, last turn wins). A thread straddling a month boundary attributes ALL its cost to the later month — over-attributing it, under-attributing the earlier month. The scan **flags every run whose `startedAt`/`finishedAt` straddle a boundary as CROSS-MONTH — manual review**; the user reviews the flagged set before `--apply`.
- **Closed months vs the current month — the decisive split.** Reporting accuracy (the actual goal) is about **closed** months; only the **current period (2026-06)** write touches the live `$50` backstop (`cost_estimate >= ACTUAL_COST_BACKSTOP_USD` → 429 on *every* POST incl. free continuations). So a current-month re-baseline can **re-block the very users I reset to unblock** — and early-June current-month is the MOST cross-month-exposed (a thread finishing in June carries its May turns' whole cost). Therefore: **re-baseline CLOSED months freely; for the CURRENT month, flag-and-confirm per user — never silent-write.** The scan surfaces every current-month over-$50 case loudly.
- **Soft-deleted apps.** Their runs survive and represent real incurred cost the usage accumulator counted at the time, so the ledger sum includes them (matching usage semantics — no exclusion); the scan notes soft-deleted contributions for transparency.

The scan computes per `(user, period)`: current `cost_estimate`, ledger-sum, **delta**, cross-month flag, soft-deleted contribution, and the current-month over-$50 flag. Task 16's overwrite behavior stays **provisional until the scan output is reviewed with the user** at apply-time (the post-merge checkpoint).

### 9b. Delete the orphan — guarded, separate pass
Only after the re-baseline is **durably applied and confirmed in PROD**: a third run/commit asserts `re-baselined cost_estimate >= live-read orphan value` as a precondition (April 2026 is a closed month, so its re-baseline writes freely), then deletes `unadjusted_estimate` from `usage/w4KlwedcG1WijXOK0hVz/months/2026-04`. Never deleted in the same `--apply` that writes the re-baseline.

### 9c. Credits init — explicit one-time seed in the migration
The migration **explicitly seeds** every existing user's current-period credit doc (`{allowance: 2000, consumed: 0, bonus: 0}`) — a one-time script action, not permanent runtime lazy-init. To avoid clobbering a doc a user may have lazily created by generating in the gap between deploy and running the migration, the seed is **create-only** (writes only docs that do not already exist; via `create()` / a `tx.get`-then-create transaction). The reset users (mmaher, alohi) start the new system at a full balance; their dollar history stays in the cost ledger.

This is distinct from two runtime behaviors that legitimately stay (not "lazy migration"): (1) the reserve transaction seeds the **current** period's doc on that month's first charge (`reserveCredits` writes only `getCurrentPeriod()` — verified in shipped code; there is no future-month pre-seed) — so a new month's first chargeable turn lazily creates that month's fresh doc, which is the monthly refill with no cron; (2) `creditBalance(undefined)` returns a full balance on a **read** of an untouched month — a read-time default, no write. Neither is a migration mechanism.

### 9d. Sequencing & stopgap cleanup
Scan → review deltas + cross-month + current-month-over-$50 flags with user → `--apply` re-baseline (closed months auto; current-month writes only for users the user confirms) → capture output → (separately) `--apply` orphan-delete → `git rm` both migration scripts. Note: today's resets are **manual Firestore hand-edits** (there is no committed reset script to remove); a private uncommitted `scripts/reset-usage.ts` exists on the author's `main` working tree and is deleted there once the admin endpoint ships — it is not in version control and is out of this PR's scope. `.env.example`'s `MONTHLY_SPEND_CAP_USD` block is removed in this PR (no other config depends on it).

## 10. Tests (state model, not DOM — per memory)
- **Credit ledger logic** (pure/transactional): balance math; reserve-transaction seeds a missing period doc; reserve the right amount (build 100 / edit 5) below/at/above balance; refund the reserved amount when `didReserve && (runFailed || costEstimate===0)` — incl. a **failed run with cost>0 still refunds** (and the usage/cost increment still happens); a free continuation (didReserve false) never refunds; charge-period binding across a month boundary; reset/grant atomicity (month doc + grant row together); concurrent reservation races (transaction serializes).
- **Charge-signal logic** (pure): `isChargeableTurn(rawMessages)` — last-role `user` vs answered-askQuestions `assistant`; the amount selector `appReady ? 5 : 100`; build-then-edit-then-clarify sequences (build 100, edit 5, clarify 0).
- **Gate**: out-of-credits 429, backstop 429, continuation bypass, fail-closed 503 on every new read (balance, backstop, reservation).
- **Migration reconciliation** (pure): the per-`(user,period)` ledger-sum grouped by `finishedAt`'s month; cross-month flag (a thread whose `startedAt`/`finishedAt` straddle a boundary); closed-month vs current-month routing (current-month over-$50 flagged, never silent-write); soft-deleted contributions included + noted; orphan-delete precondition (`re-baselined >= orphan`); **create-only credit seed is idempotent** (re-running never overwrites an existing doc / never resets a generated user's consumed); on fixtures mirroring mmaher/alohi/andiaye/cross-month/soft-deleted shapes.
- `scripts/test-schema.ts` if any schema changes (none to the SA tool surface expected). `npm run test:leaks` green before merge.

## 11. Docs
- `lib/db/CLAUDE.md`: the two-ledger model + the accumulate-only/"resets never touch cost" invariant.
- Root `CLAUDE.md`: "Fail-closed persistence"/usage sections move from "spend cap" to "credit gate + invisible backstop."
- Public docs site (`app/(docs)/`): audit during the `docs` skill pass for any user-facing $15-cap mention → credits.

## 12. Final verification (user-runnable acceptance)
> Admin runs `npm run dev`, opens `/admin`, and sees per user: **credits used / remaining this month**, **lifetime credits used**, **actual $ this month**, and **lifetime $** — all as rendered figures. On a user's detail page the admin clicks **Reset credits**, confirms the dialog, and sees `consumed` drop to 0 / balance return to 2,000, a new audit row appear, **and both the actual-$ this-month and lifetime-$ figures unchanged**. As that user, the `AccountMenu` shows a **credits-remaining** bar (no dollars); a **build** debits **100**, each **edit** debits **5**, and answering a **clarification** mid-generation debits **0**; when the balance can't cover the next charge the request is blocked "out of credits." A generation that **fails / produces a broken app** shows a **refund toast** and leaves the balance unchanged (debited then refunded), while the admin's **actual-$ figures still increase** for that failed run.

## 13. Risks
- **Flat-credit cost tail.** 20 generations is ~$4 (cheap builds) to a theoretical ~$360 (max-cost edits). Accepted; the $50 backstop caps the disaster, the cost ledger gives tuning data.
- **Non-mutating message charges** (§2a wart) — now trivial: 5 credits in edit mode (the only realistic case). Accepted.
- **Edit cost > build cost** ($2.70 vs $0.84 mean) — investigation deferred to wrap-up (hypothesis: cache-expiry full-history reprocess on opus-4-8; `freshEdit`/`cacheExpired` flags will confirm). Not a blocker.

## Appendix — Review resolutions (rev 1 → rev 2)
- **CRIT per-runId unimplementable** → charge per new-user-instruction (last message role), per-POST; `runId` stays thread identity (§2a).
- **CRIT phantom refund** → refund gated on `didReserve` (per-POST) + captured charge period; no cross-turn marker (§5c).
- **MAJ "same pattern as usage"** → reservation is a `runTransaction` over a **raw** ref with code-supplied defaults; only the conditional read needed the change (§4b/§5b).
- **MAJ gate placement / reservation leak** → fast-fail read at top, transactional reserve after all pre-stream rejections; enumerated returns (§6).
- **MAJ zero-cost marker** → no marker; per-POST independence (§5c).
- **MAJ migration over-restore / soft-delete** → drop `max()`; restore only verified values, flag the rest for human review; named period field; soft-delete acknowledged (§9a).
- **MAJ no admin write precedent** → `POST .../credits` establishes the first; ApiError envelope carries over (§8c).
- **MAJ constants placement** → `lib/db/credits.ts`, not `lib/models.ts` (§3).
- **MAJ lifetime credits + lifetime cost** → both surfaced as figures + in §12 (§8a/§8b).
- **MIN** immutable→accumulate-only; lazy seed in-transaction; reset atomic batch; collectionGroup algorithm named; orphan-delete precondition + separate pass; credits seed dropped (absent=full); errorClassifier blast radius (McpErrorType); `.env.example` removal; `AccountMenu` consumer; reset-usage.ts is uncommitted/out of scope — all folded into §3–§9.
