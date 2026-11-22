import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	type AssignmentDirectoryQuery,
	type NamedAssignee,
	type RowAssignee,
	rowAssigneeSchema,
	rowAssigneesSchema,
} from "./assignmentVocabulary";
import { LookupError } from "./errors";
export interface LocalWorkerScope {
	appId: string;
	/** A real installation gets every private table from the destination restore. */
	remoteAssignments?: boolean;
	personaUuid?: string;
	primaryPlace?: string;
}
function invalid(): never {
	throw new LookupError(
		"invalid_input",
		"One of these workers, groups or places is no longer available. You can refresh the list and choose again.",
	);
}

/** HQ's LookupTableRowManager.iter_by_user grants by direct worker, membership of
 * any group, or ancestors of the primary place. Additional places and descendants
 * belong to case restore; neither is admitted here. EXISTS preserves one row. */
export function workerRowPredicate(
	projectId: string,
	worker: LocalWorkerScope,
) {
	return sql<boolean>`EXISTS (
		SELECT 1 FROM lookup_row_assignments a
		WHERE (a.project_id,a.table_id,a.row_id)=(lookup_rows.project_id,lookup_rows.table_id,lookup_rows.id)
		AND ${worker.personaUuid ?? null}::uuid IS NOT NULL AND (
		  (a.kind='worker' AND a.app_id=${worker.appId} AND a.principal_id=${worker.personaUuid ?? null}::uuid)
		  OR (a.kind='group' AND a.principal_id IN (SELECT m.group_id FROM worker_group_members m WHERE m.project_id=${projectId}
		        AND m.app_id=${worker.appId} AND m.persona_id=${worker.personaUuid ?? null}::uuid))
		  OR (a.kind='place' AND a.app_id=${worker.appId} AND a.principal_id IN (
		    WITH RECURSIVE path(id,parent_id) AS (
		      SELECT id,parent_id FROM app_locations WHERE app_id=${worker.appId} AND id=${worker.primaryPlace ?? null}::uuid AND archived_at IS NULL
		      UNION SELECT p.id,p.parent_id FROM app_locations p JOIN path ON path.parent_id=p.id
		        WHERE p.app_id=${worker.appId} AND p.archived_at IS NULL
		    ) SELECT id FROM path))
		))`;
}

/** The caller holds the Project and owning table locks. Verify every proposed
 * principal against its current Project before replacing the prior set. */
export async function replaceRowAssignments(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
	input: readonly RowAssignee[],
) {
	const parsed = rowAssigneesSchema.safeParse(input);
	if (!parsed.success) invalid();
	const values = parsed.data.map((a) => ({
		kind: a.kind,
		app_id: a.kind === "group" ? null : a.appId,
		principal_id: a.id,
	}));
	const wanted = sql`jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS a(kind text,app_id text,principal_id uuid)`;
	const missing = await sql`SELECT 1 FROM ${wanted}
		WHERE CASE a.kind WHEN 'group' THEN NOT EXISTS(SELECT 1 FROM worker_groups g WHERE g.project_id=${projectId} AND g.id=a.principal_id)
		WHEN 'place' THEN NOT EXISTS(SELECT 1 FROM apps JOIN app_locations p ON p.app_id=apps.id WHERE apps.project_id=${projectId}
			AND apps.deleted_at IS NULL AND p.app_id=a.app_id AND p.id=a.principal_id AND p.archived_at IS NULL)
		ELSE NOT EXISTS (SELECT 1 FROM apps JOIN blueprint_entities p ON p.app_id=apps.id WHERE apps.project_id=${projectId}
			AND apps.deleted_at IS NULL AND p.app_id=a.app_id AND p.kind='persona' AND p.uuid=a.principal_id) END LIMIT 1`.execute(
		tx,
	);
	if (missing.rows.length) invalid();
	const row = await tx
		.selectFrom("lookup_rows")
		.select("id")
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.where("id", "=", rowId)
		.executeTakeFirst();
	if (!row)
		throw new LookupError(
			"not_found",
			"This row is no longer available. You can refresh the table.",
		);
	const removed =
		await sql`DELETE FROM lookup_row_assignments stored WHERE project_id=${projectId} AND table_id=${tableId} AND row_id=${rowId}
		AND NOT EXISTS (SELECT 1 FROM ${wanted} WHERE a.kind=stored.kind AND a.app_id IS NOT DISTINCT FROM stored.app_id AND a.principal_id=stored.principal_id)`.execute(
			tx,
		);
	const inserted =
		await sql`INSERT INTO lookup_row_assignments(project_id,table_id,row_id,kind,app_id,principal_id)
		SELECT DISTINCT ${projectId},${tableId}::uuid,${rowId}::uuid,kind,app_id,principal_id FROM ${wanted} ON CONFLICT DO NOTHING`.execute(
			tx,
		);
	return Boolean(removed.numAffectedRows || inserted.numAffectedRows);
}

