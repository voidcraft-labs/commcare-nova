import "server-only";

import { type Kysely, sql, type Transaction } from "kysely";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	HAND_BACK_OVERTAKEN,
	handBackWhilePublishing,
} from "@/lib/publish/managedData";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	createTable,
	type LookupTableOriginColumns,
	type ManagedLookupMemberIds,
} from "./authoringBatch";
import { validateLookupRowValues } from "./coercion";
import {
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_TABLE_BYTES,
} from "./constants";
import { readLookupDefinitionsInTransaction } from "./definitionSnapshot";
import { LookupError } from "./errors";
import { formatLookupBytes, formatLookupBytesOverCap } from "./format";
import { availableBulkSlot, lockLookupBudget } from "./generations/budget";
import { materializeGeneration } from "./generations/materialize";
import type { InventoryAccess } from "./generations/scope";
import {
	type TransferGenerationEvidence,
	transferGeneration,
} from "./generations/transfer";
import { bindManagedMembers } from "./managedMembers";
import {
	columnLabelFor,
	type LookupRowsMeasure,
	lookupCapExcess,
	type ManagedLookupContent,
	managedCanonicalSchema,
	managedLookupCapRefusal,
} from "./managedRules";
import { readTableMembers, updateLookupMembers } from "./members";
import { balancedKeysBetween } from "./orderKeys";
import { resolveNamedRowContent } from "./rowContent";
import {
	hasUnpairedUtf16Surrogate,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
	parseLookupRevision,
	storedLookupRowValuesSchema,
} from "./schema";
import {
	installSourceAssignments,
	type SourceRowAssignment,
} from "./sourceAssignments";
import type {
	LookupAuthoringBatchReceipt,
	LookupColumn,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupRowContent,
	LookupRowValues,
	LookupTableDefinition,
	LookupTableRevisions,
} from "./types";
import {
	assertWorkbookEditAvailable,
	openWorkbookDomain,
} from "./workbookHold";
import {
	advanceLookupProjectRevision,
	authorizeLookupWriteInTransaction,
	type LookupWriteAuthority,
	lockLookupProjectState,
	lockLookupTableForUpdate,
	lookupTableRevisions,
	notifyCommittedLookupMutation,
	type StoredLookupTable,
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
	readonly memberIds?: ManagedLookupMemberIds;
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

/** A table's two revisions as a person or a reading saw them. */
export interface LookupTableReviewedRevisions {
	readonly definitionRevision: LookupRevision;
	readonly rowsRevision: LookupRevision;
}

/**
 * What a person reviewed of a table before a change of who manages it: its
 * revisions, and the apps that read it (the ids of the apps whose reference
 * edges name it, in the Project, sorted), which no revision moves when an app
 * starts or stops reading it. A takeover and an adoption compare it under the
 * table's lock, where an app commit, which takes the table `FOR KEY SHARE`,
 * cannot add a reader until the write commits.
 */
export interface ManagedTableReviewed extends LookupTableReviewedRevisions {
	readonly readerAppIds: readonly string[];
}

/**
 * The table, or the apps that read it, moved since the person or the reading
 * reviewed it: nothing was written. A `conflict`, which every caller answers
 * by reading the table again.
 */
export class LookupReviewMovedError extends LookupError {
	constructor() {
		super(
			"conflict",
			"This lookup table, or the apps that read it, changed after it was reviewed.",
		);
		this.name = "LookupReviewMovedError";
	}
}

/** The ids of the Project's apps whose reference edges name the table, sorted. */
async function readerAppIdsOf(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
): Promise<string[]> {
	const apps = await readLookupReferencingApps(db, { projectId, tableId });
	return apps.map((app) => app.appId).sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	const sorted = [...right].sort();
	return (
		left.length === sorted.length &&
		[...left].sort().every((id, index) => id === sorted[index])
	);
}

/**
 * Throw `LookupReviewMovedError` where the locked table, or the apps that read
 * it now, are not what was reviewed. Runs under the table's `FOR UPDATE` lock.
 */
async function holdReviewed(
	tx: Transaction<AppDatabase>,
	table: StoredLookupTable,
	reviewed: LookupTableReviewedRevisions | ManagedTableReviewed,
): Promise<void> {
	const now = lookupTableRevisions(table);
	if (
		now.definitionRevision !== reviewed.definitionRevision ||
		now.rowsRevision !== reviewed.rowsRevision
	) {
		throw new LookupReviewMovedError();
	}
	if (!("readerAppIds" in reviewed)) return;
	const readers = await readerAppIdsOf(
		tx,
		table.project_id,
		lookupTableIdSchema.parse(table.id),
	);
	if (!sameIds(readers, reviewed.readerAppIds)) {
		throw new LookupReviewMovedError();
	}
}

/**
 * What a change of who manages a table is decided over, read in one snapshot:
 * who manages it, its revisions and the apps that read it, with the digest a
 * confirmation carries back (`managedTableReviewDigest`). Null where the
 * Project holds no such table from CommCare HQ.
 */
export interface ManagedTableReview extends ManagedTableReviewed {
	readonly tableId: LookupTableId;
	readonly managedBy: "commcare-hq" | "nova";
	readonly reviewDigest: string;
	/** The table's definition, with its origin, from the same snapshot. */
	readonly definition: LookupTableDefinition;
	/** The apps that read it, named, in the order a confirmation lists them. */
	readonly readers: readonly LookupReferencingAppSummary[];
}

/** The digest of what a confirmation of a change of who manages a table showed. */
export function managedTableReviewDigest(review: {
	readonly tableId: LookupTableId;
	readonly managedBy: "commcare-hq" | "nova";
	readonly definitionRevision: LookupRevision;
	readonly rowsRevision: LookupRevision;
	readonly readerAppIds: readonly string[];
}): string {
	return canonicalJsonDigest({
		v: 1,
		tableId: review.tableId,
		managedBy: review.managedBy,
		definitionRevision: review.definitionRevision,
		rowsRevision: review.rowsRevision,
		readerAppIds: [...review.readerAppIds].sort(),
	});
}

/**
 * The review of a table that came from CommCare HQ as it stands now, from one
 * read-only `REPEATABLE READ` snapshot, so the revisions and the readers are
 * of one moment. Null where the Project holds no such table.
 */
export async function readManagedTableReview(
	projectId: string,
	tableIdInput: LookupTableId,
): Promise<ManagedTableReview | null> {
	const tableId = lookupTableIdSchema.parse(tableIdInput);
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const table = await tx
				.selectFrom("lookup_tables")
				.selectAll()
				.where("project_id", "=", projectId)
				.where("id", "=", tableId)
				.executeTakeFirst();
			if (table === undefined || table.hq_server === null) return null;
			const { definitionRevision, rowsRevision } = lookupTableRevisions(table);
			const [definition] = (
				await readLookupDefinitionsInTransaction(tx, projectId, [tableId])
			).definitions;
			if (definition === undefined) {
				throw new Error(
					"A lookup table read in one snapshot had no definition in that snapshot.",
				);
			}
			const readers = await readLookupReferencingApps(tx, {
				projectId,
				tableId,
			});
			const readerAppIds = readers.map((app) => app.appId).sort();
			const managedBy =
				table.hq_taken_over_at === null
					? ("commcare-hq" as const)
					: ("nova" as const);
			return {
				tableId,
				managedBy,
				definitionRevision,
				rowsRevision,
				readerAppIds,
				reviewDigest: managedTableReviewDigest({
					tableId,
					managedBy,
					definitionRevision,
					rowsRevision,
					readerAppIds,
				}),
				definition,
				readers,
			};
		});
}

