// lib/case-store/retenant.ts
//
// Reconcile an app's case rows to its Project — the case-store half of moving an
// app between Projects (`lib/db/moveAppToProject.ts`). It is the ONE cross-tenant
// data write in the package: every other read/write is structurally pinned to a
// single bound `project_id` (`withProjectContext`), and `withSchemaContext`'s
// `SchemaCaseStore` exposes only schema ops. A move has to rewrite the structural
// tenant key itself, so it lives here as a deliberate, named, app-scoped
// exception rather than as a `CaseStore` method that would undermine that class's
// single-tenant invariant.
//
// It keys on `app_id` ALONE and targets the app's current Project: the move
// re-tenants cases AFTER the app doc's guarded flip, so the doc is the source of
// truth and the cases follow it wherever it landed. Moving "every row not already
// at the destination" (rather than "every row at a named source") is what makes
// the step idempotent AND self-healing — a crash between the flip and here, or a
// row set left split across Projects by a prior partial move, converges on the
// next run with no source Project to get wrong.
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
	toProjectId: string;
}

/**
 * Move every `cases` row of `appId` that isn't already in `toProjectId` into it,
 * returning the number of rows moved. Idempotent (a re-run after a completed move
 * matches zero rows) and convergent (it pulls in rows a prior partial move left
 * in any other Project), which the cross-store move relies on for crash recovery.
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
	const result = await db
		.updateTable("cases")
		.set({ project_id: args.toProjectId })
		.where("app_id", "=", args.appId)
		// NULL-safe "not already at the destination": SQL `NULL != 'x'` is NULL
		// (not TRUE), so a bare `!=` would silently skip a row whose `project_id`
		// is NULL (the column is nullable). Include those rows explicitly.
		.where((eb) =>
			eb.or([
				eb("project_id", "is", null),
				eb("project_id", "!=", args.toProjectId),
			]),
		)
		.executeTakeFirst();
	return { moved: Number(result?.numUpdatedRows ?? 0) };
}
