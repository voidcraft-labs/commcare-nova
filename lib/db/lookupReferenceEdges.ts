import { type Kysely, sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type LookupReferenceTargetSet,
	normalizeLookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import {
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";

/** A caller-owned handle for package-private edge scans; opens no transaction. */
export type LookupReferenceReadExecutor =
	| Kysely<AppDatabase>
	| Transaction<AppDatabase>;

interface StoredLookupReferenceTargetRow {
	target_kind: "table" | "column";
	project_id: string;
	table_id: string;
	column_id: string | null;
}

export type LookupReferenceWriteErrorCode = "unavailable" | "mismatch";

/**
 * Internal, IDOR-opaque rejection used to abort an authoritative app writer.
 * Missing and foreign resources deliberately share the `unavailable` shape;
 * neither identifiers nor Project ids are included in the message.
 */
export class LookupReferenceWriteError extends Error {
	readonly name = "LookupReferenceWriteError";

	constructor(readonly code: LookupReferenceWriteErrorCode) {
		super(
			code === "unavailable"
				? "Lookup reference targets are unavailable."
				: "Lookup reference targets do not match the app scope.",
		);
	}
}

function throwUnavailable(): never {
	throw new LookupReferenceWriteError("unavailable");
}

function throwMismatch(): never {
	throw new LookupReferenceWriteError("mismatch");
}

/**
 * Lock every requested Project-scoped lookup table in canonical UUID order.
 *
 * The app row must already be locked. `FOR KEY SHARE` prevents table identity
 * deletion/movement while still allowing concurrent readers. Definition
 * writers take the same table row `FOR UPDATE`, so this lock also freezes the
 * table's column/projection definition until the app write commits. Missing and
 * foreign table ids are intentionally indistinguishable.
 */
export async function lockLookupTablesForReferenceWrite(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableIds: Iterable<LookupTableId>,
): Promise<void> {
	const canonicalIds = normalizeLookupReferenceTargetSet({ tableIds }).tableIds;
	if (canonicalIds.length === 0) return;

	const rows = await tx
		.selectFrom("lookup_tables")
		.select("id")
		.where("project_id", "=", projectId)
		.where("id", "in", [...canonicalIds])
		.orderBy("id", "asc")
		.forKeyShare()
		.execute();

	if (rows.length !== canonicalIds.length) throwUnavailable();
	for (let index = 0; index < canonicalIds.length; index += 1) {
		const row = rows[index];
		const parsed = row ? lookupTableIdSchema.safeParse(row.id) : null;
		if (!parsed?.success || parsed.data !== canonicalIds[index]) {
			throwUnavailable();
		}
	}
}

/**
 * Read the complete stored target set for an app, across every Project.
 *
 * There is deliberately no Project predicate: exact replacement and the move
 * admission check must see (and be able to clear) stale source-Project edges.
 * App writers already hold the app row lock; read-only scanners may pass their
 * own Kysely handle because this function assembles the set in one statement.
 */
export async function readStoredLookupReferenceTargets(
	db: LookupReferenceReadExecutor,
	appId: string,
): Promise<LookupReferenceTargetSet> {
	// One statement gives scanners a complete snapshot even when they pass a
	// plain Kysely handle rather than wrapping this read in a transaction.
	const result = await sql<StoredLookupReferenceTargetRow>`
		SELECT
			'table'::text AS target_kind,
			project_id,
			table_id::text AS table_id,
			NULL::text AS column_id
		FROM lookup_table_references
		WHERE app_id = ${appId}
		UNION ALL
		SELECT
			'column'::text AS target_kind,
			project_id,
			table_id::text AS table_id,
			column_id::text AS column_id
		FROM lookup_column_references
		WHERE app_id = ${appId}
		ORDER BY table_id ASC, column_id ASC NULLS FIRST,
			project_id ASC, target_kind ASC
	`.execute(db);

	try {
		return normalizeLookupReferenceTargetSet({
			tableIds: result.rows.flatMap((row) =>
				row.target_kind === "table"
					? [lookupTableIdSchema.parse(row.table_id)]
					: [],
			),
			columnTargets: result.rows.flatMap((row) => {
				if (row.target_kind !== "column") return [];
				if (row.column_id === null) throwMismatch();
				return [
					{
						tableId: lookupTableIdSchema.parse(row.table_id),
						columnId: lookupColumnIdSchema.parse(row.column_id),
					},
				];
			}),
		});
	} catch {
		// Persisted non-v7/cross-shape identities are an internal integrity
		// mismatch. Do not let parser details or stored ids escape the writer.
		throwMismatch();
	}
}

/**
 * Replace both of an app's edge sets from one complete structural target set.
 *
 * This is never a delta API. Deletes are app-wide and child-first so stale
 * source-Project edges are removed; inserts are parent-first in canonical
 * order so every column's implied table edge exists before its column edge.
 * A null/invalid Project may clear to the empty set but can never gain targets.
 */
export async function replaceLookupReferenceEdges(
	tx: Transaction<AppDatabase>,
	args: {
		appId: string;
		projectId: string | null;
		targets: LookupReferenceTargetSet;
	},
): Promise<void> {
	const targets = normalizeLookupReferenceTargetSet(args.targets);
	const hasTargets =
		targets.tableIds.length > 0 || targets.columnTargets.length > 0;
	const targetProjectId =
		typeof args.projectId === "string" && args.projectId.length > 0
			? args.projectId
			: null;

	// Reject before deleting anything so even a caller that catches the typed
	// error inside its transaction cannot accidentally turn a bad replacement
	// into an edge clear.
	if (hasTargets && targetProjectId === null) throwMismatch();
	if (hasTargets) {
		const app = await tx
			.selectFrom("apps")
			.select("id")
			.where("id", "=", args.appId)
			.where("project_id", "=", targetProjectId)
			.executeTakeFirst();
		if (!app) throwMismatch();
	}

	await tx
		.deleteFrom("lookup_column_references")
		.where("app_id", "=", args.appId)
		.execute();
	await tx
		.deleteFrom("lookup_table_references")
		.where("app_id", "=", args.appId)
		.execute();

	if (!hasTargets || targetProjectId === null) return;

	await tx
		.insertInto("lookup_table_references")
		.values(
			targets.tableIds.map((tableId) => ({
				project_id: targetProjectId,
				table_id: tableId,
				app_id: args.appId,
			})),
		)
		.execute();

	if (targets.columnTargets.length > 0) {
		await tx
			.insertInto("lookup_column_references")
			.values(
				targets.columnTargets.map(({ tableId, columnId }) => ({
					project_id: targetProjectId,
					table_id: tableId,
					column_id: columnId,
					app_id: args.appId,
				})),
			)
			.execute();
	}
}