/** Authoring-only directory. Local UUIDs are always accompanied by their
 * kind and application. Two adopted apps can have the same persona UUID. */
function directory(projectId: string) {
	return sql`SELECT 'worker' AS kind,e.app_id,e.uuid AS id,e.data->>'name' AS name,b.app_name
	FROM blueprint_entities e JOIN apps b ON b.id=e.app_id
	WHERE b.project_id=${projectId} AND b.deleted_at IS NULL AND e.kind='persona'
	UNION ALL SELECT 'place',p.app_id,p.id,p.name,b.app_name FROM app_locations p JOIN apps b ON b.id=p.app_id
	WHERE b.project_id=${projectId} AND b.deleted_at IS NULL AND p.archived_at IS NULL
	UNION ALL SELECT 'group',NULL,g.id,g.name,NULL FROM worker_groups g WHERE g.project_id=${projectId}`;
}
type DirectoryRow = {
	kind: "worker" | "place" | "group";
	app_id: string | null;
	id: string;
	name: string | null;
	app_name: string | null;
};
function display(row: DirectoryRow): NamedAssignee {
	const principal = rowAssigneeSchema.parse(
		row.kind === "group"
			? { kind: row.kind, id: row.id }
			: { kind: row.kind, id: row.id, appId: row.app_id },
	);
	return {
		principal,
		name: row.name ?? `Unavailable ${row.kind}`,
		appName: row.app_name,
	};
}
export async function searchAssignmentDirectory(
	tx: Transaction<AppDatabase>,
	projectId: string,
	query: AssignmentDirectoryQuery,
) {
	const offset = query.offset ?? 0;
	const result =
		await sql<DirectoryRow>`SELECT * FROM (${directory(projectId)}) d
		WHERE (${query.kind ?? null}::text IS NULL OR kind=${query.kind ?? null}) AND strpos(lower(name),lower(${query.query ?? ""}))>0
		ORDER BY name COLLATE "C",kind,app_id COLLATE "C" NULLS FIRST,id LIMIT 51 OFFSET ${offset}`.execute(
			tx,
		);
	return {
		choices: result.rows.slice(0, 50).map(display),
		nextOffset: result.rows.length > 50 ? offset + 50 : null,
	};
}
export async function readRowAssignments(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
) {
	const result =
		await sql<DirectoryRow>`SELECT a.kind,a.app_id,a.principal_id AS id,d.name,d.app_name
	FROM lookup_row_assignments a LEFT JOIN (${directory(projectId)}) d ON a.kind=d.kind AND a.app_id IS NOT DISTINCT FROM d.app_id AND a.principal_id=d.id
	WHERE a.project_id=${projectId} AND a.table_id=${tableId} AND a.row_id=${rowId}
	ORDER BY d.name COLLATE "C",a.kind,a.app_id COLLATE "C" NULLS FIRST,a.principal_id`.execute(
			tx,
		);
	return result.rows.map(display);
}
