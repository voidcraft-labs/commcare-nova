# Credit System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Frontend tasks (11–14) MUST load the `frontend-design` skill and build from `@/components/shadcn` (base-nova), never raw Base UI; icons from `@iconify/react/offline` (Tabler).** Tests are state-model/pure — **no RTL/jsdom UI tests** (project rule). Run each test once; a flake is a blocking bug, not a retry.

**Goal:** Replace the per-user dollar spend cap with a credit-based gate (build = 100 credits, edit = 5, reserved before each generation), tracked on a resettable ledger separate from an accumulate-only actual-cost ledger, with an audited admin reset/grant, lifetime+period visibility, a $50 invisible runaway backstop, and a migration that restores hand-blanked cost truth.

**Architecture:** Two Firestore ledgers. `usage/{userId}/months/{period}` stays the **actual-$** rollup (now accumulate-only; resets never touch it). A new `credits/{userId}/months/{period}` + append-only `credits/{userId}/grants/{id}` is the **resettable gate**. `/api/chat` charges per new user instruction (signal = last role in the **raw** `body.messages`; amount = `appReady ? 5 : 100`), reserving credits in a transaction before the SA runs and refunding on hard-failure no-op. Admin reset/grant is a transactional, audited credit mutation. MCP is out of scope (no server-side LLM cost).

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, `@google-cloud/firestore` (transactions, `FieldValue`), Zod converters, Vitest, shadcn (base-nova) + Base UI, Tailwind v4, `commander` + `tsx` for scripts.

Spec: `docs/superpowers/specs/2026-06-03-credit-system-design.md`.

---

## File Structure