/** The content's fields, each a wire name Nova takes, none repeated. */
function checkContent(tag: string, content: ManagedLookupContent): void {
	if (content.fields.length === 0 && !content.attributes?.length) {
		invalid(
			`The lookup table ${tag} has no fields or row details, so Nova can't hold it.`,
		);
	}
	if (
		content.rowDetails &&
		(content.rows.length !== content.rowDetails.length ||
			content.rowDetails.some((row) => !row.remoteId) ||
			new Set(content.rowDetails.map((row) => row.remoteId)).size !==
				content.rows.length)
	)
		invalid(
			"The source row identities do not match this table. You can refresh the table.",
		);
	if (
		Object.keys(content.fieldDetails ?? {}).some(
			(name) => !content.fields.includes(name),
		)
	)
		invalid(
			"A field detail does not belong to this source table. You can refresh the table.",
		);
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
	contents?: readonly LookupRowContent[],
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
		SELECT coalesce(max(bytes), 0)::bigint::text AS largest_row_bytes,
			coalesce(sum(bytes), 0)::bigint::text AS data_bytes
		FROM (
			SELECT octet_length(v::jsonb::text) + CASE WHEN c IS NULL OR c::jsonb = '{}'::jsonb THEN 0 ELSE octet_length(c::jsonb::text) END AS bytes
			FROM unnest(${rows.map((row) => JSON.stringify(row))}::text[], ${contents?.map((content) => JSON.stringify(content)) ?? []}::text[]) AS t(v,c)
		) measured
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
	contents?: readonly LookupRowContent[],
): Promise<LookupRowsMeasure> {
	return measureWith(await getAppDb(), rows, contents);
}

