// lib/case-store/retenant.ts
//
// Transaction-injected primitive for changing an app's case-row Project. It is
// deliberately absent from the package barrel: only the app-locked,
// Project-authorized move/recovery transactions in `lib/db/apps.ts` may call it.
// Every ordinary case read/write stays structurally pinned to one bound
// `project_id` through `withProjectContext`.
//
// The true move updates these rows before flipping `apps.project_id`, within the
// same physical transaction. The composite cases→apps FK is deferred, so the
// transaction may cross that intermediate state but cannot commit a split
// placement. Same-Project recovery derives the destination from the freshly
// locked app row and uses this same primitive. The destination is therefore
// never caller-authoritative at a public boundary.
//
// Only `cases` carries `project_id`. `parked_case_values` has no tenant column
// (app-scoped audit), and `case_type_schemas` / `case_indices` key on
// `(app_id, case_type)` / `(case_id, …)` — app-scoped and tenant-free, so their
// rows and the per-`(app, case_type)` partial expression indexes keep covering
// the moved rows unchanged. Re-tenanting `cases` is therefore the whole job.

import type { Kysely } from "kysely";
import type { Database } from "./sql/database";

interface RetenantArgs {
	appId: string;
	toProjectId: string;
}

/**
 * Internal transaction-injected update. Its caller owns the app lock,
 * authorization, fresh destination derivation, and transaction completion.
 */
export async function retenantAppCasesOn(
	db: Kysely<Database>,
	args: RetenantArgs,
): Promise<{ moved: number }> {
	const result = await db
		.updateTable("cases")
		.set({ project_id: args.toProjectId })
		.where("app_id", "=", args.appId)
		.where("project_id", "!=", args.toProjectId)
		.executeTakeFirst();
	return { moved: Number(result?.numUpdatedRows ?? 0) };
}
