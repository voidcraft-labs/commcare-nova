import { type Kysely, sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type LookupReferenceTargetSet,
	normalizeLookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import {
	type LookupColumnId,
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

/** One app that a destructive lookup change would break, named. */
export interface LookupReferencingApp {
	readonly appId: string;
	readonly appName: string;
	/** True when the app is in the trash. A soft-deleted app still holds its
	 *  edges and still blocks the change, so naming it without saying where it
	 *  is would show the author a blocker they cannot find. */
	readonly deleted: boolean;
}

/**
 * The apps whose blueprints reference a lookup table, or one of its columns.
 *
 * This is the confirmation surface's read, and it is deliberately ADVISORY:
 * the authority is the transactional edge check inside
 * `applyLookupSchemaGovernanceInTransaction`, which re-proves zero edges under
 * the table lock. This read exists so an author is told which apps a
 * destructive change would break BEFORE they ask for it, rather than being
 * refused afterwards with a list of opaque ids.
 *
 * Naming the apps leaks nothing across tenants. `replaceLookupReferenceEdges`
 * only writes an edge whose app sits in the edge's own Project, so every row
 * matching a `(project_id, table_id)` belongs to an app in that Project — and
 * the caller has already been authorized against exactly that Project.
 *
 * Passing a `columnId` narrows to that column's edges; omitting it reads the
 * table's. The two are separate sets on purpose: removing a column is blocked
 * only by apps that reference THAT column, while deleting the table is blocked
 * by any app that references the table at all.
 */
export async function readLookupReferencingApps(
	db: LookupReferenceReadExecutor,
	args: {
		projectId: string;
		tableId: LookupTableId;
		columnId?: LookupColumnId;
	},
): Promise<LookupReferencingApp[]> {
	const edges =
		args.columnId === undefined
			? db
					.selectFrom("lookup_table_references")
					.where("project_id", "=", args.projectId)
					.where("table_id", "=", args.tableId)
					.select("app_id")
			: db
					.selectFrom("lookup_column_references")
					.where("project_id", "=", args.projectId)
					.where("table_id", "=", args.tableId)
					.where("column_id", "=", args.columnId)
					.select("app_id");

	/* The Project predicate is on BOTH sides deliberately. The edge subquery
	 * already scopes to this Project, and an app carrying edges cannot move
	 * Projects — the move refuses a nonempty lookup closure — so the outer
	 * filter is redundant today. It stays because "redundant" there rests on a
	 * rule enforced in another module: a tenancy boundary that holds only by a
	 * two-hop argument is one edit away from holding by nothing. It also makes
	 * this query the same shape as the refusal-naming query in
	 * `lib/lookup/actions.ts`, so the two cannot answer the same question with
	 * different tenancy. */
	const rows = await db
		.selectFrom("apps")
		.where("apps.project_id", "=", args.projectId)
		.where("apps.id", "in", edges)
		.select(["apps.id", "apps.app_name", "apps.deleted_at"])
		.orderBy("apps.app_name", "asc")
		.orderBy("apps.id", "asc")
		.execute();

	return rows.map((row) => ({
		appId: row.id,
		appName: row.app_name,
		deleted: row.deleted_at !== null,
	}));
}

/**
 * Replace both of an app's edge sets from one complete structural target set.
 *
 * This is never a delta API. Deletes are app-wide and child-first so stale
 * source-Project edges are removed; inserts are parent-first in canonical
 * order so every column's implied table edge exists before its column edge.
 * The app's required Project is part of every replacement, including an empty
 * target set.
 */
export async function replaceLookupReferenceEdges(
	tx: Transaction<AppDatabase>,
	args: {
		appId: string;
		projectId: string;
		targets: LookupReferenceTargetSet;
	},
): Promise<void> {
	const targets = normalizeLookupReferenceTargetSet(args.targets);
	const hasTargets =
		targets.tableIds.length > 0 || targets.columnTargets.length > 0;

	if (hasTargets) {
		const app = await tx
			.selectFrom("apps")
			.select("id")
			.where("id", "=", args.appId)
			.where("project_id", "=", args.projectId)
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

	if (!hasTargets) return;

	await tx
		.insertInto("lookup_table_references")
		.values(
			targets.tableIds.map((tableId) => ({
				project_id: args.projectId,
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
					project_id: args.projectId,
					table_id: tableId,
					column_id: columnId,
					app_id: args.appId,
				})),
			)
			.execute();
	}
}
