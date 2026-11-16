import "server-only";

import { type Kysely, sql, type Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { HAND_BACK_OVERTAKEN } from "@/lib/publish/managedData";
import { createTable, type LookupTableOriginColumns } from "./authoringBatch";
import { validateLookupRowValues } from "./coercion";
import {
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_TABLE_BYTES,
} from "./constants";
import { LookupError } from "./errors";
import { formatLookupBytes, formatLookupBytesOverCap } from "./format";
import {
	columnLabelFor,
	type LookupRowsMeasure,
	lookupCapExcess,
	type ManagedLookupContent,
	managedCanonicalSchema,
	managedLookupCapRefusal,
} from "./managedRules";
import { balancedKeysBetween } from "./orderKeys";
import {
	hasUnpairedUtf16Surrogate,
	lookupRowValuesSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
	parseLookupRevision,
} from "./schema";
import type {
	LookupAuthoringBatchReceipt,
	LookupColumn,
	LookupReferencingAppSummary,
	LookupRowValues,
	LookupScope,
	LookupTableRevisions,
} from "./types";
import {
	advanceLookupProjectRevision,
	lockLookupProjectState,
	lockLookupTableForUpdate,
	lookupTableRevisions,
	notifyCommittedLookupMutation,
	updateLockedLookupTable,
} from "./writerTransaction";

/**
 * The two writers of a lookup table CommCare HQ manages, and the measure the
 * caps of such a table need.
 *
 * A managed table is a copy: every column is text, its rows are CommCare
 * HQ's in CommCare HQ's order, and its origin columns name the project space
 * it came from. The create arm makes copies under the ids derived for them;
 * the refresh arm makes a copy hold CommCare HQ's content again, or makes a
 * Project table CommCare HQ's copy. Both run under the lookup lock order
 * (`writerTransaction.ts`), advance the Project revision once and notify
 * once, and only where something a client reads changed.
 */

export type { ManagedLookupContent } from "./managedRules";

/** Where a copy comes from, written into its origin columns. */
export interface ManagedOriginWrite {
	readonly server: string;
	readonly domain: string;
	readonly remoteId: string;
	/** `canonicalLookupTable(table, rows)`. */
	readonly canonical: Readonly<Record<string, unknown>>;
}

/**
 * Which table and columns a tag's fields are bound to. The same shape as the
 * reading's `LookupTableBinding`, declared here because `lib/lookup` imports
 * nothing of `lib/deployment`.
 */
export interface ManagedLookupTableBinding {
	readonly tag: string;
	readonly tableId: LookupTableId;
	/** Field name to the column that holds it. */
	readonly columns: Readonly<Record<string, LookupColumnId>>;
}

export interface ManagedRefreshReceipt extends LookupTableRevisions {
	/**
	 * What the refresh did to the copy. `superseded`: nothing, because a
	 * newer read of CommCare HQ's table, or a hand-back, landed while this
	 * one was being read (`olderReadYields`).
	 */
	readonly changed: "nothing" | "rows" | "definition" | "superseded";
	readonly addedColumns: readonly {
		readonly id: LookupColumnId;
		readonly wireName: string;
	}[];
	/** Wire names of the columns the refresh removed. */
	readonly removedColumns: readonly string[];
	/**
	 * Columns CommCare HQ no longer has that stay because an app reads them.
	 * Listed by a refresh that changed the copy; one that found CommCare HQ's
	 * table as it was lists none.
	 */
	readonly keptGoneColumns: readonly {
		readonly id: LookupColumnId;
		readonly wireName: string;
		readonly apps: readonly LookupReferencingAppSummary[];
	}[];
}

function invalid(message: string): never {
	throw new LookupError("invalid_input", message);
}

function assertWriter(scope: LookupScope): void {
	if (
		typeof scope.projectId !== "string" ||
		scope.projectId.length === 0 ||
		typeof scope.actorId !== "string" ||
		scope.actorId.length === 0 ||
		typeof scope.role !== "string" ||
		scope.role.length === 0
	) {
		throw new Error("A managed lookup table writer received an invalid scope.");
	}
	if (!roleAllowsApp(scope.role, "edit")) {
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
}

/** The content's fields, each a wire name Nova takes, none repeated. */
function checkContent(tag: string, content: ManagedLookupContent): void {
	if (content.fields.length === 0) {
		invalid(`The lookup table ${tag} has no fields, so Nova can't hold it.`);
	}
	const seen = new Set<string>();
	for (const field of content.fields) {
		const parsed = lookupWireNameSchema.safeParse(field);
		if (!parsed.success) {
			invalid(
				`The field ${field} of the lookup table ${tag} can't be a column: ${parsed.error.issues[0]?.message ?? "its name is not one Nova takes."}`,
			);
		}
		if (seen.has(field)) {
			invalid(`The lookup table ${tag} names the field ${field} twice.`);
		}
		seen.add(field);
	}
}

function checkOrigin(origin: ManagedOriginWrite): void {
	if (
		origin.server.trim() === "" ||
		origin.domain.trim() === "" ||
		origin.remoteId.trim() === ""
	) {
		throw new Error(
			"A managed lookup table's origin needs every one of its names.",
		);
	}
	managedCanonicalSchema.parse(origin.canonical);
}

/** CommCare HQ's rows keyed by the columns that hold their fields; a missing cell stays missing. */
function rowValuesFor(
	content: ManagedLookupContent,
	columnIdOf: ReadonlyMap<string, LookupColumnId>,
): LookupRowValues[] {
	return content.rows.map((row) => {
		const values: LookupRowValues = {};
		for (const field of content.fields) {
			if (!Object.hasOwn(row, field)) continue;
			const columnId = columnIdOf.get(field);
			if (columnId === undefined) {
				/* By its place, never its name (layer 7's small edit, kept for the rebase). */
				throw new Error(
					`No column holds the table's field ${content.fields.indexOf(field) + 1}.`,
				);
			}
			values[columnId] = row[field];
		}
		return values;
	});
}

/** Every cell checked as a text column takes it: no NUL, no lone surrogate, at most 64 KiB. */
function checkCells(
	tag: string,
	columns: readonly LookupColumn[],
	rows: readonly LookupRowValues[],
): void {
	for (const values of rows) {
		const result = validateLookupRowValues(columns, values);
		if (!result.success) {
			throw new LookupError(
				"invalid_input",
				`A row of the lookup table ${tag} holds a value Nova can't store.`,
				{ details: result.issues, totalDetailCount: result.totalIssueCount },
			);
		}
	}
}

async function measureWith(
	db: Kysely<AppDatabase>,
	rows: readonly LookupRowValues[],
): Promise<LookupRowsMeasure> {
	if (rows.length === 0) return { dataBytes: 0, largestRowBytes: 0 };
	for (const row of rows) {
		for (const value of Object.values(row)) {
			if (
				typeof value === "string" &&
				(value.includes("\0") || hasUnpairedUtf16Surrogate(value))
			) {
				invalid(
					"A lookup row holds a character Postgres can't store, so its size can't be measured.",
				);
			}
		}
	}
	const result = await sql<{ largest_row_bytes: string; data_bytes: string }>`
		SELECT coalesce(max(octet_length(v::jsonb::text)), 0)::bigint::text AS largest_row_bytes,
			coalesce(sum(octet_length(v::jsonb::text)), 0)::bigint::text AS data_bytes
		FROM unnest(${rows.map((row) => JSON.stringify(row))}::text[]) AS t(v)
	`.execute(db);
	const measured = result.rows[0];
	if (measured === undefined) {
		throw new Error("Measuring lookup rows returned no row.");
	}
	return {
		dataBytes: Number(measured.data_bytes),
		largestRowBytes: Number(measured.largest_row_bytes),
	};
}

/**
 * The largest candidate row's stored size and the rows' sum, measured by
 * Postgres, writing nothing. Each row is keyed by column id, as it would be
 * stored; `octet_length(v::jsonb::text)` is the expression of the generated
 * column `lookup_rows.value_bytes`. A row holding NUL or a lone surrogate has
 * no stored form and is refused as `invalid_input`.
 */
export async function measureLookupRows(
	rows: readonly LookupRowValues[],
): Promise<LookupRowsMeasure> {
	return measureWith(await getAppDb(), rows);
}

/** The caps, judged before anything is written; `storage_limit` names each one the table is over. */
async function holdCaps(
	tx: Transaction<AppDatabase>,
	tag: string,
	content: ManagedLookupContent,
	rows: readonly LookupRowValues[],
): Promise<void> {
	const excess = lookupCapExcess(content, await measureWith(tx, rows));
	if (excess.length > 0) {
		throw new LookupError(
			"storage_limit",
			managedLookupCapRefusal(tag, excess),
		);
	}
}

function storageFloor(tag: string, dataBytes: number): never {
	throw new LookupError(
		"storage_limit",
		managedLookupCapRefusal(tag, [
			`${formatLookupBytesOverCap(dataBytes)} of rows (Nova takes ${formatLookupBytes(LOOKUP_MAX_TABLE_BYTES)} in one table)`,
		]),
	);
}

/** A row over the stored-row CHECK is the same cap the measure judged, met at the insert. */
function translateRowCheck(tag: string, error: unknown): never {
	const shape = error as { code?: unknown; constraint?: unknown };
	if (
		shape.code === "23514" &&
		shape.constraint === "lookup_rows_value_bytes_check"
	) {
		throw new LookupError(
			"storage_limit",
			managedLookupCapRefusal(tag, [
				`a row over ${formatLookupBytes(LOOKUP_MAX_ROW_BYTES)} (Nova takes ${formatLookupBytes(LOOKUP_MAX_ROW_BYTES)} in one row)`,
			]),
			{ cause: error },
		);
	}
	throw error;
}

function originColumns(
	scope: LookupScope,
	origin: ManagedOriginWrite,
	at: Date,
): LookupTableOriginColumns {
	return {
		hq_server: origin.server,
		hq_domain: origin.domain,
		hq_remote_id: origin.remoteId,
		hq_canonical: JSON.stringify(origin.canonical),
		hq_brought_in_at: at,
		hq_brought_in_by: scope.actorId,
		hq_refreshed_at: at,
		hq_refreshed_by: scope.actorId,
	};
}

function textColumn(id: LookupColumnId, wireName: string): LookupColumn {
	return { id, wireName, label: columnLabelFor(wireName), dataType: "text" };
}

/**
 * Create tables that CommCare HQ manages, with the ids derived for them. One
 * revision, one notice. Each table is named `name`, every column is text with
 * its field's name as its wire name and `columnLabelFor` of it as its label,
 * and the origin lands in the table's insert. A tag the Project already holds
 * is `tag_taken`, and nothing of the call stays.
 */
export async function createManagedLookupTablesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	tables: readonly {
		readonly binding: ManagedLookupTableBinding;
		readonly name: string;
		readonly content: ManagedLookupContent;
		readonly origin: ManagedOriginWrite;
	}[],
	at: Date,
): Promise<LookupAuthoringBatchReceipt> {
	assertWriter(scope);
	if (tables.length === 0) {
		throw new Error("Creating managed lookup tables needs at least one table.");
	}
	const tags = new Set<string>();
	const tableIds = new Set<string>();
	const prepared = tables.map(({ binding, name, content, origin }) => {
		const tag = binding.tag;
		const tagCheck = lookupTagSchema.safeParse(tag);
		if (!tagCheck.success) {
			invalid(
				`${tag} can't be a lookup table's tag: ${tagCheck.error.issues[0]?.message ?? "it is not one Nova takes."}`,
			);
		}
		const nameCheck = lookupTableNameSchema.safeParse(name);
		if (!nameCheck.success || nameCheck.data !== name) {
			invalid(`${name} can't be the name of the lookup table ${tag}.`);
		}
		if (tags.has(tag)) {
			throw new LookupError(
				"tag_taken",
				`Table tag "${tag}" appears more than once in this authoring batch.`,
			);
		}
		tags.add(tag);
		const tableId = lookupTableIdSchema.parse(binding.tableId);
		if (tableIds.has(tableId)) {
			throw new Error("Two managed lookup tables were bound to one table id.");
		}
		tableIds.add(tableId);
		checkContent(tag, content);
		checkOrigin(origin);
		const columnIdOf = new Map<string, LookupColumnId>();
		const columnIds = new Set<string>();
		for (const field of content.fields) {
			const id = Object.hasOwn(binding.columns, field)
				? binding.columns[field]
				: undefined;
			/* These name the table by its id and a field by its place, never by a tag or a
			 * field name, which are the app's words: a bring-in's failed line carries this
			 * message to Sentry (layer 7's small edit, kept for the rebase). */
			if (id === undefined) {
				throw new Error(
					`The binding of the lookup table ${tableId} names no column for its field ${content.fields.indexOf(field) + 1}.`,
				);
			}
			const columnId = lookupColumnIdSchema.parse(id);
			if (columnIds.has(columnId)) {
				throw new Error(
					`The binding of the lookup table ${tableId} gives two fields one column.`,
				);
			}
			columnIds.add(columnId);
			columnIdOf.set(field, columnId);
		}
		const columns = content.fields.map((field, index) => {
			const id = columnIdOf.get(field);
			if (id === undefined) {
				throw new Error(`No column holds the table's field ${index + 1}.`);
			}
			return textColumn(id, field);
		});
		const rows = rowValuesFor(content, columnIdOf);
		return { tag, name, tableId, content, origin, columns, rows };
	});
	// The caps first, so a cell or row over one is refused with its phrase;
	// the cells' own check then finds nothing a cap does not name.
	for (const table of prepared) {
		await holdCaps(tx, table.tag, table.content, table.rows);
		checkCells(table.tag, table.columns, table.rows);
	}

	const projectState = await lockLookupProjectState(tx, scope.projectId);
	const taken = await tx
		.selectFrom("lookup_tables")
		.select("tag")
		.where("project_id", "=", scope.projectId)
		.where("tag", "in", [...tags])
		.orderBy("tag")
		.executeTakeFirst();
	if (taken !== undefined) {
		throw new LookupError(
			"tag_taken",
			`Table tag "${taken.tag}" is already used in this Project.`,
		);
	}
	const nextRevision = parseLookupRevision(
		(BigInt(projectState.revision) + BigInt(1)).toString(),
	);
	const receipts = [];
	for (const table of prepared) {
		try {
			receipts.push(
				await createTable(
					tx,
					scope,
					nextRevision,
					{
						key: table.tag,
						name: table.name,
						tag: table.tag,
						columns: table.columns.map((column) => ({
							key: column.wireName,
							wireName: column.wireName,
							label: column.label,
							dataType: column.dataType,
						})),
						rows: table.content.rows.map((row, index) => ({
							key: `row-${index}`,
							cells: table.content.fields.flatMap((field) =>
								Object.hasOwn(row, field)
									? [{ columnKey: field, value: row[field] }]
									: [],
							),
						})),
					},
					{
						tableId: table.tableId,
						columnIds: table.columns.map((column) => column.id),
					},
					originColumns(scope, table.origin, at),
				),
			);
		} catch (error) {
			translateRowCheck(table.tag, error);
		}
	}
	const projectRevision = await advanceLookupProjectRevision(
		tx,
		scope.projectId,
	);
	if (projectRevision !== nextRevision) {
		throw new Error(
			"Lookup Project revision did not advance to the predicted value.",
		);
	}
	await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
	return { projectRevision, tables: receipts };
}

/** The apps a column's reference edges name, as a blocked removal names them. */
async function appsReadingColumn(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId,
): Promise<LookupReferencingAppSummary[]> {
	const rows = await tx
		.selectFrom("apps")
		.select(["id", "app_name", "deleted_at"])
		.where("project_id", "=", projectId)
		.where("id", "in", (eb) =>
			eb
				.selectFrom("lookup_column_references")
				.select("app_id")
				.where("project_id", "=", projectId)
				.where("table_id", "=", tableId)
				.where("column_id", "=", columnId),
		)
		.orderBy("app_name", "asc")
		.orderBy("id", "asc")
		.limit(100)
		.execute();
	return rows.map((row) => ({
		appId: row.id,
		appName: row.app_name,
		deleted: row.deleted_at !== null,
	}));
}

/**
 * By table id, the ids of each table's columns that an app's reference edge
 * names or an accepted design protects (that column, or its whole table), in
 * each table's column order: the columns the refresh keeps, in both its modes,
 * where CommCare HQ's fields lack them. A table with none is absent. The one
 * home of that rule: the refresh reads it under its table lock, and a bring-in's
 * review reads it to count the columns a refresh would keep. Takes no lock.
 */
export async function readKeptLookupColumnIds(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	projectId: string,
	tableIds: readonly string[],
): Promise<Readonly<Record<string, readonly string[]>>> {
	if (tableIds.length === 0) return {};
	const ids = tableIds.map((tableId) => lookupTableIdSchema.parse(tableId));
	const rows = await db
		.selectFrom("lookup_columns as column")
		.select(["column.table_id", "column.id"])
		.where("column.project_id", "=", projectId)
		.where("column.table_id", "in", ids)
		.where((eb) =>
			eb.or([
				eb.exists(
					eb
						.selectFrom("lookup_column_references as edge")
						.innerJoin("apps as app", "app.id", "edge.app_id")
						.select("edge.app_id")
						.where("edge.project_id", "=", projectId)
						.where("app.project_id", "=", projectId)
						.whereRef("edge.table_id", "=", "column.table_id")
						.whereRef("edge.column_id", "=", "column.id"),
				),
				eb.exists(
					eb
						.selectFrom("design_lookup_protections as protection")
						.select("protection.id")
						.where("protection.project_id", "=", projectId)
						.whereRef("protection.table_id", "=", "column.table_id")
						.where((inner) =>
							inner.or([
								inner("protection.column_id", "is", null),
								inner("protection.column_id", "=", inner.ref("column.id")),
							]),
						),
				),
			]),
		)
		.orderBy("column.table_id", "asc")
		.orderBy("column.order_key", "asc")
		.orderBy("column.id", "asc")
		.execute();
	const kept = new Map<string, string[]>();
	for (const row of rows) {
		const columns = kept.get(row.table_id) ?? [];
		columns.push(row.id);
		kept.set(row.table_id, columns);
	}
	return Object.fromEntries(kept);
}

function sameValues(left: LookupRowValues, right: LookupRowValues): boolean {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key, index) =>
				key === rightKeys[index] &&
				left[key as LookupColumnId] === right[key as LookupColumnId],
		)
	);
}

