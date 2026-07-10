// Add the gateway-metered `actual_cost` column to `run_summaries` and
// `usage_months`.
//
// Every AI Gateway response reports the actual USD it charged for the call
// (`providerMetadata.gateway.cost`), so the run summary and the monthly usage
// row now accumulate that meter beside the token-math `cost_estimate` — the
// estimate remains the pre-flight forecast, the actual is the settled truth
// and what the `ACTUAL_COST_BACKSTOP_USD` guard also trips on.
//
// `NOT NULL DEFAULT 0`: rows written before actuals existed read as 0 — the
// same "not accrued" reading a genuinely free run has, and what the additive
// increment paths (`writeRunSummary`, `incrementUsage`) require.
//
// Metadata-only `ADD COLUMN` (constant default) — catalog-only on modern
// Postgres, safe while the old revision serves.
//
// Dual-sourced with `RunSummariesTable` / `UsageMonthsTable` in
// `lib/db/pg.ts` (updated in the same change).
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "run_summaries" ADD COLUMN IF NOT EXISTS "actual_cost" double precision NOT NULL DEFAULT 0`.execute(
		db,
	);
	await sql`ALTER TABLE "usage_months" ADD COLUMN IF NOT EXISTS "actual_cost" double precision NOT NULL DEFAULT 0`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "run_summaries" DROP COLUMN IF EXISTS "actual_cost"`.execute(
		db,
	);
	await sql`ALTER TABLE "usage_months" DROP COLUMN IF EXISTS "actual_cost"`.execute(
		db,
	);
}
