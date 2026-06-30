// lib/case-store/retenant.ts
//
// Re-tenant an app's case rows from one Project to another — the case-store
// half of moving an app between Projects (`lib/db/moveAppToProject.ts`). It is
// the ONE cross-tenant data write in the package: every other read/write is
// structurally pinned to a single bound `project_id` (`withProjectContext`),
// and `withSchemaContext`'s `SchemaCaseStore` exposes only schema ops. A move
// has to rewrite the structural tenant key itself, so it lives here as a
// deliberate, named, app-scoped exception rather than as a `CaseStore` method
// that would undermine that class's single-tenant invariant.
//
// Only `cases` carries `project_id`. `cases_quarantine` has no tenant column
// (app-scoped audit), and `case_type_schemas` / `case_indices` key on
// `(app_id, case_type)` / `(case_id, …)` — app-scoped and tenant-free, so their
// rows and the per-`(app, case_type)` partial expression indexes keep covering
// the moved rows unchanged. Re-tenanting `cases` is therefore the whole job.

import type { Kysely } from "kysely";
import { getCaseStoreDatabase } from "./postgres/connection";
import type { Database } from "./sql/database";

interface RetenantArgs {
	appId: string;
	fromProjectId: string;
	toProjectId: string;
}

/**
 * Move every `cases` row of `appId` from `fromProjectId` to `toProjectId`,
 * returning the number of rows moved. Scoped to the source Project, so a re-run
 * after a completed move matches zero rows — idempotent, which the cross-store
 * move saga relies on when retrying a partial failure. A `from === to` call is
 * a no-op.
 */
export async function retenantAppCases(
	args: RetenantArgs,
): Promise<{ moved: number }> {
	const db = await getCaseStoreDatabase();
	return retenantAppCasesOn(db, args);
}

/**
 * `db`-injectable core of {@link retenantAppCases}, for the testcontainer
 * harness (which constructs its own `Kysely<Database>`). A single statement —
 * no transaction, mirroring `dropSchema`'s single DELETE.
 */
export async function retenantAppCasesOn(
	db: Kysely<Database>,
	args: RetenantArgs,
): Promise<{ moved: number }> {
	if (args.fromProjectId === args.toProjectId) return { moved: 0 };
	const result = await db
		.updateTable("cases")
		.set({ project_id: args.toProjectId })
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.fromProjectId)
		.executeTakeFirst();
	return { moved: Number(result?.numUpdatedRows ?? 0) };
}