/**
 * Make the copy hold CommCare HQ's columns and rows.
 *
 * `refresh`: the table is managed in CommCare HQ from `origin`'s server and
 * domain already; any other state is `conflict` (someone chose Manage in Nova
 * meanwhile), and an equal digest from the same remote table stamps the
 * refresh and changes nothing else. A refresh that changes which columns read
 * as gone from CommCare HQ changes the definition, as an added or removed
 * column does. `adopt`: the table becomes CommCare HQ's
 * copy, so every column is set to text, a takeover is cleared and the
 * definition is stamped, because every client reads who manages a table from
 * it. A table CommCare HQ manages from another project space is `conflict`.
 *
 * Columns match fields by wire name. A field with no column adds a text
 * column; a column with no field is removed unless an app's reference edge or
 * an accepted design names it, and then stays, empty, after CommCare HQ's
 * columns. The rows are replaced by CommCare HQ's when they differ.
 *
 * `at` is when the read of CommCare HQ began. No lock spans that read, so
 * two refreshes can read in one order and commit in the other. Where
 * `olderReadYields`, a refresh whose read began before the table's stored
 * `hq_refreshed_at` (a newer refresh or hand-back) writes nothing and answers
 * `superseded`, and a hand-back whose read began before a Manage in Nova
 * recorded since is `conflict`, so an older read of CommCare HQ never
 * replaces a newer one or a later decision, the rule
 * `lib/deployment/store.ts::recordRefreshedAppBaseline` keeps for an app's
 * baseline.
 */
