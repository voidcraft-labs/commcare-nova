// Drop the orphaned `actual_cost` columns from `run_summaries` and
// `usage_months` — the contract step of the expand-contract retirement of
// the gateway-metered cost axis. Nothing reads or writes these columns:
// `cost_estimate` (token math over `MODEL_PRICING`) is the one dollar
// counter, and with a direct OpenAI key it is the deterministic bill.
//
// This migration must deploy AFTER a revision that no longer writes the
// columns is serving (the migrate Job runs while the previous revision still
// takes traffic) — which is any deploy after the direct-provider cutover.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "run_summaries" DROP COLUMN IF EXISTS "actual_cost"`.execute(
		db,
	);
	await sql`ALTER TABLE "usage_months" DROP COLUMN IF EXISTS "actual_cost"`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "run_summaries" ADD COLUMN IF NOT EXISTS "actual_cost" double precision NOT NULL DEFAULT 0`.execute(
		db,
	);
	await sql`ALTER TABLE "usage_months" ADD COLUMN IF NOT EXISTS "actual_cost" double precision NOT NULL DEFAULT 0`.execute(
		db,
	);
}