/** The caps, judged before anything is written; `storage_limit` names each one the table is over. */
async function holdCaps(
	tx: Transaction<AppDatabase>,
	tag: string,
	content: ManagedLookupContent,
	rows: readonly LookupRowValues[],
	contents?: readonly LookupRowContent[],
): Promise<void> {
	const excess = lookupCapExcess(
		content,
		await measureWith(tx, rows, contents),
	);
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
	scope: LookupWriteAuthority,
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

/**
 * Create tables that CommCare HQ manages, with the ids derived for them. One
 * revision, one notice. Each table is named `name`, every column is text with
 * its field's name as its wire name and `columnLabelFor` of it as its label,
 * and the origin lands in the table's insert. A tag the Project already holds
 * is `tag_taken`, and nothing of the call stays.
 */
export async function createManagedLookupTablesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	tables: readonly {
		readonly binding: ManagedLookupTableBinding;
		readonly name: string;
		readonly content: ManagedLookupContent;
		readonly origin: ManagedOriginWrite;
	}[],
	at: Date,
): Promise<LookupAuthoringBatchReceipt> {
	if (tables.length === 0) {
		throw new Error("Creating managed lookup tables needs at least one table.");
	}
	const tags = new Set<string>();
	const tableIds = new Set<string>();
	const prepared = [];
	for (const { binding, name, content, origin } of tables) {
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
		const rich = await bindManagedMembers(
			tx,
			content,
			columnIdOf,
			new Map(),
			binding.memberIds,
		);
		const rows = rowValuesFor(content, columnIdOf);
		const contents = rows.map((values, index) =>
			resolveNamedRowContent(
				rich.columns,
				rich.attributes,
				values,
				content.rowDetails?.[index] ?? {},
			),
		);
		prepared.push({
			tag,
			name,
			tableId,
			content,
			origin,
			...rich,
			rows,
			contents,
		});
	}
	// The caps first, so a cell or row over one is refused with its phrase;
	// the cells' own check then finds nothing a cap does not name.
	for (const table of prepared) {
		if (
			managedCanonicalSchema.parse(table.origin.canonical).source?.inventory ===
			"unavailable"
		) {
			if (table.rows.length)
				invalid(
					"This source has no complete row inventory. You can attach a complete inventory before adding rows.",
				);
		} else
			await holdCaps(tx, table.tag, table.content, table.rows, table.contents);
		checkCells(table.tag, table.columns, table.rows);
	}

	const projectState = await lockLookupProjectState(tx, scope);
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
						attributes: table.attributes,
						columns: table.columns.map((column) => ({
							key: column.wireName,
							wireName: column.wireName,
							label: column.label,
							dataType: column.dataType,
							repeated: column.repeated,
							properties: column.properties
								? [...column.properties]
								: undefined,
						})),
						rows: table.content.rows.map((row, index) => ({
							key: `row-${index}`,
							content: table.content.rowDetails?.[index],
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
						memberIds: table.memberIds,
						sourceRows: table.content.rowDetails,
						fieldIndexes: Object.fromEntries(
							table.columns.map((column) => [
								column.wireName,
								column.index ?? "off",
							]),
						),
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
 * `refresh` (the authority's `edit`): the table is managed in CommCare HQ
 * from `origin`'s server and domain already; any other state is `conflict`
 * (someone chose Manage in Nova meanwhile), and an equal digest from the same
 * remote table stamps the refresh and changes nothing else. A refresh that
 * changes which columns read as gone from CommCare HQ changes the definition,
 * as an added or removed column does. Where it carries the revisions a
 * reading saw (a bring-in's), it writes only while the table still holds them.
 * `adopt` (the authority's `delete`): the table becomes CommCare HQ's copy, so
 * every column is set to text, a takeover is cleared and the definition is
 * stamped, because every client reads who manages a table from it. It writes
 * only while the table and the apps that read it are what was reviewed
 * (`ManagedTableReviewed`), compared under the table's lock; otherwise it is
 * `LookupReviewMovedError`. A table CommCare HQ manages from another project
 * space is `conflict`.
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
 * baseline. Where not, a read that began before the table's last refresh is
 * `conflict`: a bring-in writes what its reading read, or nothing.
 */
export async function refreshManagedLookupTableInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	input: {
		readonly tableId: LookupTableId;
		readonly content: ManagedLookupContent;
		readonly origin: ManagedOriginWrite;
		readonly at: Date;
		/**
		 * Whether a read that began before the table's last refresh, hand-back
		 * or takeover writes nothing (true for a publish's re-read, Refresh and
		 * the hand-back). A bring-in passes false: its columns bind the ids the
		 * reading gave them, so it writes what the reading read or refuses.
		 */
		readonly olderReadYields: boolean;
		/** Column ids for fields the table has no column for; minted where absent. */
		readonly newColumnIds?: Readonly<Record<string, LookupColumnId>>;
		readonly newMemberIds?: ManagedLookupMemberIds;
	} & (
		| {
				/** The table is managed in CommCare HQ already. */
				readonly mode: "refresh";
				/** Locked, verified private storage being promoted on this transaction. */
				readonly verifiedGeneration?: {
					id: string;
					count: number;
					bytes: string;
				};
				/** The revisions a reading saw, where a person's answer rests on them. */
				readonly reviewed?: LookupTableReviewedRevisions;
		  }
		| {
				/** The table becomes managed in CommCare HQ. */
				readonly mode: "adopt";
				readonly reviewed: ManagedTableReviewed;
		  }
	),
): Promise<ManagedRefreshReceipt> {
	const tableId = lookupTableIdSchema.parse(input.tableId);
	const { content, origin, at, mode } = input;
	const generation =
		input.mode === "refresh" ? input.verifiedGeneration : undefined;
	checkOrigin(origin);
	const canonical = managedCanonicalSchema.parse(origin.canonical);
	await lockLookupProjectState(tx, scope);
	const table = await lockLookupTableForUpdate(
		tx,
		scope,
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
	if (input.reviewed !== undefined) {
		await holdReviewed(tx, table, input.reviewed);
	}
	/* A hand-back waits while a publish's workbook carrying the table may
	 * still write Nova's copy over CommCare HQ's: the workbook's admission
	 * holds this row too, so one admitted first is seen here, and one after
	 * finds the table CommCare HQ's and sends nothing. */
	if (mode === "adopt" && !managedInHq) {
		const publishing = await openWorkbookDomain(tx, tableId);
		if (publishing !== null) {
			throw new LookupError("conflict", handBackWhilePublishing(publishing));
		}
		// A renewed takeover must reconstruct access from its own current source.
		await sql`DELETE FROM lookup_row_assignments WHERE project_id=${scope.projectId} AND table_id=${tableId}`.execute(
			tx,
		);
	}
	if (managedInHq) await assertWorkbookEditAvailable(tx, tableId);
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
	} else if (table.hq_refreshed_at !== null && table.hq_refreshed_at > at) {
		throw new LookupReviewMovedError();
	}
	checkContent(table.tag, content);
	const previousCanonical =
		table.hq_canonical === null
			? undefined
			: managedCanonicalSchema.parse(table.hq_canonical);
	const sourceChanged = !deepEqual(previousCanonical?.source, canonical.source);
	if (canonical.source?.inventory === "unavailable") {
		if (!managedInHq || !sameOrigin || table.hq_remote_id !== origin.remoteId)
			throw new LookupError(
				"conflict",
				"This source has no complete row snapshot. You can refresh it before transferring management.",
			);
		// Keep the last complete physical rows and their member identities. The
		// source state gates all current reads; an unknown inventory is never
		// an empty generation. The canonical source names the current schema.

		if (
			previousCanonical &&
			(!deepEqual(previousCanonical.fields, canonical.fields) ||
				!deepEqual(
					previousCanonical.itemAttributes ?? [],
					canonical.itemAttributes ?? [],
				))
		)
			throw new LookupError(
				"conflict",
				"The source definition changed while its rows were unavailable. You can refresh with a complete inventory to update this table.",
			);
		const changed =
			sourceChanged || previousCanonical?.digest !== canonical.digest;
		const revision = changed
			? await advanceLookupProjectRevision(tx, scope.projectId)
			: undefined;
		const updated = await updateLockedLookupTable(
			tx,
			scope.projectId,
			tableId,
			{
				hq_canonical: JSON.stringify(origin.canonical),
				hq_refreshed_at: at,
				hq_refreshed_by: scope.actorId,
				...(revision
					? {
							definition_revision: revision,
							rows_revision: revision,
							updated_by: scope.actorId,
							updated_at: at,
						}
					: {}),
			},
		);
		if (revision)
			await notifyCommittedLookupMutation(tx, scope.projectId, revision);
		return {
			changed: changed ? "definition" : "nothing",
			addedColumns: [],
			removedColumns: [],
			keptGoneColumns: [],
			...lookupTableRevisions(updated),
		};
	}

	if (
		mode === "refresh" &&
		!sourceChanged &&
		!content.rowDetails &&
		!content.fieldDetails &&
		!content.attributes &&
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
	if (!generation && columnCount > LOOKUP_MAX_COLUMNS) {
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
	// Its invariants name the table by its id and a field by its place, as the
	// create arm's do: a field's name is the app's word, and a failed request
	// carries the message to the error log.
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
		if (id === undefined) {
			throw new Error(
				`No id was minted for the field ${content.fields.indexOf(field) + 1} of the lookup table ${tableId}.`,
			);
		}
		added.push({ id, wireName: field });
	}
	const columnIdOf = new Map<string, LookupColumnId>();
	for (const field of content.fields) {
		const existing = byWireName.get(field);
		const id =
			existing === undefined
				? added.find((column) => column.wireName === field)?.id
				: lookupColumnIdSchema.parse(existing.id);
		if (id === undefined) {
			throw new Error(
				`No column of the lookup table ${tableId} holds its field ${content.fields.indexOf(field) + 1}.`,
			);
		}
		columnIdOf.set(field, id);
	}
	const previousMembers = await readTableMembers(tx, scope.projectId, tableId);
	const rich = await bindManagedMembers(
		tx,
		content,
		columnIdOf,
		previousMembers,
		input.newMemberIds,
	);
	const rows = rowValuesFor(content, columnIdOf);
	const contents = rows.map((values, index) =>
		resolveNamedRowContent(
			rich.columns,
			rich.attributes,
			values,
			content.rowDetails?.[index] ?? {},
		),
	);
	if (!generation) await holdCaps(tx, table.tag, content, rows, contents);
	checkCells(table.tag, rich.columns, rows);

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
		mode === "adopt" ||
		table.hq_remote_id !== origin.remoteId ||
		goneChanged ||
		sourceChanged;

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
				throw new Error(
					`No column was planned for the field ${index + 1} of the lookup table ${tableId}.`,
				);
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

	if (
		await updateLookupMembers(
			tx,
			scope.projectId,
			tableId,
			previousMembers,
			rich.members,
			[null, ...columnIdOf.values()],
		)
	)
		definitionChanged = true;
	for (const column of rich.columns) {
		const before = byWireName.get(column.wireName);
		const repeated = column.repeated ?? false;
		if (before && before.repeated !== repeated && keptIds.has(before.id)) {
			const blockingApps = await appsReadingColumn(
				tx,
				scope.projectId,
				tableId,
				column.id,
			);
			throw new LookupError(
				blockingApps.length ? "referenced" : "accepted_design",
				"The source changed how a column holds values. You can update the apps or accepted design using this column, then refresh.",
				{ blockingApps },
			);
		}
		const index = column.index ?? "off";
		if (
			(before?.repeated ?? false) !== repeated ||
			(before?.index_status ?? "off") !== index
		) {
			await tx
				.updateTable("lookup_columns")
				.set({ repeated, index_status: index })
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", tableId)
				.where("id", "=", column.id)
				.execute();
			definitionChanged = true;
		}
	}
	if (generation) {
		if (
			content.rows.length ||
			canonical.source?.storage !== "generation" ||
			canonical.rowCount !== generation.count ||
			table.hq_remote_id !== origin.remoteId
		)
			throw new LookupReviewMovedError();
		const complete =
			await sql`SELECT 1 FROM lookup_generations WHERE project_id=${scope.projectId} AND table_id=${tableId}
            AND id=${generation.id} AND state='complete' AND next_ordinal=${generation.count} AND payload_bytes=${generation.bytes}`.execute(
				tx,
			);
		if (!complete.rows.length) throw new LookupReviewMovedError();
		const revision = await advanceLookupProjectRevision(tx, scope.projectId);
		const updated = await updateLockedLookupTable(
			tx,
			scope.projectId,
			tableId,
			{
				active_generation_id: generation.id,
				rows_revision: revision,
				row_count: generation.count,
				data_bytes: generation.bytes,
				column_count: columnCount,
				...(definitionChanged ? { definition_revision: revision } : {}),
				hq_canonical: JSON.stringify(origin.canonical),
				hq_refreshed_at: at,
				hq_refreshed_by: scope.actorId,
				updated_at: at,
				updated_by: scope.actorId,
			},
		);
		await notifyCommittedLookupMutation(tx, scope.projectId, revision);
		return {
			...lookupTableRevisions(updated),
			changed: definitionChanged ? "definition" : "rows",
			addedColumns,
			removedColumns: removed.map((column) => column.wire_name),
			keptGoneColumns: kept.map(({ column, apps }) => ({
				id: lookupColumnIdSchema.parse(column.id),
				wireName: column.wire_name,
				apps,
			})),
		};
	}
	const sameSourceTable = sameOrigin && table.hq_remote_id === origin.remoteId;
	const inlineComparable =
		table.active_generation_id === null &&
		table.row_count === rows.length &&
		Number(table.data_bytes) <= LOOKUP_MAX_TABLE_BYTES;
	const incoming = (content.rowDetails ?? []).map((row) => row.remoteId);
	// A table can already exceed the inline request budget. Keep the join on
	// its incoming source IDs and never bring its old rows or large leaves
	// into memory to decide that this confirmed replacement is different.
	const current = await tx
		.selectFrom("lookup_rows")
		.select(["id", "order_key", "hq_row_id", "hq_sort_key", "external_bytes"])
		.select([
			sql<unknown>`CASE WHEN ${inlineComparable} AND external_bytes=0 THEN "values" ELSE '{}'::jsonb END`.as(
				"values",
			),
			sql<unknown>`CASE WHEN ${inlineComparable} AND external_bytes=0 THEN content ELSE '{}'::jsonb END`.as(
				"content",
			),
		])
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", tableId)
		.where(
			// Parenthesized: Kysely joins a raw condition to the table filter
			// with a bare AND, which would otherwise bind before this OR.
			sql<boolean>`(${inlineComparable} OR (${sameSourceTable} AND hq_row_id=ANY(${incoming}::text[])))`,
		)
		.orderBy("order_key")
		.orderBy("id")
		.execute();
	const rowsChanged =
		!inlineComparable ||
		current.length !== rows.length ||
		current.some(
			(row, index) =>
				Number(row.external_bytes) > 0 ||
				!sameValues(
					storedLookupRowValuesSchema.parse(row.values),
					rows[index],
				) ||
				!deepEqual(row.content, contents[index]) ||
				row.hq_row_id !== (content.rowDetails?.[index].remoteId ?? null) ||
				row.hq_sort_key !== (content.rowDetails?.[index].sortKey ?? null) ||
				(row.hq_row_id !== null && !sameSourceTable),
		);
	let dataBytes = Number(table.data_bytes);
	if (rowsChanged) {
		const byRemote = new Map(
			current.flatMap((row) =>
				row.hq_row_id !== null && sameSourceTable
					? [[row.hq_row_id, row] as const]
					: [],
			),
		);
		await tx
			.deleteFrom("lookup_rows")
			.where("project_id", "=", scope.projectId)
			.where("table_id", "=", tableId)
			.where(
				// Parenthesized, or the OR would escape the project and table filter
				// and delete every other table's source rows.
				sql<boolean>`(NOT ${sameSourceTable} OR hq_row_id IS NULL OR NOT(hq_row_id=ANY(${incoming}::text[])))`,
			)
			.execute();
		await sql`DELETE FROM lookup_cell_value_refs WHERE project_id=${scope.projectId} AND table_id=${tableId}`.execute(
			tx,
		);
		const generatedRows =
			table.active_generation_id && sameSourceTable
				? await sql<{
						source_id: string;
						row_id: import("./types").LookupRowId;
					}>`
			SELECT source_id,row_id FROM lookup_generation_rows WHERE project_id=${scope.projectId} AND table_id=${tableId}
			AND generation_id=${table.active_generation_id} AND source_id=ANY(${incoming}::text[])`.execute(
						tx,
					)
				: null;
		const generatedIds = new Map(
			generatedRows?.rows.map((row) => [row.source_id, row.row_id]),
		);
		const orderKeys = balancedKeysBetween(null, null, rows.length);
		try {
			// Keep stored source identities in place so a refresh cannot cascade
			// through their assignments or erase an unchanged row's audit stamp.
			for (let offset = 0; offset < rows.length; offset += 500) {
				const writes = rows.slice(offset, offset + 500).flatMap((values, i) => {
					const index = i + offset;
					const source = content.rowDetails?.[index];
					const previous = source && byRemote.get(source.remoteId);
					const heldId =
						previous?.id ?? (source && generatedIds.get(source.remoteId));
					if (
						previous &&
						inlineComparable &&
						Number(previous.external_bytes) === 0 &&
						previous.order_key === orderKeys[index] &&
						previous.hq_sort_key === (source?.sortKey ?? null) &&
						sameValues(
							storedLookupRowValuesSchema.parse(previous.values),
							values,
						) &&
						deepEqual(previous.content, contents[index])
					)
						return [];
					return [
						{
							project_id: scope.projectId,
							table_id: tableId,
							order_key: orderKeys[index],
							values: JSON.stringify(values),
							content: JSON.stringify(contents[index]),
							hq_row_id: source?.remoteId,
							hq_sort_key: source?.sortKey,
							created_by: scope.actorId,
							updated_by: scope.actorId,
							...(heldId ? { id: heldId } : {}),
						},
					];
				});
				if (writes.length)
					await tx
						.insertInto("lookup_rows")
						.values(writes)
						.onConflict((oc) =>
							oc
								.columns(["project_id", "table_id", "id"])
								.doUpdateSet((eb) => ({
									order_key: eb.ref("excluded.order_key"),
									values: eb.ref("excluded.values"),
									content: eb.ref("excluded.content"),
									hq_sort_key: eb.ref("excluded.hq_sort_key"),
									updated_by: scope.actorId,
									updated_at: at,
								})),
						)
						.execute();
			}
		} catch (error) {
			translateRowCheck(table.tag, error);
		}
		const measured = await tx
			.selectFrom("lookup_rows")
			.select(
				sql<number>`coalesce(sum(value_bytes+external_bytes),0)::bigint::text`.as(
					"bytes",
				),
			)
			.where("project_id", "=", scope.projectId)
			.where("table_id", "=", tableId)
			.executeTakeFirstOrThrow();
		dataBytes = Number(measured.bytes);
		if (dataBytes > LOOKUP_MAX_TABLE_BYTES) storageFloor(table.tag, dataBytes);
	}

	if (table.active_generation_id)
		await sql`UPDATE lookup_generations SET state='retired' WHERE project_id=${scope.projectId}
		AND table_id=${tableId} AND id=${table.active_generation_id}`.execute(tx);
	const origins = {
		active_generation_id: null,
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
					worker_access: "all" as const,
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

/** A table a publish's workbook carries, as the workbook's admission locked it. */
export interface PublishedLookupTableLock {
	readonly rowsRevision: string;
	readonly definitionRevision: string;
	readonly isGlobal: boolean;
	readonly id: string;
	readonly tag: string;
	readonly hqServer: string | null;
	readonly hqDomain: string | null;
	/** Whether a person chose Manage in Nova for a table with an origin. */
	readonly takenOver: boolean;
}

/**
 * Lock the tables a publish's workbook carries, in the lookup writers' order:
 * the publisher's `edit`, read on this transaction under the membership gate,
 * the Project's lookup state, then each table `FOR UPDATE` in id order. It
 * changes nothing and advances no revision: the caller records the workbook
 * it is about to send under these locks, which a hand-back of the same table
 * takes too. A table gone since is left out.
 */
export async function lockLookupTablesForPublishInTransaction(
	tx: Transaction<AppDatabase>,
	publisher: { readonly projectId: string; readonly actorId: string },
	tableIds: readonly string[],
): Promise<readonly PublishedLookupTableLock[]> {
	if (tableIds.length === 0) return [];
	const { projectId } = publisher;
	await lockLookupProjectState(
		tx,
		await authorizeLookupWriteInTransaction(tx, publisher, "edit"),
	);
	const ids = [...new Set(tableIds)]
		.map((id) => lookupTableIdSchema.parse(id))
		.sort();
	const rows = await tx
		.selectFrom("lookup_tables")
		.select([
			"id",
			"tag",
			"hq_server",
			"hq_domain",
			"hq_taken_over_at",
			"definition_revision",
			"rows_revision",
		])
		.select(
			sql<boolean>`worker_access <> 'assigned' AND coalesce(hq_canonical->'source'->>'distribution','global') <> 'assigned'`.as(
				"is_global",
			),
		)
		.where("project_id", "=", projectId)
		.where("id", "in", ids)
		.orderBy("id")
		.forUpdate()
		.execute();
	return rows.map((row) => ({
		id: row.id,
		tag: row.tag,
		hqServer: row.hq_server,
		hqDomain: row.hq_domain,
		definitionRevision: String(row.definition_revision),
		rowsRevision: String(row.rows_revision),
		isGlobal: row.is_global,
		takenOver: row.hq_taken_over_at !== null,
	}));
}

/**
 * Hand a table CommCare HQ manages to Nova (Manage in Nova): under Project
 * state and the table's lock, record who took it over and when, and stamp
 * `definition_revision`, because every client reads from the definition
 * whether a table may be edited. No column or row changes. The Project
 * revision advances once and notifies. Needs the authority's `delete`. A
 * table Nova manages already is answered as it stands, with no write; a table
 * that never came from CommCare HQ is `not_found`; a table, or the apps that
 * read it, that are not what was reviewed is `LookupReviewMovedError`.
 */
export async function takeOverManagedLookupTableInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	tableIdInput: LookupTableId,
	reviewed: ManagedTableReviewed,
	at: Date,
	observed?: {
		readonly indexedFields: readonly string[];
		readonly sourceDigest: string;
		readonly assignments?: readonly SourceRowAssignment[];
		readonly generation?: {
			access: InventoryAccess;
			evidence: TransferGenerationEvidence;
		};
	},
): Promise<LookupTableRevisions> {
	const tableId = lookupTableIdSchema.parse(tableIdInput);
	await lockLookupProjectState(tx, scope);
	const table = await lockLookupTableForUpdate(
		tx,
		scope,
		tableId,
		null,
		"hq-management",
	);
	if (table.hq_server === null) {
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	if (table.hq_taken_over_at !== null) return lookupTableRevisions(table);
	await assertWorkbookEditAvailable(tx, tableId);
	await holdReviewed(tx, table, reviewed);
	const original = managedCanonicalSchema.parse(table.hq_canonical);
	const source = original.source;
	if (
		source &&
		(source.distribution !== (observed?.assignments ? "assigned" : "global") ||
			source.inventory !== "complete" ||
			(source.storage === "generation") !== !!observed?.generation)
	)
		throw new LookupError(
			"managed_in_hq",
			"This table needs its current complete global data before Nova can manage it.",
		);
	if (source && !observed)
		throw new LookupError(
			"conflict",
			"The table needs a fresh index check before Nova can manage it.",
		);
	if (observed) {
		if (original.digest !== observed.sourceDigest)
			throw new LookupReviewMovedError();
		const names = original.fields.map((field) => field.name);
		const indexed = new Set(observed.indexedFields);
		if (
			indexed.size !== observed.indexedFields.length ||
			[...indexed].some((name) => !names.includes(name))
		)
			throw new LookupReviewMovedError();
		if (names.length)
			await tx
				.updateTable("lookup_columns")
				.set({
					index_status: sql`CASE WHEN wire_name=ANY(${[...indexed]}::text[]) THEN 'indexed' ELSE 'off' END`,
				})
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", tableId)
				.where("wire_name", "in", names)
				.execute();
	}
	let materializedBytes: string | undefined;
	if (observed?.generation) {
		const { access, evidence } = observed.generation;
		if (
			access.tableId !== tableId ||
			access.scope.projectId !== scope.projectId ||
			access.scope.actorId !== scope.actorId
		)
			throw new LookupReviewMovedError();
		const verify = async () => {
			const current = await transferGeneration(
				tx,
				access,
				observed.assignments ? "assigned" : "global",
			);
			if (!deepEqual(current.evidence, evidence))
				throw new LookupReviewMovedError();
		};
		await verify();
		const budget = await lockLookupBudget(tx, scope.projectId);
		await availableBulkSlot(tx, scope.projectId, budget.bulk_slots);
		const [definition] = (
			await readLookupDefinitionsInTransaction(tx, scope.projectId, [tableId])
		).definitions;
		if (!definition) throw new LookupReviewMovedError();
		materializedBytes = await materializeGeneration(
			tx,
			{
				projectId: scope.projectId,
				tableId,
				generationId: evidence.generationId,
			},
			scope.actorId,
			definition,
			evidence.count,
		);
		await verify();
		await sql`UPDATE lookup_generations SET state='retired' WHERE project_id=${scope.projectId} AND table_id=${tableId} AND id=${evidence.generationId}`.execute(
			tx,
		);
	}
	if (observed?.assignments)
		await installSourceAssignments(
			tx,
			scope.projectId,
			tableId,
			observed.assignments,
		);
	const projectRevision = await advanceLookupProjectRevision(
		tx,
		scope.projectId,
	);
	const updated = await updateLockedLookupTable(tx, scope.projectId, tableId, {
		...(observed
			? {
					worker_access: observed.assignments
						? ("assigned" as const)
						: ("all" as const),
					hq_canonical: JSON.stringify({
						...original,
						source: {
							inventory: "complete",
							distribution: observed.assignments ? "assigned" : "global",
							indexEvidence: observed.assignments ? "workbook" : "restore",
						},
					}),
				}
			: {}),
		...(materializedBytes !== undefined
			? {
					active_generation_id: null,
					rows_revision: projectRevision,
					data_bytes: materializedBytes,
				}
			: {}),
		hq_taken_over_at: at,
		hq_taken_over_by: scope.actorId,
		definition_revision: projectRevision,
		updated_by: scope.actorId,
		updated_at: at,
	});
	await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
	return lookupTableRevisions(updated);
}
