import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { RowAssignee } from "./assignmentVocabulary";
import { LookupError } from "./errors";

export interface SourceRowAssignment {
	readonly sourceId: string;
	readonly principals: readonly RowAssignee[];
}

/** The incoming identities come from the independently enumerated inventory,
 * in its native order. A missing or duplicated UID invalidates the entire write,
 * including rows which deliberately have no owners. */
export async function installSourceAssignments(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rows: readonly SourceRowAssignment[],
) {
	const ids = rows.map((row) => row.sourceId);
	const retained = await tx
		.selectFrom("lookup_rows")
		.select("hq_row_id")
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.orderBy("order_key")
		.orderBy("id")
		.limit(ids.length + 1)
		.execute();
	if (
		retained.length !== ids.length ||
		new Set(ids).size !== ids.length ||
		retained.some((r, i) => r.hq_row_id !== ids[i])
	)
		throw new LookupError(
			"conflict",
			"The source row identities changed. You can refresh the table and download a new copy.",
		);
	await sql`DELETE FROM lookup_row_assignments WHERE project_id=${projectId} AND table_id=${tableId}`.execute(
		tx,
	);
	for (let i = 0; i < rows.length; i += 100) {
		const entries = rows
			.slice(i, i + 100)
			.flatMap((row) =>
				row.principals.map((p) => ({
					source: row.sourceId,
					kind: p.kind,
					id: p.id,
					app: p.kind === "group" ? null : p.appId,
				})),
			);
		if (!entries.length) continue;
		await sql`INSERT INTO lookup_row_assignments(project_id,table_id,row_id,kind,principal_id,app_id)
      SELECT ${projectId},${tableId}::uuid,r.id,a.kind,a.id,a.app
      FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) a(source text,kind text,id uuid,app text)
      JOIN lookup_rows r ON r.project_id=${projectId} AND r.table_id=${tableId} AND r.hq_row_id=a.source`.execute(
			tx,
		);
	}
}