**Create:**
- `lib/db/period.ts` — leaf module holding `getCurrentPeriod` (moved out of `usage.ts` to break the `usage ↔ credits` import cycle). Owns: Task 3.
- `lib/db/creditPolicy.ts` — **pure, client-safe** (type-only imports): the constants (`CREDITS_PER_BUILD` etc.) + pure helpers `creditBalance`/`chargeAmount`/`isChargeableTurn`. One source of truth for the amounts, imported by the server ledger, the gate, and the client cost indicator. Owns: Task 2. *Constants are gate/quota policy in the credit family — not `lib/models.ts` (model-keyed rates).*
- `lib/db/credits.ts` — **server** credit ledger (Firestore transactions): `reserveCredits`, `refundCredits`, `resetCredits`, `grantCredits`, `getCreditSummary`, `getCurrentCreditBalance` (single current-period doc read for the gate's fast-fail balance check), `OutOfCreditsError`. Imports `creditPolicy` + `period` + `firestore`. Owns: Tasks 3,4,7.
- `lib/db/__tests__/credits.test.ts` — pure + transactional ledger tests (Tasks 2,3,4).
- `app/api/admin/users/[id]/credits/route.ts` — first admin **write** route: POST reset/grant (Task 10).
- `app/api/admin/users/[id]/credits/__tests__/route.test.ts` — endpoint guard + transaction tests (Task 10).
- `app/(app)/admin/users/[id]/credit-controls.tsx` — client reset/grant control (shadcn AlertDialog) + audit list (Task 12).
- `scripts/inspect-credit-migration.ts` — read-only migration scan (Task 15).
- `scripts/migrate-actual-cost.ts` — dry-run-default migrator with `--apply`: `--restore-cost` (verified values), `--seed-credits` (create-only), `--delete-orphan` (guarded) (Tasks 16,17).

**Modify:**
- `lib/db/types.ts` — add `creditMonthDocSchema`/`CreditMonthDoc`, `creditGrantDocSchema`/`CreditGrantDoc` (Task 1).
- `lib/db/firestore.ts` — add `credits` + `creditGrants` collection helpers, `creditMonth`/`creditGrant` doc helpers, converters, and a raw (converter-less) credit-month ref accessor for transactions (Task 1).
- `lib/db/usage.ts` — remove `MONTHLY_SPEND_CAP_USD`; move `getCurrentPeriod` to `lib/db/period.ts` (Task 3); `UsageAccumulator` gains `didReserve`/`reservedAmount`/`chargePeriod` seed fields, a `markRunFailed()` method, and the refund branch in `flush()` (Task 5). `getMonthlyUsage` stays (backstop reads it).
- `components/chat/ChatContainer.tsx` — `onData` gains a `data-credit-refund` case → refund toast (Task 7B).
- `lib/agent/errorClassifier.ts` — `spend_cap_exceeded` → `out_of_credits` in `AgentErrorType` + `MESSAGES` (Task 6).
- `app/api/chat/route.ts` — replace the dollar-cap block with the credit gate; reserve after pre-stream rejections; thread reservation into the accumulator (Task 7).
- `app/api/user/usage/route.ts` — return the credit shape (balance/allowance/consumed + lifetime) (Task 8).
- `lib/admin/types.ts` — `AdminUserRow`, `AdminStats`, `UsagePeriod`, `AdminUserDetailResponse` gain credit + lifetime fields + grants audit (Task 9).
- `lib/db/admin.ts` — read credits; compute lifetime credits + lifetime cost; fetch grants audit (Task 9).
- `app/(app)/admin/user-table.tsx` — credit + lifetime columns (Task 11).
- `app/(app)/admin/users/[id]/user-usage.tsx` — credit columns + totals row (Task 12).
- `app/(app)/admin/users/[id]/page.tsx` — mount `credit-controls.tsx` (Task 12).
- `app/(app)/admin/admin-content.tsx` — headline fleet-credits stat (Task 13).
- `components/ui/AccountMenu.tsx` — credits-remaining bar instead of dollars (Task 14).
- The chat composer/send-button component under `components/chat/` — cost chip + hover tooltip showing the next action's credit cost (Task 14B). A shared `useCreditBalance` hook (extracted if not already present) feeds both it and `AccountMenu` from one fetch.
- `.env.example` — remove the `MONTHLY_SPEND_CAP_USD` usage-tracking block (Task 18).
- `lib/db/CLAUDE.md`, root `CLAUDE.md` — two-ledger model + invariant; "spend cap" → "credit gate + backstop" (Task 18).

**Verify-only (no change expected):** `app/api/chat/schema.ts` (`appReady` already present), `lib/mcp/**` (out of scope — confirm untouched).

---

## Task 1: Credit schemas + Firestore helpers

**Files:**
- Modify: `lib/db/types.ts`
- Modify: `lib/db/firestore.ts`
- Test: `lib/db/__tests__/credits.test.ts` (create; schema cases here)

- [ ] **Step 1: Write failing schema tests**

In `lib/db/__tests__/credits.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { creditGrantDocSchema, creditMonthDocSchema } from "@/lib/db/types";

describe("creditMonthDocSchema", () => {
  it("defaults consumed and bonus to 0; requires allowance to be present on existing docs", () => {
    const parsed = creditMonthDocSchema.parse({ allowance: 2000 });
    expect(parsed).toMatchObject({ allowance: 2000, consumed: 0, bonus: 0 });
  });
  it("rejects a negative consumed", () => {
    expect(() => creditMonthDocSchema.parse({ allowance: 2000, consumed: -1 })).toThrow();
  });
});

describe("creditGrantDocSchema", () => {
  it("accepts a reset grant row", () => {
    const row = creditGrantDocSchema.parse({
      amount: 0, type: "reset", actor: "admin1", actor_email: "a@dimagi.com",
      reason: null, period: "2026-06",
    });
    expect(row.type).toBe("reset");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`creditMonthDocSchema` not exported)

Run: `npx vitest run lib/db/__tests__/credits.test.ts`
Expected: FAIL — `creditMonthDocSchema is not a function` / import error.

- [ ] **Step 3: Add schemas to `lib/db/types.ts`**

Add near `usageDocSchema` (use the existing `timestamp` helper already in this file):
```ts
/**
 * Monthly per-user credit balance — the resettable gate ledger, parallel to
 * the usage doc but on a different collection so resets never touch cost.
 * Balance = allowance + bonus - consumed. `allowance` is always written
 * explicitly (the reservation seeds it in-transaction; a Zod default would
 * couple this schema to the credits-constant module), so it has no default;
 * an absent credit doc is treated as a full balance in code, never parsed here.
 */
export const creditMonthDocSchema = z.object({
  /** Monthly grant, written explicitly on first reservation of the period. */
  allowance: z.number().nonnegative(),
  /** Credits debited this period (sum of build/edit charges). */
  consumed: z.number().nonnegative().default(0),
  /** Additive admin grants (comps) applied to this period. */
  bonus: z.number().nonnegative().default(0),
  updated_at: timestamp,
});
export type CreditMonthDoc = z.infer<typeof creditMonthDocSchema>;

/**
 * Append-only audit row for an admin credit intervention. Records who/when so
 * a comp is traceable — the universal guardrail across Stripe/Orb/Metronome.
 * Never mutates the usage (cost) ledger.
 */
export const creditGrantDocSchema = z.object({
  /** Credits added (grant) — informational for a reset (which zeroes consumed). */
  amount: z.number(),
  type: z.enum(["reset", "grant"]),
  /** Admin userId who performed the action. */
  actor: z.string(),
  /** Denormalized admin email for the audit display. */
  actor_email: z.string(),
  reason: z.string().nullable().default(null),
  /** The yyyy-mm period affected. */
  period: z.string(),
  created_at: timestamp,
});
export type CreditGrantDoc = z.infer<typeof creditGrantDocSchema>;
```
*(If `timestamp` allows server-sentinel-on-write but ISO/Timestamp-on-read like the other docs in this file, follow that exact pattern — match `usageDocSchema.updated_at`. The grant test above omits `created_at`; if `timestamp` is required-on-read, give the test `created_at` a Timestamp-like stub as the other doc tests in this repo do, or make `created_at` `.optional()` mirroring how run/usage timestamps are handled. Match the existing convention exactly.)*

- [ ] **Step 4: Add Firestore helpers to `lib/db/firestore.ts`**

Import the new schemas/types, add converters, and extend `collections` + `docs`. Mirror the `usage` helper exactly:
```ts
// in the imports block from "./types":
import {
  type CreditGrantDoc, creditGrantDocSchema,
  type CreditMonthDoc, creditMonthDocSchema,
  /* ...existing... */
} from "./types";

const creditMonthConverter = zodConverter(creditMonthDocSchema);
const creditGrantConverter = zodConverter(creditGrantDocSchema);

// in `collections`:
/** Per-user monthly credit balance: `credits/{userId}/months/{yyyy-mm}` */
creditMonths: (userId: string): CollectionReference<CreditMonthDoc> =>
  getDb().collection("credits").doc(userId).collection("months").withConverter(creditMonthConverter),
/** Per-user append-only credit audit: `credits/{userId}/grants/{id}` */
creditGrants: (userId: string): CollectionReference<CreditGrantDoc> =>
  getDb().collection("credits").doc(userId).collection("grants").withConverter(creditGrantConverter),

// in `docs`:
/** Direct ref: `credits/{userId}/months/{yyyy-mm}` (converter-applied, for reads). */
creditMonth: (userId: string, period: string): DocumentReference<CreditMonthDoc> =>
  collections.creditMonths(userId).doc(period),
/**
 * RAW (converter-less) ref to the credit-month doc, for transactions.
 * A `withConverter` `tx.get()` routes through `schema.parse` and would throw on
 * a partially-initialized existing doc inside the transaction (same hazard the
 * run-summary writer documents); the reservation reads/writes raw data and
 * supplies defaults in code. Composes off the single-sourced `collections`
 * path via `withConverter(null)` (which yields the identical untyped
 * `DocumentReference<DocumentData>`) rather than re-hardcoding the path chain.
 */
creditMonthRaw: (userId: string, period: string): DocumentReference =>
  collections.creditMonths(userId).doc(period).withConverter(null),
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run lib/db/__tests__/credits.test.ts`
Expected: PASS (3 tests). Also run `npx tsc --noEmit` — expect no new errors.

- [ ] **Step 6: Commit**
```bash
git add lib/db/types.ts lib/db/firestore.ts lib/db/__tests__/credits.test.ts
git commit -m "feat(credits): credit-month + grant schemas and Firestore helpers"
```

---

## Task 2: Credit policy — constants + pure helpers (client-safe)

**Files:**
- Create: `lib/db/creditPolicy.ts` — **pure, dependency-free** (only `import type`): the constants + `creditBalance`/`chargeAmount`/`isChargeableTurn`. Imported by the server ledger (Task 3), the gate (Task 7), AND the client cost indicator (Task 14B) — one source of truth, no Firestore, so it bundles safely client-side.
- Test: `lib/db/__tests__/credits.test.ts` (append)

- [ ] **Step 1: Write failing tests** (append to `credits.test.ts`)
```ts
import {
  ACTUAL_COST_BACKSTOP_USD, CREDITS_PER_BUILD, CREDITS_PER_EDIT,
  MONTHLY_CREDIT_ALLOWANCE, chargeAmount, creditBalance, isChargeableTurn,
} from "@/lib/db/creditPolicy";
import type { UIMessage } from "ai";

const u = (role: "user" | "assistant"): UIMessage =>
  ({ id: "m", role, parts: [{ type: "text", text: "x" }] }) as UIMessage;

describe("pure credit helpers", () => {
  it("constants are the locked values", () => {
    expect([CREDITS_PER_BUILD, CREDITS_PER_EDIT, MONTHLY_CREDIT_ALLOWANCE, ACTUAL_COST_BACKSTOP_USD])
      .toEqual([100, 5, 2000, 50]);
  });
  it("creditBalance = allowance + bonus - consumed", () => {
    expect(creditBalance({ allowance: 2000, consumed: 105, bonus: 0 })).toBe(1895);
    expect(creditBalance(undefined)).toBe(MONTHLY_CREDIT_ALLOWANCE); // absent doc = full
  });
  it("chargeAmount: build vs edit by appReady", () => {
    expect(chargeAmount(false)).toBe(100);
    expect(chargeAmount(true)).toBe(5);
  });
  it("isChargeableTurn: last RAW message role user = charge; assistant = free", () => {
    expect(isChargeableTurn([u("assistant"), u("user")])).toBe(true);
    expect(isChargeableTurn([u("user"), u("assistant")])).toBe(false); // answered-askQuestions auto-resend
    expect(isChargeableTurn([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).
Run: `npx vitest run lib/db/__tests__/credits.test.ts`

- [ ] **Step 3: Create `lib/db/creditPolicy.ts` (pure constants + helpers — NO Firestore import)**
```ts
/**
 * Credit policy — the constants and pure cost rules for the credit gate.
 * Dependency-free (type-only imports) so it is safe in the client bundle: the
 * server ledger (credits.ts), the chat gate, and the send-button cost indicator
 * all read the amounts from here. Constants are gate/quota policy, kept in the
 * credit family — not in the model-config file (which holds model-keyed rates).
 */
import type { UIMessage } from "ai";
import type { CreditMonthDoc } from "./types";

/** 1 credit = $0.01 — the lightly-visible conversion anchor for $ hints. */
export const CREDITS_PER_DOLLAR = 100;
/** A new-app generation. */
export const CREDITS_PER_BUILD = 100;
/** An edit to an existing app — cheap so iterating feels nearly free. */
export const CREDITS_PER_EDIT = 5;
/** Monthly grant; resets each calendar month (no rollover). */
export const MONTHLY_CREDIT_ALLOWANCE = 2000;
/** Invisible per-user monthly actual-$ runaway guard. */
export const ACTUAL_COST_BACKSTOP_USD = 50;

/** Spendable balance for a period. An absent doc reads as a full allowance. */
export function creditBalance(doc: Pick<CreditMonthDoc, "allowance" | "consumed" | "bonus"> | undefined): number {
  if (!doc) return MONTHLY_CREDIT_ALLOWANCE;
  return doc.allowance + doc.bonus - doc.consumed;
}

/** Credit cost of a chargeable turn: edits are cheap, builds are the unit. */
export function chargeAmount(appReady: boolean): number {
  return appReady ? CREDITS_PER_EDIT : CREDITS_PER_BUILD;
}

/**
 * Is this POST a new user-initiated generation (charge) or a free continuation?
 * MUST be passed the RAW incoming messages (before the route's last-user-message-only
 * cache-expiry transform): a fresh instruction appends a `user` message; an
 * answered-askQuestions auto-resend ends with an `assistant` message.
 */
export function isChargeableTurn(rawMessages: readonly UIMessage[]): boolean {
  const last = rawMessages.at(-1);
  return last?.role === "user";
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run lib/db/__tests__/credits.test.ts`
- [ ] **Step 5: Commit**
```bash
git add lib/db/creditPolicy.ts lib/db/__tests__/credits.test.ts
git commit -m "feat(credits): pure credit policy — constants + balance/charge/turn helpers"
```

---

## Task 3: `reserveCredits` transaction

**Files:** Create `lib/db/period.ts`, `lib/db/__tests__/credits.integration.test.ts`; Modify `lib/db/credits.ts`, `lib/db/usage.ts` + importers of `getCurrentPeriod`; Test `lib/db/__tests__/credits.test.ts`.

> **First, break the import cycle:** extract `getCurrentPeriod` (currently in `lib/db/usage.ts`) into a tiny leaf `lib/db/period.ts` (no imports back into `usage`/`credits`). Update every importer (`lib/db/usage.ts` itself, `lib/db/admin.ts`, and any script) to import it from `./period`. This lets `credits.ts` use it AND lets `usage.ts` import `refundCredits` from `credits.ts` (Task 5) without a runtime cycle. Run `npx tsc --noEmit` after the move — expect clean.

The reservation is a `runTransaction` over the **raw** ref (Task 1's `docs.creditMonthRaw`): read current data (or defaults if missing), reject if balance < cost, else write the seeded doc with `consumed += cost`. Throws a typed `OutOfCreditsError` the route maps to 429.

> **Test strategy (this repo's split — confirmed by reading the suite + landed in Task 3):** the `lib/db` UNIT suites MOCK Firestore (`vi.mock("../firestore")` with a hoisted `runTransactionMock` driving the closure — see `lib/db/__tests__/runSummary.test.ts`). Real round-trips run in a `*.integration.test.ts` against a real Firestore emulator, auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset (see `api-keys.integration.test.ts`; `npm run test:integration`).
>
> **The concurrency race is NOT emulator-tested (empirically determined in Task 3, ratified):** both production's server SDK (`@google-cloud/firestore`, Standard edition) and the emulator use **pessimistic** transaction concurrency (read locks) — they are faithful in kind. The difference that matters: the **emulator's lock manager LIVELOCKS** two contending single-doc transactions (each holds a read lock awaiting the other's write lock → lock-timeout → ~30s hang, confirmed in `firestore-debug.log`), whereas **production cleanly ABORTS** the losing transaction on contention ("Too much contention") and the SDK auto-retries it — the retry re-reads the now-depleted balance and rejects with `OutOfCreditsError`. So a real concurrent-race test can't resolve on the emulator (it hangs), and there is **no integration CI** (no `.github/workflows`/cloudbuild) — no real-Firestore target would ever run it. The race-safety contract is therefore proven **deterministically in the UNIT suite by driving the real `reserveCredits` closure twice** (the retried closure re-reads a depleted balance and rejects — the read-then-reject path that makes the abort-and-retry safe; mirrors `runSummary.test.ts`'s retry test). This is NOT the forbidden tautological hand-mocked race (which scripts two fake outcomes); it runs the real closure against scripted sequential state. Task 7's cross-app gate race inherits this same guarantee from `reserveCredits` — no separate race test there.

- [ ] **Step 1a: UNIT tests** in `lib/db/__tests__/credits.test.ts`, mirroring `runSummary.test.ts`'s mock surface (hoisted `txGet`/`txSet`/`runTransactionMock`, `vi.mock("../firestore")`), driving the real `reserveCredits` closure:
```ts
// reserveCredits(userId, cost) — script tx.get to return the doc snapshot:
//  - snap missing (exists=false): tx.set called with {allowance:2000, consumed:cost, bonus:0, updated_at}; returns {period, reserved:cost}
//  - snap exists, balance (allowance+bonus-consumed) >= cost: tx.set called with consumed incremented by cost (allowance/bonus preserved)
//  - exact-balance boundary (balance === cost): succeeds
//  - snap exists, balance < cost: throws OutOfCreditsError; tx.set NOT called
//  - OutOfCreditsError shape (name + human-readable message)
//  - CONCURRENCY CONTRACT (deterministic): drive the closure twice — attempt 1 affordable (succeeds), attempt 2 re-reads the now-depleted balance and rejects with OutOfCreditsError. Proves the read-then-reject path that makes Firestore's optimistic retry safe.
//  - returned period === getCurrentPeriod(), reserved === cost
```
- [ ] **Step 1b: INTEGRATION test** in `lib/db/__tests__/credits.integration.test.ts`, mirroring `api-keys.integration.test.ts`'s `FIRESTORE_EMULATOR_HOST` auto-skip header — real round-trips ONLY (no race):
```ts
//  - reserveCredits on a fresh user actually creates credits/{u}/months/{period} with consumed=cost
//  - a second reserve decrements further; reserve at balance < cost throws and leaves the doc unchanged
```
Run via `npm run test:integration` if the emulator is available (it boots a Java Firestore emulator); else it auto-skips — report which. Confirm the file mirrors `api-keys.integration.test.ts` structurally.

- [ ] **Step 2: Run — expect FAIL** (unit suite; `npx vitest run lib/db/__tests__/credits.test.ts`).

- [ ] **Step 3: Implement in `lib/db/credits.ts`**
```ts
// lib/db/credits.ts — SERVER credit ledger (Firestore transactions). Pure
// constants/helpers live in ./creditPolicy (client-safe); IO lives here.
import { FieldValue } from "@google-cloud/firestore";
import { MONTHLY_CREDIT_ALLOWANCE } from "./creditPolicy";
import { docs } from "./firestore";
import { getCurrentPeriod } from "./period"; // leaf created in this task's note

/** Thrown by reserveCredits when the user can't afford the charge. The route maps it to 429. */
export class OutOfCreditsError extends Error {
  constructor() {
    super("Out of credits for this period");
    this.name = "OutOfCreditsError";
  }
}

export interface Reservation {
  /** Period the charge was booked against — threaded to the refund so a post-midnight refund hits the right month. */
  period: string;
  /** Credits reserved (5 or 100) — refunded verbatim on a no-op. */
  reserved: number;
}

/**
 * Reserve `cost` credits for the current period before a generation runs.
 * Raw-ref transaction (no converter — avoids parse-on-read throwing inside the tx
 * on a partially-initialized doc). Seeds a missing doc with the full allowance.
 */
export async function reserveCredits(userId: string, cost: number): Promise<Reservation> {
  const period = getCurrentPeriod();
  const ref = docs.creditMonthRaw(userId, period);
  await ref.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() as Partial<CreditMonthDoc>) : undefined;
    const allowance = data?.allowance ?? MONTHLY_CREDIT_ALLOWANCE;
    const consumed = data?.consumed ?? 0;
    const bonus = data?.bonus ?? 0;
    if (allowance + bonus - consumed < cost) throw new OutOfCreditsError();
    // Write explicit allowance/bonus so a missing doc is fully seeded; increment consumed.
    tx.set(ref, { allowance, bonus, consumed: consumed + cost, updated_at: FieldValue.serverTimestamp() }, { merge: true });
  });
  return { period, reserved: cost };
}
```

- [ ] **Step 4: Run — expect PASS** (unit suite green; integration suite passes if the emulator is up, else auto-skips — report which).
- [ ] **Step 5: Commit**
```bash
git add lib/db/period.ts lib/db/credits.ts lib/db/usage.ts lib/db/__tests__/credits.test.ts lib/db/__tests__/credits.integration.test.ts
# (+ any getCurrentPeriod importer you updated, e.g. lib/db/admin.ts)
git commit -m "feat(credits): transactional reserveCredits + period leaf (unit + integration tests)"
```

---

## Task 4: `refundCredits`, `resetCredits`, `grantCredits`, `getCreditSummary`

**Files:** Modify `lib/db/credits.ts`, `lib/db/__tests__/credits.test.ts`, `lib/db/__tests__/credits.integration.test.ts`.

> Same split as Task 3: UNIT (mock, `runSummary.test.ts` pattern) for logic; INTEGRATION (emulator, auto-skip) for the real atomic round-trips. Atomicity claims (both docs commit together; reset writes a complete doc) belong in the INTEGRATION suite — a mock can't prove a real transaction's all-or-nothing commit.

- [ ] **Step 1a: UNIT tests** (`credits.test.ts`, mocked) — logic:
  - `refundCredits(userId, period, amount)` — on an existing doc, `tx.set` called with `consumed` decremented by `amount` clamped at 0; on a missing doc (`exists=false`), returns without writing.
  - `resetCredits` — reads-then-seeds: `tx.set` on the month ref with `{allowance: existing ?? 2000, consumed:0, bonus: existing ?? 0}` AND a second `tx.set` on a fresh grant ref `{type:"reset", actor, actor_email, reason, period, amount:0}`. Assert BOTH `tx.set` calls happen.
  - `grantCredits` — `tx.set` on month ref with `bonus` incremented by `amount` (allowance seeded) AND a grant row `{type:"grant", amount}`.
  - `getCreditSummary` — over a scripted set of month docs: returns `{period, allowance, consumed, bonus, balance, lifetimeConsumed}`; missing current-period doc → full balance; `lifetimeConsumed` = Σ `consumed` across months.
- [ ] **Step 1b: INTEGRATION tests** (`credits.integration.test.ts`, emulator, auto-skip) — real round-trips:
  - reset/grant land BOTH the month-doc mutation and the grant audit row in ONE committed transaction (read both back). (Proves committed-together, not both-or-neither-under-failure — no failure injection.)
  - **`resetCredits` on a user with NO current-period doc writes a COMPLETE doc** (allowance present), and a subsequent `getCreditSummary` parses without throwing + returns a full balance. (Guards the no-default-`allowance` × converter-read hazard — only real Firestore + the real converter proves this.)
  - **`grantCredits` on a user with NO current-period doc** writes `{allowance, bonus}` with `consumed` landing only via `creditMonthDocSchema.consumed`'s `.default(0)` (grant never writes consumed), and `getCreditSummary` parses + reports `balance === MONTHLY_CREDIT_ALLOWANCE + amount`. (Pins the grant path's converter-safety so a future removal of `consumed`'s default breaks this test.)
  - `refundCredits` round-trip decrements then a re-read reflects it.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (append to `lib/db/credits.ts`)
```ts
import { collections } from "./firestore";

/** Return a no-op run's reservation. Clamps consumed at 0 (never negative). */
export async function refundCredits(userId: string, period: string, amount: number): Promise<void> {
  const ref = docs.creditMonthRaw(userId, period);
  await ref.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return; // nothing to refund
    const consumed = (snap.data() as Partial<CreditMonthDoc>).consumed ?? 0;
    tx.set(ref, { consumed: Math.max(0, consumed - amount), updated_at: FieldValue.serverTimestamp() }, { merge: true });
  });
}

interface AdminActor { actor: string; actorEmail: string; reason: string | null; }

/** Reset: zero this period's consumed + append an audit row, atomically. */
export async function resetCredits(userId: string, who: AdminActor): Promise<void> {
  const period = getCurrentPeriod();
  const monthRef = docs.creditMonthRaw(userId, period);
  const grantRef = collections.creditGrants(userId).doc();
  await monthRef.firestore.runTransaction(async (tx) => {
    // Read-then-seed: a reset on a user with no current-period doc must still
    // write a COMPLETE doc (allowance present). allowance has no Zod default by
    // design, so a partial {consumed} merge would make the next converter-applied
    // read (getCreditSummary / admin dashboard) throw on parse. Seed allowance,
    // preserve any prior bonus, zero consumed.
    const snap = await tx.get(monthRef);
    const data = snap.exists ? (snap.data() as Partial<CreditMonthDoc>) : undefined;
    tx.set(
      monthRef,
      {
        allowance: data?.allowance ?? MONTHLY_CREDIT_ALLOWANCE,
        consumed: 0,
        bonus: data?.bonus ?? 0,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(grantRef, {
      amount: 0, type: "reset", actor: who.actor, actor_email: who.actorEmail,
      reason: who.reason, period, created_at: FieldValue.serverTimestamp(),
    });
  });
}

/** Grant: add bonus credits to this period + append an audit row, atomically. */
export async function grantCredits(userId: string, amount: number, who: AdminActor): Promise<void> {
  const period = getCurrentPeriod();
  const monthRef = docs.creditMonthRaw(userId, period);
  const grantRef = collections.creditGrants(userId).doc();
  await monthRef.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(monthRef);
    const data = snap.exists ? (snap.data() as Partial<CreditMonthDoc>) : undefined;
    tx.set(monthRef, {
      allowance: data?.allowance ?? MONTHLY_CREDIT_ALLOWANCE,
      bonus: (data?.bonus ?? 0) + amount,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(grantRef, {
      amount, type: "grant", actor: who.actor, actor_email: who.actorEmail,
      reason: who.reason, period, created_at: FieldValue.serverTimestamp(),
    });
  });
}

export interface CreditSummary {
  period: string; allowance: number; consumed: number; bonus: number; balance: number; lifetimeConsumed: number;
}

/** Read a user's current balance + lifetime credits consumed (Σ consumed over all months). */
export async function getCreditSummary(userId: string): Promise<CreditSummary> {
  const period = getCurrentPeriod();
  const monthsSnap = await collections.creditMonths(userId).get();
  let lifetimeConsumed = 0;
  let current: CreditMonthDoc | undefined;
  for (const d of monthsSnap.docs) {
    const data = d.data();
    lifetimeConsumed += data.consumed;
    if (d.id === period) current = data;
  }
  const allowance = current?.allowance ?? MONTHLY_CREDIT_ALLOWANCE;
  const consumed = current?.consumed ?? 0;
  const bonus = current?.bonus ?? 0;
  return { period, allowance, consumed, bonus, balance: allowance + bonus - consumed, lifetimeConsumed };
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit**
```bash
git add lib/db/credits.ts lib/db/__tests__/credits.test.ts
git commit -m "feat(credits): refund, reset/grant (atomic + audit), getCreditSummary"
```

---

## Task 5: UsageAccumulator carries the reservation + refunds on no-op

**Files:** Modify `lib/db/usage.ts`; Test: the existing `lib/db/__tests__/usage-accumulator.test.ts`.

The accumulator's `flush()` already branches on `costEstimate > 0` for the usage increment. Add reservation fields to the seed and a refund in the `else` (zero-cost) path, gated on `didReserve`, refunding `reservedAmount` against `chargePeriod`.

- [ ] **Step 1: Write failing tests** (append to `usage-accumulator.test.ts`, follow its existing fixture/seed pattern; spy/mock `refundCredits` + `incrementUsage`):
  - `didReserve:true, reservedAmount:100, chargePeriod:"2026-06"`, zero cost → `flush()` calls `refundCredits("u","2026-06",100)` once, no `incrementUsage`.
  - Same seed, **cost > 0, no failure** → `incrementUsage` called, **no** refund (normal charge).
  - Same seed, **cost > 0 AND `markRunFailed()` called** → **BOTH** `incrementUsage` (cost still accrues) AND `refundCredits(...,100)` (failed run refunds).
  - `didReserve:false`, failed, zero cost → **no** refund (a free continuation never refunds).
  - `flush()` twice → refund at most once (`_finalized` guard).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — extend `AccumulatorSeed` with optional `didReserve?: boolean; reservedAmount?: number; chargePeriod?: string;`; add a private `_runFailed = false` field and a `markRunFailed(): void { this._runFailed = true; }` method (no-op safe after flush). In `flush()`, replace the single `if (summary.costEstimate > 0) { ...increment... }` with **two independent branches** (a failed run with cost>0 must do both):
```ts
// 1) Actual cost always accrues when the SA ran — failed runs included, so the
//    $50 backstop still sees retry-spam.
if (summary.costEstimate > 0) {
  try { await incrementUsage(this.seed.userId, { /* unchanged token/cost deltas */ }); }
  catch (err) { log.error("[UsageAccumulator] monthly increment failed", err, { userId: this.seed.userId }); }
}
// 2) Refund the reservation if the run FAILED (broke the app) or did no billable
//    work. Refund to the period booked at reservation (not getCurrentPeriod() — a
//    post-midnight flush would hit the wrong month). didReserve gates it so a free
//    continuation (never reserved) can never phantom-refund.
if (this.seed.didReserve && this.seed.reservedAmount && this.seed.chargePeriod &&
    (this._runFailed || summary.costEstimate === 0)) {
  try { await refundCredits(this.seed.userId, this.seed.chargePeriod, this.seed.reservedAmount); }
  catch (err) { log.error("[UsageAccumulator] credit refund failed", err, { userId: this.seed.userId }); }
}
```
Import `refundCredits` from `./credits`. The import cycle was already broken in Task 3 (`getCurrentPeriod` lives in the leaf `lib/db/period.ts`), so `usage.ts → credits.ts` is one-directional now. Verify with `tsc` + a runtime smoke (neither module `undefined` at import).

- [ ] **Step 4: Run — expect PASS.** Also `npx tsc --noEmit`.
- [ ] **Step 5: Commit**
```bash
git add lib/db/usage.ts lib/db/__tests__/usage-accumulator.test.ts lib/db/credits.ts
git commit -m "feat(credits): accumulator refunds the reservation on a no-op run"
```

---

## Task 6: Error taxonomy rename `spend_cap_exceeded` → `out_of_credits`

**Files:** Modify `lib/agent/errorClassifier.ts`; Test: its existing test if present, else add a case.

- [ ] **Step 1:** In `lib/agent/errorClassifier.ts`, rename the `spend_cap_exceeded` member of the `AgentErrorType` union to `out_of_credits` and update its `MESSAGES` entry to: `"You're out of credits for this month — they refresh on the 1st."` Because the union is closed, `tsc` will surface EVERY consumer — fix ALL of them in THIS commit so the build stays green (this task must leave `tsc` clean on its own): the existing `spend_cap_exceeded` references in `app/api/chat/route.ts` (the current dollar-cap block's `MESSAGES.spend_cap_exceeded` + `type: "spend_cap_exceeded"`) become `out_of_credits` — a mechanical rename only; Task 7 later REPLACES that whole block with the real credit gate, so the transient "out_of_credits message on a still-dollar-cap check" lives only between this commit and Task 7's (never shipped). Also fix `errorClassifier`'s own `MESSAGES`, any `errorClassifier` test referencing the old literal, and confirm `McpErrorType` (which inherits the union) compiles. Grep `spend_cap_exceeded` across the repo → zero matches after this task.
- [ ] **Step 2:** Run `npx tsc --noEmit` — expect errors ONLY at the chat route (fixed in Task 7) and any test referencing the old literal; fix the test literal here.
- [ ] **Step 3:** Run `npx vitest run lib/agent` — expect PASS.
- [ ] **Step 4: Commit**
```bash
git add lib/agent/errorClassifier.ts
git commit -m "refactor(credits): rename spend_cap_exceeded -> out_of_credits error type"
```

---

## Task 7: Wire the credit gate into `/api/chat`

**Files:** Modify `app/api/chat/route.ts`; Test: extract gate decision into a pure helper and test that (no route/RTL test).

**Design recap (spec §6):** (1) compute `chargeable`/`cost` from RAW `body.messages` + `body.appReady`; (2) fast-fail read at the top (backstop on every POST; balance on chargeable POSTs via `getCurrentCreditBalance`) — fail-closed → 503; (3) resolve appId/ownership/concurrency; (4) **reserve** (chargeable only) after all those rejection points; (5) thread `didReserve/reservedAmount/chargePeriod` into the accumulator.

**Abort-finalization invariant (landed; found in review — see Step 5 abort wiring):** a client disconnect must NOT refund a real in-flight run NOR erase its actual-$ cost. The model call is cancelled by threading `abortSignal: req.signal` into the stream, but already-streamed steps still accrue cost. So: the execute `finally`'s `usage.flush()` is the **sole authoritative** charge-vs-refund decision (it runs once the stream reaches its true final state); the `req.signal` abort listener flushes **only the log writer**, never the accumulator (a mid-flight snapshot has `costEstimate === 0`, which would refund-and-erase a real run); and `handleRouteError` **short-circuits on `req.signal.aborted`** so a disconnect is never treated as a generation failure (no `markRunFailed`/`failApp`/refund-toast). On a genuine abort the `finally` flush decides purely on the final `costEstimate` (0 steps → refund, ≥1 step → keep the charge).

- [ ] **Step 1: Write a failing pure-helper test.** Create `app/api/chat/__tests__/creditGate.test.ts`. The helper `creditGateDecision({ rawMessages, appReady })` returns `{ chargeable: boolean; cost: number }`:
```ts
import { creditGateDecision } from "../creditGate";
// last raw msg user + appReady false  -> { chargeable:true, cost:100 }
// last raw msg user + appReady true   -> { chargeable:true, cost:5 }
// last raw msg assistant              -> { chargeable:false, cost:0 }
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create `app/api/chat/creditGate.ts`**
```ts
import type { UIMessage } from "ai";
import { chargeAmount, isChargeableTurn } from "@/lib/db/creditPolicy";

/** Pure charge decision from the RAW request (before any message-strategy transform). */
export function creditGateDecision(input: { rawMessages: readonly UIMessage[]; appReady: boolean }): {
  chargeable: boolean; cost: number;
} {
  const chargeable = isChargeableTurn(input.rawMessages);
  return { chargeable, cost: chargeable ? chargeAmount(input.appReady) : 0 };
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Edit `app/api/chat/route.ts`** — replace the dollar-cap block (the current `getMonthlyUsage` / `MONTHLY_SPEND_CAP_USD` try/catch) with:
  - Near the top, after `parsed`: `const { chargeable, cost } = creditGateDecision({ rawMessages: messages, appReady: !!body.appReady });` (uses RAW `messages` from `body`, before any transform).
  - **Fast-fail read** (replacing the old cap block, fail-closed → 503 with `type: "internal"`): read `getMonthlyUsage(userId)` for the backstop (`cost_estimate >= ACTUAL_COST_BACKSTOP_USD` → 429, `type: "out_of_credits"`, message "You've reached your monthly usage limit. It resets on the 1st." — never leaks "$50") and, if `chargeable`, `getCurrentCreditBalance(userId)` — a single current-period doc read, lighter than `getCreditSummary` since the gate only needs the scalar balance — (`balance < cost` → 429 `out_of_credits`, `type: "out_of_credits"`, message `MESSAGES.out_of_credits`).
  - **Reserve** after `appId`/ownership/`hasActiveGeneration` resolution and before constructing the accumulator: if `chargeable`, `const reservation = await reserveCredits(userId, cost);` wrapped so `OutOfCreditsError` → `failApp` (if a build app was created) + 429 `out_of_credits`, and any other error → fail-closed 503 (never silently skip the charge).
  - Pass into `new UsageAccumulator({ ... })`: `didReserve: chargeable, reservedAmount: chargeable ? cost : undefined, chargePeriod: reservation?.period`.
  - **Refund-on-failure hook:** inside `handleRouteError` (the single failure funnel that already classifies + calls `failApp`), add `usage.markRunFailed();` and — once, only when `chargeable` — emit the refund signal so the client can toast. The funnel **short-circuits on `req.signal.aborted`** (a client disconnect is not a generation failure — see the abort-finalization invariant above):
```ts
let refundSignalled = false;
const handleRouteError = (error: unknown, source: string): void => {
  // A client disconnect ends the stream cleanly, but the reader can still throw
  // when writer.write hits the torn-down stream and land us here. On a true abort
  // we must NOT mark failed / fail the app / refund-toast — the finally's flush()
  // is the sole arbiter of charge-vs-refund for an abort (decides on costEstimate).
  if (req.signal.aborted) return;
  const classified = classifyError(error);
  ctx.emitError(classified, source);
  failApp(appId, classified.type);
  usage.markRunFailed();              // flush() will refund the reservation
  if (chargeable && !refundSignalled) {
    refundSignalled = true;
    writer.write({ type: "data-credit-refund", data: { amount: cost }, transient: true });
  }
};
```
  - **Abort wiring (the anti-abuse fix):** thread `abortSignal: req.signal` into `createAgentUIStream` so a disconnect cancels the model call. The execute `finally` is the **sole authoritative** `await usage.flush()` (`onFinish` keeps a fire-and-forget fallback `void usage.flush()`; both idempotent). The `req.signal` `"abort"` listener flushes **only `logWriter`**, never `usage` — flushing a mid-flight accumulator (`costEstimate === 0`) would refund the reservation AND no-op the real flush, finalizing a cost-accruing run as a free refunded build.
  - Guard `ctx.emitConversation(...)` (the user-message echo) in a try/catch so an emit throw can't escape the stream scope and skip the `finally` (which would leak the reservation).
  - Remove the now-unused `MONTHLY_SPEND_CAP_USD` import; keep `getMonthlyUsage`. Add `getCurrentCreditBalance` + `reserveCredits` + `ACTUAL_COST_BACKSTOP_USD` imports.

- [ ] **Step 6: Verify** — `npx tsc --noEmit` (no errors), `npx vitest run app/api/chat` + `npx vitest run lib/db` (PASS). Manual reasoning check against spec §6 ordering: enumerate every `return`/throw after the reservation line and confirm each is inside the stream scope (so `flush()` refunds) — there should be none before the stream.

- [ ] **Step 7: Commit**
```bash
git add app/api/chat/route.ts app/api/chat/creditGate.ts app/api/chat/__tests__/creditGate.test.ts \
        lib/db/credits.ts lib/db/__tests__/credits.test.ts
git commit -m "feat(credits): credit gate replaces dollar cap in /api/chat"
```
*(Landed at `21664bb6`. The `getCurrentCreditBalance` helper + its unit test landed in `lib/db` as part of this task — the fast-fail balance read needed a single-doc scalar read, lighter than `getCreditSummary`.)*

---

## Task 7B: Refund toast on the chat surface

**Files:** Modify `components/chat/ChatContainer.tsx`. *(No test — UI; verified in Final Verification. Pure-state extraction not warranted for a single toast dispatch.)*

- [ ] **Step 1:** Nova's toast API is the imperative singleton `showToast(severity, title, message?)` from `@/lib/ui/toastStore` (`severity: "error" | "warning" | "info"`), rendered by `ToastContainer`. The existing `onData` handler in `ChatContainer.tsx::useNovaChat` already switches on `type` for `data-run-id` / `data-app-id` (each `return`s after handling its part) before falling through to `applyStreamEvent`.
- [ ] **Step 2:** Add a `data-credit-refund` case to `onData`, placed with the other early-return cases (it must `return` so the refund part never reaches `applyStreamEvent`). The part is `transient` (server-side `transient: true`) so it fires `onData` but never persists to message history — handling it here is correct:
```ts
if (type === "data-credit-refund") {
  const amount = data.amount as number;
  // Reassurance, not an error — the failure itself is surfaced separately as
  // the generation-error toast (a data-conversation-event with an error
  // payload). Use "info" (neutral, auto-dismissing); the error toast is the
  // one that persists. The refund is server-authoritative and once-latched,
  // so this only fires once per failed run.
  showToast(
    "info",
    "You weren't charged",
    `This run hit an error, so your ${amount} credits were refunded.`,
  );
  return;
}
```
`amount` is cast directly (`data.amount as number`), matching the sibling `data-run-id` case — the part comes from our own server, which always sends a positive integer (5 or 100) only on chargeable runs, so a `?? 0` fallback would guard an impossible input and only ever render "0 credits". `showToast` is the module-level singleton (no provider/context needed) and is already imported in `ChatContainer.tsx` (used elsewhere). The comment names the **real** failure channel: generation errors reach the client as a `data-conversation-event` with an error payload (`lib/agent/generationContext.ts::emitError` → `emitConversation`), not a (non-existent) `data-error` part.
- [ ] **Step 3:** `npx tsc --noEmit` (clean) + `npx biome check components/chat/ChatContainer.tsx`. **Commit** `git commit -am "feat(credits): toast the user when a failed run is refunded"`

---

## Task 8: User-facing usage endpoint returns credits

**Files:** Modify `app/api/user/usage/route.ts`.

- [ ] **Step 1:** Change the GET handler to return the full `CreditSummary` from `getCreditSummary(session.user.id)` — `{ period, allowance, consumed, bonus, balance, lifetimeConsumed }` (its JSDoc: "the shape the user-facing usage endpoint and the admin dashboard both render"). Drop the old `{ cost_estimate, request_count, cap }` dollar shape and the now-unused `getMonthlyUsage` + `MONTHLY_SPEND_CAP_USD` + `getCurrentPeriod` imports (`getCreditSummary` carries `period` itself). Keep the `requireSession` + `handleApiError` pattern unchanged. Refresh the file's top JSDoc to describe the credit shape, not "cost estimate, request count, spend cap".
- [ ] **Step 2: No new route test.** This route is a thin serialization shim (`requireSession → getCreditSummary → Response.json`) with no branching logic; its logic lives in `getCreditSummary`, already unit-tested in Task 4. The repo's own convention is to test logic, not serialization shims (see `app/api/mcp/__tests__/route.test.ts`'s rationale for not testing its 5-line shim). There is no existing test of this route to update.
- [ ] **Step 3:** `npx tsc --noEmit` (clean — note: the `AccountMenu.tsx` consumer casts the fetch to its own local `UsageData` type, so reshaping the JSON does NOT break tsc; it drifts at runtime until Task 14 re-anchors AccountMenu to the credit shape — expected, sequenced). `npx vitest run lib/db` (the `getCreditSummary` tests still pass).
- [ ] **Step 4: Commit** `git commit -am "feat(credits): /api/user/usage returns credit balance"`

---

## Task 9: Admin data layer — credits + lifetime + audit

**Files:** Modify `lib/admin/types.ts`, `lib/db/admin.ts`.

- [ ] **Step 1:** Extend `lib/admin/types.ts` (type-only `import type { CreditSummary } from "@/lib/db/credits";` — consistent with the existing `AppSummary` type-import):
  - `AdminUserRow` += `credits_used: number; credits_remaining: number; credits_allowance: number; credits_used_lifetime: number; cost_lifetime: number;`. Keep `cost` (this-month actual $) but relabel its doc-comment to "this month's true dollar cost — tracked for tuning/backstop, no longer the user-facing gate".
  - `AdminStats` += `totalCreditsConsumed: number;` (current-period sum, matching the period scope of `totalGenerations`/`totalSpend`).
  - `UsagePeriod` += `credits_consumed?: number; credits_bonus?: number;` (optional — a usage period may predate the credit system or lack a credit doc).
  - Add a named, exported `CreditGrantAudit` interface — `{ amount: number; type: "reset" | "grant"; actor_email: string; reason: string | null; period: string; created_at: string }` (ISO string; `actor` uid intentionally omitted — `actor_email` is the human-readable identity the audit list renders). The Task 12 detail UI imports it.
  - `AdminUserDetailResponse` += `credits: CreditSummary;` and `grants: CreditGrantAudit[];`.
- [ ] **Step 2:** In `lib/db/admin.ts` (import `getCreditSummary` + `CreditSummary` from `@/lib/db/credits`, `CreditGrantAudit` from `@/lib/admin/types`):
  - `getAdminUsersWithStats`: the lifetime figures force a full per-user subcollection read anyway, so **replace the single current-period usage `getAll`** with one parallel per-user pass (keep the existing app-count `Promise.all` shape). Per user, read in parallel: (a) `getCreditSummary(u.id)` — gives `credits_allowance`=`allowance`, `credits_used`=`consumed`, `credits_remaining`=`balance`, `credits_used_lifetime`=`lifetimeConsumed` in ONE subcollection read (don't re-implement `creditBalance` — `getCreditSummary` already applies it); (b) `collections.usage(u.id).get()` (all months) → find the current-period doc for `generations`+`cost` (this month) and Σ `cost_estimate` across all months for `cost_lifetime`; (c) the existing app-count aggregation. Add `totalCreditsConsumed` = Σ `credits_used` (current-period consumed) to stats. *(Lifetime sums are O(users) subcollection reads; accepted at current scale — same shape as the existing per-user app-count `Promise.all`. Dropping the `getAll` avoids reading the current usage doc twice.)*
  - New `getAdminUserCredits(userId): Promise<{ credits: CreditSummary; grants: CreditGrantAudit[] }>`: `getCreditSummary(userId)` for `credits`; `collections.creditGrants(userId).orderBy("created_at","desc").get()` mapped to `CreditGrantAudit` (`created_at` Timestamp→ISO via the file's existing `toISOString`; pick `amount`/`type`/`actor_email`/`reason`/`period`, drop `actor`).
  - `getAdminUserDetail`: add `getAdminUserCredits(userId)` to the parallel `Promise.all`, spread its `credits` + `grants` into the response.
  - `getAdminUserUsage`: also read `collections.creditMonths(userId).get()`, build a `Map<period, {consumed, bonus}>`, and attach `credits_consumed`/`credits_bonus` to each `UsagePeriod` row (left undefined when a period has no credit doc).
- [ ] **Step 3: No new test.** These are Firestore read-and-aggregate functions composing already-tested primitives (`getCreditSummary` unit+integration-tested in Tasks 3/4); the aggregation is a Σ + a `Map` join + a field-rename map, and the admin layer has no existing test harness. A hand-mocked Firestore unit test would be tautological (`feedback_tautological_mocks`); an emulator integration test would mostly re-exercise `getCreditSummary`. Verify by reading + `npx tsc --noEmit` + `npx vitest run lib/db` (credit primitives still green).
- [ ] **Step 4: Commit** `git commit -am "feat(credits): admin data layer surfaces credits + lifetime + audit"`

---

## Task 10: Admin reset/grant endpoint (first admin write route)

**Files:** Create `app/api/admin/users/[id]/credits/route.ts` + `__tests__/route.test.ts`.

- [ ] **Step 1: Write failing tests:** non-admin → 403 (`requireAdmin`); admin POST `{action:"reset"}` → calls `resetCredits(targetId, {actor, actorEmail, reason:null})`; admin POST `{action:"grant", amount}` → calls `grantCredits(targetId, amount, {actor, actorEmail, reason})`; bad body (grant with no/zero/non-int `amount`, unknown `action`, malformed JSON) → 400 via `handleApiError`. **There is NO existing admin route test — establish the harness:** `vi.mock("@/lib/auth-utils", ...)` to make `requireAdmin` either resolve a fake admin `Session` (`{ user: { id, email, role: "admin" }, session: {…} }`) or throw `new ApiError("Admin access required", 403)`; `vi.mock("@/lib/db/credits", ...)` to spy `resetCredits`/`grantCredits` (and assert call args); do NOT mock `@/lib/apiError` (use the real `handleApiError` so `ApiError.status` flows to the response). Call the `POST` export directly with `new Request("https://commcare.app/api/admin/users/u1/credits", { method:"POST", body: JSON.stringify({...}) })` and `{ params: Promise.resolve({ id: "u1" }) }`; assert `res.status` + `await res.json()`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `POST` handler: `requireAdmin(req)` → resolve `id` param (target user) + acting admin from session; read `req.json()` inside a try/catch (malformed JSON → `ApiError 400`, never a generic 500); validate with a **`z.discriminatedUnion("action", [...])`** — a `reset` arm `{ action: z.literal("reset"), reason }` and a `grant` arm `{ action: z.literal("grant"), amount, reason }` where `amount` is `z.number({ error: GRANT_AMOUNT_MESSAGE }).int(GRANT_AMOUNT_MESSAGE).positive(GRANT_AMOUNT_MESSAGE)`. The DU (not a `.refine`) makes `amount` statically `number` on the grant branch, so the handler calls `grantCredits(userId, parsed.data.amount, who)` with NO narrowing guard / `!` / `any`. `GRANT_AMOUNT_MESSAGE = "A grant needs a positive whole credit amount."` is carried on every check so a missing/non-number/zero/negative/fractional amount all surface that one human message via `parsed.error.issues.map(i => i.message)` → `ApiError.details`. (Zod 4 `{ error }` param — the unified replacement for v3 `message`/`required_error`; confirm via context7 if unsure.) `who: AdminActor = {actor: admin.user.id, actorEmail: admin.user.email, reason: parsed.data.reason ?? null}`; reset → `resetCredits(userId, who)`; return `{ ok: true }`; wrap in `handleApiError`. This establishes the first admin write-route pattern (file-top comment documents it: requireAdmin gate + ApiError envelope + the called `lib/db/credits` fn owns the Firestore transaction + audit; the route never touches Firestore). **Test asserts the error BODY, not just status** — the missing/negative/fractional grant tests each assert `body.details` contains the grant message (mutation-checked: stripping the message fails exactly those tests), and the malformed-JSON test asserts `body.error` mentions valid JSON. 9 tests.
- [ ] **Step 4: Run — expect PASS;** `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `git commit -am "feat(credits): admin reset/grant endpoint with audit"`

---

## Task 11: Admin user table — credit + lifetime columns

> **Load the `frontend-design` skill.** Match the existing `app/(app)/admin/user-table.tsx` column/markup style exactly; shadcn + Tabler offline icons only.

**Files:** Modify `app/(app)/admin/user-table.tsx`.

- [ ] **Step 1:** Replace the single `cost` column with: **Credits** (a `CreditsCell` — bold `credits_remaining` emphasized + muted `{credits_used} / {credits_used + credits_remaining} used`; the denominator is derived as `used + remaining` = the effective `allowance + bonus`, so the row reconciles with the bold remaining even after a bonus grant — sorted on `credits_remaining`), **Lifetime cr** (`credits_used_lifetime`), **$ this mo** (`cost`), **$ lifetime** (`cost_lifetime`). Keep `generations`, `last_active_at`. Credits use built-in `.toLocaleString()`; `formatCurrency` for the two dollar columns; do not introduce new helpers. Emphasis by weight, not colour (semantic hues reserved for real states). *(Side effect: `AdminUserRow.credits_allowance` is no longer read by the cell after the derived-denominator fix — kept as a wired, meaningful DTO field; flagged for the final whole-branch review.)*
- [ ] **Step 2:** `npx tsc --noEmit`. Verify columns render with the new `AdminUserRow` fields (no test — UI; verified in Final Verification).
- [ ] **Step 3: Commit** `git commit -am "feat(credits): admin table shows credits + lifetime figures"`

---

## Task 12: User detail — credit columns, totals row, reset/grant control

> **Load the `frontend-design` skill.** shadcn `AlertDialog`, `Button`, `Field`/`Input`, `Label` from `@/components/shadcn`; Tabler offline icons; `cn` from `@/lib/utils`.

**Files:** Create `app/(app)/admin/users/[id]/credit-controls.tsx` (client control) + `app/(app)/admin/users/[id]/user-credits.tsx` (async server section, matching the `user-usage.tsx`/`user-apps.tsx` per-section pattern — page.tsx only lists `credit-controls.tsx`, but the detail page streams each section as its own async server component, so the credit fetch needs a section wrapper); Modify `app/(app)/admin/users/[id]/user-usage.tsx`, `app/(app)/admin/users/[id]/page.tsx`, `app/(app)/admin/users/[id]/skeletons.tsx`.

- [ ] **Step 1: `user-usage.tsx`** — add per-period **credits consumed** (`period.credits_consumed ?? 0`) + **bonus** (`period.credits_bonus ?? 0`) columns beside the cost column, and a **totals row** summing the section's OWN periods: Σ `credits_consumed ?? 0` (= lifetime credits used) and Σ `cost_estimate` (= lifetime cost). Source the totals from the periods the table already renders (not a second fetch) so the totals literally equal the sum of the visible columns — the detail response carries `credits: CreditSummary` (lifetime credits) but NO dollar `cost_lifetime`, and summing the rows is both self-contained and verifiable. Match the existing `<th>`/`<td>` markup + `formatCurrency`/`.toLocaleString()` (credits are integers).
- [ ] **Step 2: `user-credits.tsx`** (async server section) — `UserCreditsSection({ userId })`: `const { credits, grants } = await getAdminUserCredits(userId);` then render `<CreditControls userId={userId} credits={credits} grants={grants} />`. Mirror the `UserUsageSection` doc-comment/structure (async server component, streamed by the page's Suspense).
- [ ] **Step 3: `credit-controls.tsx`** (`"use client"`) — `CreditControls({ userId, credits, grants })` (`credits: CreditSummary` from `@/lib/db/credits`, `grants: CreditGrantAudit[]` from `@/lib/admin/types`). A card showing the current standing (balance/remaining, allowance, used, bonus if >0, lifetime consumed) with two `AlertDialog`-confirmed actions:
  - **Reset credits** → confirm dialog (optional `reason` Input) → `POST /api/admin/users/{id}/credits {action:"reset", reason?}`.
  - **Grant credits** → dialog with `amount` Input (required positive integer — client-validate before enabling confirm) + optional `reason` Input → `POST {action:"grant", amount, reason?}`.
  shadcn `AlertDialog`/`Button`/`Field`/`Input`/`Label` from `@/components/shadcn`; `cn` from `@/lib/utils`; Tabler offline icons. *(Landed `7bcef602`: controlled `<AlertDialog open onOpenChange>` gated on `pending===null`, `AlertDialogAction` rendered as a plain `Button` that drives the async handler — matching the repo's `CaseListScreen` idiom — so the dialog never auto-closes mid-write; `import type` for `CreditSummary` to keep `@google-cloud/firestore` out of the client bundle; form fields persist on cancel→reopen by design — they're always visible in the editable Input at confirm, so there's no stale-submit risk.)* **Leak-safe pending (CLAUDE.md + the build's async-leak gate):** a controllable in-flight flag (`useState<null | "reset" | "grant">`), set before `fetch`, cleared in `finally`; disable the confirm button + show a pending label while in flight; **control the dialog's `open` state** so it does NOT auto-close before the request settles (close only on success). NEVER a never-resolving promise. On success → `showToast("info"/"success", …)` + `useExternalNavigate().refresh()` (re-streams the server section → fresh balance + a new audit row); on failure → parse the `{ error }` envelope from the response and `showToast("error", …)` (keep the dialog open so the admin can retry). Render the `grants` audit list (already newest-first from the server): a `reset`/`grant` Badge, amount (grants), `actor_email`, `reason` (when present), and the date (`created_at` ISO → `formatRelativeDate(new Date(...))`).
- [ ] **Step 4: `page.tsx`** — add a `<Suspense fallback={<CreditsSkeleton />}><UserCreditsSection userId={userId} /></Suspense>` boundary (place the credit controls between the Profile and Usage sections — balance + actions up top, history below). **Step 4b: `skeletons.tsx`** — add a `CreditsSkeleton` matching the card shape, and include it in `UserDetailPageSkeleton`.
- [ ] **Step 5:** `npx tsc --noEmit` (clean except the known fumadocs error); `npx biome check` the touched files. (UI verified in Final Verification — the reset/grant flow is the highest-stakes line there.) No RTL/jsdom test (repo rule). If you can cheaply factor the POST-dispatch + pending logic into a tiny pure-ish handler, fine, but do NOT mount a DOM test.
- [ ] **Step 6: Commit** `git commit -am "feat(credits): admin reset/grant control + per-period credit columns"`

---

## Task 13: Admin headline fleet-credits stat

**Files:** Modify `app/(app)/admin/admin-content.tsx`.

- [ ] **Step 1:** Add a `StatCard label="Credits Used" value={stats.totalCreditsConsumed.toLocaleString()} subtitle="this month"` to the headline grid (place it before the dollar card so credits read as the primary gate metric). Relabel the dollar card "Total Spend" → **"Actual Spend"** (keeps `formatCurrency(stats.totalSpend)`, subtitle "this month") so it reads as the true $ cost, no longer the gate. Widen the grid `sm:grid-cols-3` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` for the 4 cards. Match the existing `StatCard` chrome; neutral cards (no decorative colour). *(Landed `0ed163f0`.)*
- [ ] **Step 2:** `npx tsc --noEmit`. **Commit** `git commit -am "feat(credits): admin headline shows fleet credits consumed"`

---

## Task 14: User's AccountMenu shows credits, not dollars

> **Load the `frontend-design` skill.**

**Files:** Modify `components/ui/AccountMenu.tsx`.

- [ ] **Step 1:** Replace the local `UsageData` interface with the shared type — `import type { CreditSummary } from "@/lib/db/credits"` (MUST be `import type`: the value side pulls `@google-cloud/firestore`; the type erases — single source of truth, mirrors `credit-controls.tsx`). The bar is a **remaining-credits fuel gauge** anchored to the effective monthly `total = balance + consumed` (= `allowance + bonus`, so it reconciles for bonused users): `remainingRatio = total > 0 ? Math.min(Math.max(balance / total, 0), 1) : 0`; fill width `${remainingRatio * 100}%` (full when fresh, **0% / empty when depleted** — drop the old `Math.max(…, 1)` sliver floor). **`getBarGradient` is flipped** to warn on LOW remaining: `remainingRatio < 0.2` → `from-nova-amber to-nova-rose`, else `from-nova-violet to-nova-violet-bright` (the inverse of the old `>0.8`-consumed dollar trigger — same 20% headroom, expressed in remaining terms). Label "Usage this month" → "Credits this month"; figure `{balance.toLocaleString()} / {total.toLocaleString()} credits` (remaining / total — a no-bonus user reads "1,900 / 2,000", a bonused user "2,400 / 2,500"; bar + figure now move the SAME direction). **Remove the now-unused `formatCurrency` import.** Keep the `refreshUsage`/`AbortController` fetch lifecycle + the Popover/avatar markup. *(Landed `cbc521ad`. The fuel-gauge direction + gradient flip came out of review — the original draft had a consumption-fill bar paired with a remaining figure, which read backwards for a fresh user.)*
- [ ] **Step 2:** `npx tsc --noEmit`. **Commit** `git commit -am "feat(credits): account menu shows credit balance instead of dollars"`

---

## Task 14B: Send-button cost indicator

> **Load the `frontend-design` skill.** The repo's tooltip is `Tooltip` from `@/components/ui/Tooltip` (Base-UI-backed, `<Tooltip content={…} placement="top">{child}</Tooltip>`, root `TooltipProvider` already mounted) — NOT a shadcn tooltip (there is none). Tabler offline icon; `cn` from `@/lib/utils`. Subtle, not anxiety-inducing.

**Files:** Create `lib/credits/useCreditBalance.ts` (shared client balance hook); Modify `components/chat/ChatInput.tsx` (the composer — it renders the `textarea` + the send `button`) and `components/ui/AccountMenu.tsx` (refactor its inline fetch onto the shared hook). *(No test — UI; verified in Final Verification.)*

- [ ] **Step 1: `lib/credits/useCreditBalance.ts`** — extract the credit-balance fetch into a reusable hook so the chip + `AccountMenu` share the logic (the spec's DRY requirement). `useCreditBalance(): { summary: CreditSummary | null; refresh: (signal?: AbortSignal) => void }` — fetch `GET /api/user/usage` into `CreditSummary` on mount (best-effort, `.catch(()=>{})`, `AbortController` cleanup), expose `refresh` so `AccountMenu` can re-fetch on dropdown open. `import type { CreditSummary }`. Place under `lib/credits/` (client domain hook — it touches no doc/session/url store, so it does not violate the store-boundary rules).
- [ ] **Step 2: `components/ui/AccountMenu.tsx`** — replace the inline `refreshUsage`/`useState`/`useEffect` fetch with `useCreditBalance()`; call `refresh()` in the existing mount + on-open effects. Behaviour unchanged (the remaining-credits bar still reads `summary.balance`/`summary.consumed`). Net simplification.
- [ ] **Step 3: `components/chat/ChatInput.tsx`** — `appReady` comes from `useBuilderIsReady()` (`@/lib/session/hooks` — exactly `phase === Ready || Completed`, the SAME predicate the composer puts on the `/api/chat` request, so the indicator can never disagree with the charge). Render a small cost chip **next to the send button**: a Tabler coin/bolt icon + `chargeAmount(appReady)` from `@/lib/db/creditPolicy` (100 build / 5 edit — client-safe, no Firestore). Wrap it in `<Tooltip content={…}>` explaining: a build → *"This build will use 100 credits"*; an edit → *"Edits use 5 credits — clarifying questions are free."*; plus, when `summary` is loaded, *"You have {summary.balance} credits left this month."* (from `useCreditBalance()`). Subtle styling (muted token, `tabular-nums`), not alarming. Keep the existing send-button behaviour + the `autoComplete`/`data-1p-ignore` textarea attrs.
- [ ] **Step 4:** `npx tsc --noEmit` (clean except the known fumadocs error); `npx biome check` the touched files. **Commit** `git commit -am "feat(credits): send-button shows the credit cost of the next action"`

*(Landed `a7e54f7e`. Both the chip number AND the tooltip prose read from `cost = chargeAmount(appReady)` — single source, no hardcoded 5/100. The balance line is best-effort: `useCreditBalance()` fetches once on mount, so it can go stale after a generation — reviewed + accepted, because the load-bearing figure is the reactive cost number, not the supplementary balance, and `AccountMenu` carries the fresh balance via its on-open refresh.)*

---

## Task 15: Migration scan (read-only)

**Files:** Create `scripts/lib/creditReconcile.ts` (the **pure** reconciliation — no Firestore, no I/O), `scripts/__tests__/creditReconcile.test.ts` (fixtures per spec §10), and `scripts/inspect-credit-migration.ts` (the read-only I/O wrapper: Firestore reads → `creditReconcile` → printing). Mirror `scripts/inspect-usage.ts` conventions (commander, `scripts/lib/firestore` `db`, `scripts/lib/format`, `runMain`). **Never writes.** Splitting the pure reconcile out makes the load-bearing grouping/cross-month/delta logic unit-testable without the emulator (the spec §10 migration-reconciliation tests live here), and lets Task 16's migrator reuse the SAME pure function so the scan preview and the apply can never disagree.

> **This scan is the search strategy — build + run it FIRST, before finalizing the migrator (Task 16).** Per the advisor: every open question (real deltas, how many cross-month threads, who would re-block on the current month) is answered by this output, not by argument. It is read-only + decision-agnostic; it does NOT restore anything.

- [ ] **Step 1: `scripts/lib/creditReconcile.ts` (pure) + its test (TDD).** Define a pure `creditReconcile(runs, currentUsage, currentPeriod, backstopUsd)` over plain inputs (NO Firestore types):
  - `RunInput = { runId; appId; ownerId; deleted: boolean; costEstimate: number; startedPeriod: string; finishedPeriod: string }` (`startedPeriod`/`finishedPeriod` are the `yyyy-mm` slices of the run's ISO `startedAt`/`finishedAt` — `RunSummaryDoc.startedAt`/`finishedAt` are `z.string()`, so the wrapper passes `iso.slice(0,7)`).
  - `currentUsage: Map<string, number>` keyed `"${ownerId}/${period}"` → current `cost_estimate`.
  - Returns one `CellRow` per `(ownerId, finishedPeriod)`: `{ ownerId, period, current, ledgerSum, delta: ledgerSum−current, isCurrentMonth: period===currentPeriod, softDeletedContribution (Σ costEstimate of `deleted` runs in the cell), crossMonthRuns: [{runId, appId, startedPeriod, finishedPeriod, costEstimate}] (runs where startedPeriod !== finishedPeriod), overBackstopCurrentMonth: isCurrentMonth && ledgerSum >= backstopUsd }`. Group by `finishedPeriod`; include soft-deleted runs in `ledgerSum` (noted, not excluded). Write `scripts/__tests__/creditReconcile.test.ts` FIRST (red→green) with fixtures mirroring spec §10: a single-period user (delta vs current); a **cross-month** run (started 2026-05, finished 2026-06 → whole cost in June, listed in `crossMonthRuns`); a **soft-deleted** app's run (counted in `ledgerSum` + `softDeletedContribution`); a **current-month over-$50** cell (`overBackstopCurrentMonth` true); a cell where `current === ledgerSum` (delta 0). Assert the grouping, sums, delta, flags.
- [ ] **Step 2: `scripts/inspect-credit-migration.ts` (read-only I/O wrapper).** `db.collectionGroup("runs").get()` → for each run doc build a `RunInput` (`appId = doc.ref.parent.parent.id`; `costEstimate`; `startedPeriod`/`finishedPeriod` from the ISO strings). Batch-read the distinct `apps/{appId}` docs → `ownerId = owner`, `deleted = deleted_at != null`. Batch-read `usage/{owner}/months/{period}.cost_estimate` for every `(owner, period)` present → the `currentUsage` map. `currentPeriod = new Date().toISOString().slice(0,7)`; `backstopUsd = ACTUAL_COST_BACKSTOP_USD` (import from `@/lib/db/creditPolicy`). Call `creditReconcile`, resolve `ownerId → email` via `auth_users`, and print with `scripts/lib/format` (`printHeader`/`printSection`/`printTable`/`usd`): a per-cell table (`email`, `period`, `current`, `ledger_sum`, `delta`, `CURRENT?`, `soft-deleted $`), then prominent sections for **CROSS-MONTH runs** (run + both timestamps), **CURRENT-MONTH OVER-$50** (loud — would re-block), and **non-zero DELTAS** (the re-baseline preview). Print the recorded cross-checks (mmaher April `unadjusted_estimate` live value + the recorded mmaher/alohi June figures) beside their ledger-sums, and the orphan key's live value if present. **Never writes** (no `set`/`update`/`delete`; `runMain` wrapper).
- [ ] **Step 3: Verify** — `npx vitest run scripts/__tests__/creditReconcile.test.ts` (PASS), `npx tsc --noEmit` (clean), `npx biome check` the new files. (Cannot run against PROD from the worktree — that's Step 4, post-merge.)
- [ ] **Step 4: Run read-only against PROD** (post-merge, with the user): `npx tsx scripts/inspect-credit-migration.ts`. Capture output — this is the data the re-baseline apply is decided on.
- [ ] **Step 5: Commit** `git commit -am "chore(credits): read-only migration scan + pure reconcile"`

*(Landed `c99466c1`. 8 pure-reconcile tests (single-period / cross-month / soft-deleted / over-$50 / delta-0 / empty / multi-owner-sort). Wrapper is strictly read-only (only `Map.set`), chunks `getAll` at 300, skips+counts missing-field + orphan runs. Review hardened two display-accuracy edges: the non-zero-delta filter uses `Math.abs(delta) >= 0.00005` (float-noise can't show a phantom `$0.0000` move), and the cost guard uses `Number.isFinite` so a non-finite cost can't silently un-flag an over-backstop cell.)*

---

## Task 16: Migrator — re-baseline cost + credit seed (dry-run default, --apply)

**Files:** Create `scripts/migrate-actual-cost.ts` (the guarded writer) + `scripts/lib/creditMigrationData.ts` (the shared READ loader: `db` → `{ runs: RunInput[], currentUsage, currentPeriod, emailOf }`), and **refactor `scripts/inspect-credit-migration.ts` (Task 15) to consume that same loader** — so the scan PREVIEW and the migrator APPLY read PROD identically and can never diverge (the migrator also reuses the pure `creditReconcile`). Guarded writer mirrors `scripts/recover-app.ts` (dry-run default; an explicit write flag). Multi-action: `--rebaseline-cost`, `--seed-credits` (this task), `--delete-orphan` (Task 17). Default dry-run; `--apply` writes. **Build AFTER Task 15's scan exists** (the scan is the search strategy; this migrator encodes "closed-month auto, current-month opt-in" as the only applyable shapes). Create-only seed via `ref.create(...)` — it throws gRPC `ALREADY_EXISTS` (code 6) on an existing doc → catch + skip (never clobber a user who generated in the deploy→migrate gap).

- [ ] **Step 1: Re-baseline-cost action** (`--rebaseline-cost`) — writes ONLY `usage/{userId}/months/{period}.cost_estimate`, recomputing it from the same per-`(user,period)` run-ledger-sum the Task 15 scan prints (re-derive it here from `collectionGroup("runs")` — do NOT trust a value passed in). **The closed-month vs current-month split is load-bearing (advisor):**
  - **CLOSED months** (`period < current yyyy-mm`): re-baseline freely — set `cost_estimate = ledger_sum`. (Reporting accuracy is about closed months; they don't touch the live gate.)
  - **CURRENT month** (`period === current yyyy-mm`): **never silent-write** — it feeds the live `$50` backstop and can re-block a user. Print each current-month cell as "would set `cost_estimate = X` (Δ …, OVER-$50? …) — confirm with `--current-user <email>`", and write it ONLY for users named via repeatable `--current-user`. So the default `--apply` re-baselines all closed months + skips the current month until the user, looking at the scan, opts specific users in.
  - **CROSS-MONTH** runs were flagged by the scan + reviewed before `--apply`; the re-baseline attributes by `finishedAt` (the figure the scan showed) — no separate per-run exclusion logic.
  - Dry-run (default) prints before/after for every cell; `--apply` writes (closed auto, current per-`--current-user`); re-reads + confirms each write. **No hardcoded magic numbers** — mmaher/alohi's true costs come from the ledger (my reset never touched it); the recorded figures are scan cross-checks only.
  - *(Provisional: the exact current-month write SET is decided at apply-time with the user reading the Task 15 scan — the script's job is to make "closed auto, current opt-in-per-user" the only shapes it can apply.)*
- [ ] **Step 2: Credit-seed action** (`--seed-credits`) — **create-only** seed of every existing user's current-period `credits/{userId}/months/{period}`. For each `auth_users` doc, `create({ allowance: 2000, consumed: 0, bonus: 0, updated_at })` — `.create()` THROWS if the doc exists, so a user who already generated (lazily created their doc in the deploy→migrate gap) is **skipped, never clobbered** (catch the `ALREADY_EXISTS` and report "skipped — already active"). Idempotent: re-running seeds only the still-missing docs. Dry-run lists who would be seeded vs skipped; `--apply` writes.
- [ ] **Step 3:** Dry-run both actions, then `--apply` against PROD with the user; capture output.
- [ ] **Step 4: Commit** `git commit -am "chore(credits): migrator — re-baseline cost (closed auto / current opt-in) + create-only credit seed"`

*(Landed `8bf27097`. Pure `planRebaseline(rows, currentUserEmails, emailOf)` partitions into closed/current-opted-in/current-skipped; shared `loadReconciliationData()` loader so scan-preview and apply read PROD identically; create-only seed catches gRPC `ALREADY_EXISTS` (6) and rethrows else. Review hardened the current-month fail-safe: the `--current-user` opt-in set filters empties AND `planRebaseline` refuses an empty resolved email (so an unset `--current-user "$VAR"` can't silently re-baseline every unresolved-email current-month cell), `emailOf` is a real-email-only map (id fallback at display only) so the documented "no real email ⇒ never opted in" invariant is literally true, and the re-read confirmation now sets `process.exitCode=1` + a failure banner on a write that doesn't land. 14 pure tests incl. the fail-safe branch.)*

---

## Task 17: Guarded orphan delete (separate pass)

**Files:** Modify `scripts/migrate-actual-cost.ts` (add a `--delete-orphan` action).

- [ ] **Step 1: Implement** `--delete-orphan`: live-read `usage/w4KlwedcG1WijXOK0hVz/months/2026-04`; **assert `cost_estimate >= unadjusted_estimate`** (April is a closed month, so Task 16's `--apply` already re-baselined its `cost_estimate` to the ledger sum ≥ the under-counted orphan stash) — refuse otherwise; then `FieldValue.delete()` the `unadjusted_estimate` key. Dry-run default; `--apply` writes; re-read confirms key gone.
- [ ] **Step 2:** Run AFTER Task 16's `--apply` is confirmed in PROD: dry-run → `--apply --delete-orphan` with the user; capture output.
- [ ] **Step 3: Commit** `git commit -am "chore(credits): guarded delete of the unadjusted_estimate orphan"`

*(After the migration apply output is captured and signed off, a follow-up commit `git rm`s both migration scripts per the delete-one-off-scripts rule. The uncommitted `scripts/reset-usage.ts` stopgap on the author's `main` working tree is deleted there once this ships — out of this PR's scope.)*

---

## Task 18: Config + docs cleanup

**Files:** Modify `.env.example`, `lib/db/CLAUDE.md`, root `CLAUDE.md`.

- [ ] **Step 1:** Remove the `MONTHLY_SPEND_CAP_USD` "Usage tracking" block from `.env.example` (no other config depends on it — verified).
- [ ] **Step 2:** `lib/db/CLAUDE.md`: document the two-ledger model — `usage/` is accumulate-only actual cost (resets never touch it); `credits/` is the resettable gate; the charge signal reads raw `body.messages`. Root `CLAUDE.md`: update the "Fail-closed persistence"/usage wording from "spend cap" to "credit gate (build 100 / edit 5, reserved up front) + invisible $50 actual-$ backstop." **No line numbers, no external-doc references** in any committed comment/doc per project rules.
- [ ] **Step 3:** Run the `docs` skill pass over `app/(docs)/` for any user-facing $15-cap mention → credits.
- [ ] **Step 4: Commit** `git commit -am "docs(credits): two-ledger model + remove spend-cap env var"`

---

## Final Verification (user-runnable acceptance)

- [ ] `npm run lint && npx tsc --noEmit` — clean (0 errors, 0 warnings).
- [ ] `npm run test:leaks` — full suite green under the async-leak detector.
- [ ] **User-runnable acceptance:** The admin runs `npm run dev`, opens `http://localhost:3000/admin`, and sees per user **credits used / remaining this month**, **lifetime credits used**, **$ this month**, and **$ lifetime** as rendered figures. Opening a user's detail page (`/admin/users/<id>`), the admin clicks **Reset credits**, confirms the dialog, and sees `consumed` drop to 0 / balance back to 2,000, a new audit row appear, **and both $ figures unchanged**. Clicking **Grant credits**, entering e.g. `500` + a reason, and confirming bumps the balance by 500 (a `bonus` grant), appends a `grant` audit row, and again leaves both $ figures unchanged; the dialog stays open + shows a pending label while the write is in flight (never a stuck/never-resolving state). The detail page's usage table shows per-period **credits used** + **bonus** columns with a **totals row** equal to the sum of those columns. Signed in as that user, the `AccountMenu` shows a **credits-remaining** fuel-gauge bar (no dollars), full + violet when fresh and short + amber/rose when nearly depleted; hovering the chat **send button** shows a cost chip — **100** in a fresh build, **5** once an app is built — whose tooltip names the cost and the remaining balance. Starting a build debits **100**, an edit debits **5**, answering a clarifying question debits **0**; when the balance can't cover the next charge the request is blocked with "You're out of credits for this month." When a generation **fails / breaks the app**, a **refund toast** appears, the balance returns to its pre-charge value, and the admin's actual-$ figure still rose for that failed run.
- [ ] **PROD migration (post-merge, with user):** run Task 15 scan → review → Task 16 `--apply` → confirm mmaher/alohi/April restored in the admin `$ lifetime` figures → Task 17 `--apply --delete-orphan` → confirm orphan gone → follow-up commit `git rm`s the migration scripts.

---

## Self-Review

**Spec coverage:** §2 charging unit → Tasks 2,7. §2a signal/amount → Tasks 2,7. §3 constants → Task 2. §4a accumulate-only usage → Task 5 (no reset writer added) + Task 18 doc. §4b credits ledger → Task 1. §5a/5b reserve → Tasks 3,7. §5c refund (failed-run OR no-op) → Tasks 5 (flush + `markRunFailed`), 7 (`handleRouteError` hook + `data-credit-refund`), 7B (toast). §5d reset/grant → Tasks 4,10. §6 gate → Task 7. §7 debit integration → Tasks 5,7. §8a table → Tasks 9,11. §8b detail+control → Tasks 9,12. §8c endpoint → Task 10. §8d AccountMenu → Tasks 8,14. §8e refund toast → Task 7B. §8f send-button cost indicator → Task 14B. §9a/9b migration restore+orphan → Tasks 15,16,17. §9c credit seed (create-only) → Task 16. §10 tests → Tasks 1–10 test steps. §11 docs → Task 18. §12 acceptance → Final Verification. New files `lib/db/period.ts` + `lib/db/creditPolicy.ts` (Tasks 2,3), mods `components/chat/ChatContainer.tsx` (7B) + chat composer (14B) owned. **No gaps.**

**Placeholder scan:** every code step shows real code or an exact existing file/pattern to mirror; UI tasks name the component, its props, and its **mount site** (Task 12 mounts in `page.tsx`; Task 11/13/14 modify existing mounted surfaces). No "TBD"/"add validation"/"similar to Task N".

**Type consistency:** `CreditMonthDoc{allowance,consumed,bonus,updated_at}`, `CreditGrantDoc{amount,type,actor,actor_email,reason,period,created_at}`, `Reservation{period,reserved}`, `CreditSummary{period,allowance,consumed,bonus,balance,lifetimeConsumed}`, `creditGateDecision→{chargeable,cost}` — names used identically across Tasks 1,3,4,5,7,9. Helpers: `creditBalance`, `chargeAmount`, `isChargeableTurn`, `reserveCredits`, `refundCredits`, `resetCredits`, `grantCredits`, `getCreditSummary` — consistent. Error type `out_of_credits` consistent (Tasks 6,7). Constants `CREDITS_PER_BUILD=100`, `CREDITS_PER_EDIT=5`, `MONTHLY_CREDIT_ALLOWANCE=2000`, `ACTUAL_COST_BACKSTOP_USD=50` — consistent.
