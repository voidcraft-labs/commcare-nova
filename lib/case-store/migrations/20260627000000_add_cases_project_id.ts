// Add the `project_id` tenant column to `cases` (Project-spaces rescope, P4).
//
// The case store's structural tenant filter moves from `owner_id` to `project_id`
// so members of a shared Project see one another's case rows. `owner_id` stays a
// first-class column — it is the CommCare case-owner, Nova's reserved axis for
// future location-/group-based access carving; nothing filters on it today
// (locations are unimplemented) and it defaults to the creating user, but it is
// NOT disposable. The two axes are orthogonal: `project_id` (tenant / sharing) ×
// `owner_id` (case ownership / future location access). See
// `lib/case-store/CLAUDE.md` § "Tenant scoping".
//
// EXPAND step of expand → backfill → read-switch. The column is added NULLABLE
// with no default — a metadata-only `ADD COLUMN` (no table rewrite, no
// `ACCESS EXCLUSIVE` held long, safe to run while the old revision serves).
//
// ⚠ DEPLOY ORDERING IS REVIEW-ENFORCED, NOT AUTOMATED (expand-contract; see
// `lib/case-store/CLAUDE.md` § "Destructive changes — expand-contract"). This
// migration and the code that READS `project_id` (the rescoped store +
// `compileRelationPath`) MUST NOT ship in the same deploy: a single deploy would
// add the NULL column and immediately serve `WHERE project_id = $bound` reads, so
// every pre-existing (NULL) case row would vanish. Stage per the PR runbook —
// deploy this migration, run the backfill to completion, THEN deploy the
// read-switch revision. Two later steps complete the contract, each its own deploy:
//
//   - Backfill: `scripts/backfill-cases-project-id.ts --apply` stamps every
//     existing row's `project_id` from its app's `project_id` (cases.app_id →
//     Firestore app.project_id). Run BEFORE the read-switch revision serves — a
//     row with a null `project_id` silently fails the `project_id = $bound` filter
//     and vanishes from queries.
//   - A future migration sets `NOT NULL` once no null rows remain (the type
//     contract in `sql/database.ts` already treats it as non-null, the read-switch
//     steady state).
//
// No index: the outer scan has no `(app_id, case_type, owner_id)` index today
// (seq scan over the small per-app partition), so the `project_id` filter needs
// none either. A `cases` index, if ever wanted, builds via `applySchemaChange`'s
// Phase-B `CREATE INDEX CONCURRENTLY` path, never a migration (a plain
// `CREATE INDEX` here would hold `ACCESS EXCLUSIVE` while the old revision serves).
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "project_id" text`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" DROP COLUMN IF EXISTS "project_id"`.execute(db);
}