export async function refreshManagedLookupTableInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	input: {
		readonly tableId: LookupTableId;
		readonly content: ManagedLookupContent;
		readonly origin: ManagedOriginWrite;
		readonly at: Date;
		/** `refresh`: the table is managed in CommCare HQ already. `adopt`: it becomes so. */
		readonly mode: "refresh" | "adopt";
		/**
		 * Whether a read that began before the table's last refresh, hand-back
		 * or takeover writes nothing (true for a publish's re-read, Refresh and
		 * the hand-back). A birth passes false: its columns bind the ids the
		 * reading gave them, so it writes what the reading read.
		 */
		readonly olderReadYields: boolean;
		/** Column ids for fields the table has no column for; minted where absent. */
		readonly newColumnIds?: Readonly<Record<string, LookupColumnId>>;
	},
): Promise<ManagedRefreshReceipt> {
	assertWriter(scope);
	const tableId = lookupTableIdSchema.parse(input.tableId);
	const { content, origin, at, mode } = input;
	checkOrigin(origin);
	const canonical = managedCanonicalSchema.parse(origin.canonical);
	await lockLookupProjectState(tx, scope.projectId);
	const table = await lockLookupTableForUpdate(
		tx,
		scope.projectId,
		tableId,
		null,
		mode === "refresh" ? "hq-refresh" : "hq-management",
	);
	const managedInHq =
		table.hq_server !== null && table.hq_taken_over_at === null;
	const sameOrigin =
		table.hq_server === origin.server && table.hq_domain === origin.domain;
	if (mode === "refresh" && !(managedInHq && sameOrigin)) {
		throw new LookupError(
			"conflict",
			`The lookup table ${table.tag} isn't managed in CommCare HQ (${origin.domain}) any more, so there was nothing to refresh.`,
		);
	}
	if (mode === "adopt" && managedInHq && !sameOrigin) {
		throw new LookupError(
			"conflict",
			`The lookup table ${table.tag} is managed in CommCare HQ (${table.hq_domain ?? ""}), so it can't come from ${origin.domain} too.`,
		);
	}
	if (input.olderReadYields) {
		if (table.hq_taken_over_at !== null && table.hq_taken_over_at > at) {
			throw new LookupError("conflict", HAND_BACK_OVERTAKEN);
		}
		if (table.hq_refreshed_at !== null && table.hq_refreshed_at > at) {
			return {
				changed: "superseded",
				addedColumns: [],
				removedColumns: [],
				keptGoneColumns: [],
				...lookupTableRevisions(table),
			};
		}
	}
	checkContent(table.tag, content);

	if (
		mode === "refresh" &&
		managedCanonicalSchema.parse(table.hq_canonical).digest ===
			canonical.digest &&
		table.hq_remote_id === origin.remoteId
	) {
		const stamped = await updateLockedLookupTable(
			tx,
			scope.projectId,
			tableId,
			{ hq_refreshed_at: at, hq_refreshed_by: scope.actorId },
		);
		return {
			changed: "nothing",
			addedColumns: [],
			removedColumns: [],
			keptGoneColumns: [],
			...lookupTableRevisions(stamped),
		};
	}

	const stored = await tx
		.selectFrom("lookup_columns")
		.selectAll()
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", tableId)
		.orderBy("order_key", "asc")
		.orderBy("id", "asc")
		.execute();
	const fieldSet = new Set(content.fields);
	const byWireName = new Map(
		stored.map((column) => [column.wire_name, column]),
	);

	const removed: typeof stored = [];
	const kept: {
		column: (typeof stored)[number];
		apps: LookupReferencingAppSummary[];
	}[] = [];
	const keptIds = new Set(
		(await readKeptLookupColumnIds(tx, scope.projectId, [tableId]))[tableId] ??
			[],
	);
	for (const column of stored) {
		if (fieldSet.has(column.wire_name)) continue;
		if (keptIds.has(column.id)) {
			kept.push({
				column,
				apps: await appsReadingColumn(
					tx,
					scope.projectId,
					tableId,
					lookupColumnIdSchema.parse(column.id),
				),
			});
		} else {
			removed.push(column);
		}
	}
	const columnCount = content.fields.length + kept.length;
	if (columnCount > LOOKUP_MAX_COLUMNS) {
		throw new LookupError(
			"storage_limit",
			managedLookupCapRefusal(table.tag, [
				`${columnCount.toLocaleString("en-US")} columns with the ones apps still read (Nova takes ${LOOKUP_MAX_COLUMNS.toLocaleString("en-US")})`,
			]),
		);
	}

	// Every column's id before anything is written: a new field's is the one
	// `newColumnIds` gives under the field's own key, or one Postgres mints
	// now. The rows are then keyed as they will be stored, and judged against
	// the caps before the first write, so a refusal names the cap it is over.
	const newIds = input.newColumnIds ?? {};
	const newFields = content.fields.filter((field) => !byWireName.has(field));
	const missing = newFields.filter(
		(field) => !Object.hasOwn(newIds, field),
	).length;
	const minted =
		missing === 0
			? []
			: (
					await sql<{ id: string }>`
						SELECT uuidv7()::text AS id FROM generate_series(1, ${missing}::integer)
					`.execute(tx)
				).rows.map((row) => lookupColumnIdSchema.parse(row.id));
	const added: { id: LookupColumnId; wireName: string }[] = [];
	let nextMinted = 0;
	for (const field of newFields) {
		const id = Object.hasOwn(newIds, field)
			? lookupColumnIdSchema.parse(newIds[field])
			: minted[nextMinted++];
		if (id === undefined) throw new Error(`No id was minted for ${field}.`);
		added.push({ id, wireName: field });
	}
	const columnIdOf = new Map<string, LookupColumnId>();
	for (const field of content.fields) {
		const existing = byWireName.get(field);
		const id =
			existing === undefined
				? added.find((column) => column.wireName === field)?.id
				: lookupColumnIdSchema.parse(existing.id);
		if (id === undefined) throw new Error(`No column holds ${field}.`);
		columnIdOf.set(field, id);
	}
	const rows = rowValuesFor(content, columnIdOf);
	await holdCaps(tx, table.tag, content, rows);
	checkCells(
		table.tag,
		content.fields.map((field) => {
			const id = columnIdOf.get(field);
			if (id === undefined) throw new Error(`No column holds ${field}.`);
			return textColumn(id, field);
		}),
		rows,
	);

	// Which columns read as gone from CommCare HQ is part of the definition
	// every open page holds (`lookupHqOriginOf`): it was every stored column
	// with no field in the stored copy of CommCare HQ's table, and it becomes
	// the kept ones. A refresh that changes that set changes the definition,
	// even where no column is added, removed or moved and no row differs.
	const goneBefore = new Set<string>();
	if (managedInHq) {
		const storedFields = new Set(
			managedCanonicalSchema
				.parse(table.hq_canonical)
				.fields.map((field) => field.name),
		);
		for (const column of stored) {
			if (!storedFields.has(column.wire_name)) goneBefore.add(column.id);
		}
	}
	const goneChanged =
		goneBefore.size !== kept.length ||
		kept.some(({ column }) => !goneBefore.has(column.id));

	let definitionChanged =
		mode === "adopt" || table.hq_remote_id !== origin.remoteId || goneChanged;

	// Text, in adopt mode, for every column that stays. Nothing stored is
	// coerced: the rows below are CommCare HQ's strings, and a kept column
	// holds no cells.
	if (mode === "adopt") {
		const retyped = stored
			.filter(
				(column) =>
					column.data_type !== "text" &&
					!removed.some((gone) => gone.id === column.id),
			)
			.map((column) => column.id);
		if (retyped.length > 0) {
			await tx
				.updateTable("lookup_columns")
				.set({ data_type: "text" })
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", tableId)
				.where("id", "in", retyped)
				.execute();
			definitionChanged = true;
		}
	}

	if (removed.length > 0) {
		await tx
			.deleteFrom("lookup_columns")
			.where("project_id", "=", scope.projectId)
			.where("table_id", "=", tableId)
			.where(
				"id",
				"in",
				removed.map((column) => column.id),
			)
			.execute();
		definitionChanged = true;
	}

	// The final order: CommCare HQ's fields, then the kept columns as they stood.
	type OrderedColumn = { existingId: LookupColumnId | null; wireName: string };
	const finalOrder: OrderedColumn[] = [
		...content.fields.map((field) => ({
			existingId: byWireName.get(field)?.id ?? null,
			wireName: field,
		})),
		...kept.map(({ column }) => ({
			existingId: column.id,
			wireName: column.wire_name,
		})),
	];
	const survivingBefore = stored
		.filter((column) => !removed.some((gone) => gone.id === column.id))
		.map((column) => column.id);
	const survivingAfter = finalOrder.flatMap((entry) =>
		entry.existingId === null ? [] : [entry.existingId],
	);
	const reordered = survivingBefore.some(
		(id, index) => survivingAfter[index] !== id,
	);
	const addedColumns: { id: LookupColumnId; wireName: string }[] = [];
	if (added.length > 0 || reordered) {
		const orderKeys = balancedKeysBetween(null, null, finalOrder.length);
		for (const [index, entry] of finalOrder.entries()) {
			if (entry.existingId !== null) {
				await tx
					.updateTable("lookup_columns")
					.set({ order_key: orderKeys[index] })
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", tableId)
					.where("id", "=", entry.existingId)
					.execute();
				continue;
			}
			const column = added.find((one) => one.wireName === entry.wireName);
			if (column === undefined) {
				throw new Error(`No column was planned for ${entry.wireName}.`);
			}
			await tx
				.insertInto("lookup_columns")
				.values({
					project_id: scope.projectId,
					table_id: tableId,
					id: column.id,
					wire_name: column.wireName,
					label: columnLabelFor(column.wireName),
					data_type: "text",
					order_key: orderKeys[index],
				})
				.execute();
			addedColumns.push(column);
		}
		definitionChanged = true;
	}

	const current = await tx
		.selectFrom("lookup_rows")
		.select("values")
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", tableId)
		.orderBy("order_key", "asc")
		.orderBy("id", "asc")
		.execute();
	const rowsChanged =
		current.length !== rows.length ||
		current.some(
			(row, index) =>
				!sameValues(lookupRowValuesSchema.parse(row.values), rows[index]),
		);
	let dataBytes = table.data_bytes;
	if (rowsChanged) {
		await tx
			.deleteFrom("lookup_rows")
			.where("project_id", "=", scope.projectId)
			.where("table_id", "=", tableId)
			.execute();
		dataBytes = 0;
		if (rows.length > 0) {
			const orderKeys = balancedKeysBetween(null, null, rows.length);
			try {
				const inserted = await tx
					.insertInto("lookup_rows")
					.values(
						rows.map((values, index) => ({
							project_id: scope.projectId,
							table_id: tableId,
							order_key: orderKeys[index],
							values: JSON.stringify(values),
							created_by: scope.actorId,
							updated_by: scope.actorId,
						})),
					)
					.returning("value_bytes")
					.execute();
				dataBytes = inserted.reduce((total, row) => total + row.value_bytes, 0);
			} catch (error) {
				translateRowCheck(table.tag, error);
			}
		}
		if (dataBytes > LOOKUP_MAX_TABLE_BYTES) storageFloor(table.tag, dataBytes);
	}

	const origins = {
		hq_server: origin.server,
		hq_domain: origin.domain,
		hq_remote_id: origin.remoteId,
		hq_canonical: JSON.stringify(origin.canonical),
		hq_refreshed_at: at,
		hq_refreshed_by: scope.actorId,
		...(mode === "adopt"
			? {
					hq_brought_in_at: table.hq_brought_in_at ?? at,
					hq_brought_in_by: table.hq_brought_in_by ?? scope.actorId,
					hq_taken_over_at: null,
					hq_taken_over_by: null,
				}
			: {}),
	};
	const keptGoneColumns = kept.map(({ column, apps }) => ({
		id: lookupColumnIdSchema.parse(column.id),
		wireName: column.wire_name,
		apps,
	}));
	const removedColumns = removed.map((column) => column.wire_name);
	if (!definitionChanged && !rowsChanged) {
		const stamped = await updateLockedLookupTable(
			tx,
			scope.projectId,
			tableId,
			origins,
		);
		return {
			changed: "nothing",
			addedColumns,
			removedColumns,
			keptGoneColumns,
			...lookupTableRevisions(stamped),
		};
	}
	const projectRevision = await advanceLookupProjectRevision(
		tx,
		scope.projectId,
	);
	const updated = await updateLockedLookupTable(tx, scope.projectId, tableId, {
		...origins,
		column_count: columnCount,
		row_count: rows.length,
		data_bytes: dataBytes,
		...(definitionChanged ? { definition_revision: projectRevision } : {}),
		...(rowsChanged ? { rows_revision: projectRevision } : {}),
		updated_by: scope.actorId,
		updated_at: at,
	});
	await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
	return {
		changed: definitionChanged ? "definition" : "rows",
		addedColumns,
		removedColumns,
		keptGoneColumns,
		...lookupTableRevisions(updated),
	};
}

/**
 * Hand a table CommCare HQ manages to Nova (Manage in Nova): under Project
 * state and the table's lock, record who took it over and when, and stamp
 * `definition_revision`, because every client reads from the definition
 * whether a table may be edited. No column or row changes. The Project
 * revision advances once and notifies. Needs `delete`. A table Nova manages
 * already is answered as it stands, with no write; a table that never came
 * from CommCare HQ is `not_found`.
 */
export async function takeOverManagedLookupTableInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	tableIdInput: LookupTableId,
	at: Date,
): Promise<LookupTableRevisions> {
	assertWriter(scope);
	if (!roleAllowsApp(scope.role, "delete")) {
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	const tableId = lookupTableIdSchema.parse(tableIdInput);
	await lockLookupProjectState(tx, scope.projectId);
	const table = await lockLookupTableForUpdate(
		tx,
		scope.projectId,
		tableId,
		null,
		"hq-management",
	);
	if (table.hq_server === null) {
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	if (table.hq_taken_over_at !== null) return lookupTableRevisions(table);
	const projectRevision = await advanceLookupProjectRevision(
		tx,
		scope.projectId,
	);
	const updated = await updateLockedLookupTable(tx, scope.projectId, tableId, {
		hq_taken_over_at: at,
		hq_taken_over_by: scope.actorId,
		definition_revision: projectRevision,
		updated_by: scope.actorId,
		updated_at: at,
	});
	await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
	return lookupTableRevisions(updated);
}
