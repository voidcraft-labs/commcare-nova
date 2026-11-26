import "server-only";

import { type Selectable, sql, type Transaction } from "kysely";
import { type ZodType, z } from "zod";
import {
	type AppDatabase,
	getAppDb,
	type LookupColumnsTable,
	type LookupRowsTable,
	withAppTx,
} from "@/lib/db/pg";
import {
	type LookupColumnId,
	type LookupMemberId,
	type LookupRowId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { balancedKeysBetween, deriveKeyAtIndex } from "@/lib/lookup/orderKeys";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { validateLookupRowValues } from "./coercion";
import {
	LOOKUP_MAX_CHANGE_BYTES,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_VALIDATION_DETAILS,
} from "./constants";
import { readLookupDefinitionsInTransaction } from "./definitionSnapshot";
import { LookupError } from "./errors";
import { readLookupFixtureDataInTransaction } from "./fixtureSnapshot";
import { formatLookupBytes } from "./format";
import { externalTextMatch } from "./largeValues/projection";
import { lookupHqOriginOf, lookupManifestHqOriginOf } from "./managedRules";
import { holdLookupReaderReview } from "./memberGovernance";
import {
	columnWithMembers,
	insertLookupMembers,
	readTableMembers,
} from "./members";
import { assertLookupRenamesAllowed } from "./nameGovernance";
import { lookupEditOnce, lookupPriorReceipt } from "./operationReceipt";
import { checkedRowContent } from "./rowContent";
import { rowIndex, rowOrderForPlacement } from "./rowOrdering";
import { readLookupRowParts } from "./rowParts";
import {
	patchLookupRowInTransaction,
	replaceLookupRowInTransaction,
} from "./rowPatch";
import {
	addLookupColumnInputSchema,
	createLookupRowInputSchema,
	createLookupTableInputSchema,
	deleteLookupRowInputSchema,
	lookupRowContentSchema,
	moveLookupColumnInputSchema,
	moveLookupRowInputSchema,
	parseLookupRevision,
	replaceLookupRowsInputSchema,
	storedLookupRowValuesSchema,
	updateLookupColumnLabelInputSchema,
	updateLookupColumnWireNameInputSchema,
	updateLookupRowInputSchema,
	updateLookupTableNameInputSchema,
	updateLookupTableTagInputSchema,
} from "./schema";
import {
	inlineLookupInventoryAvailable,
	requiresLookupProjection,
	workerLookupUnavailable,
} from "./source";
import type {
	AddLookupColumnInput,
	CreateLookupRowInput,
	CreateLookupTableInput,
	DeleteLookupRowInput,
	LookupColumn,
	LookupCreatedColumnReceipt,
	LookupCreatedRowReceipt,
	LookupDefinitionsSnapshot,
	LookupFixtureDataSnapshot,
	LookupManifest,
	LookupMember,
	LookupMutationReceipt,
	LookupRevision,
	LookupRow,
	LookupRowsPage,
	LookupRowsPageInput,
	LookupRowValues,
	LookupScope,
	LookupTableManifestEntry,
	LookupTableSnapshot,
	LookupValidationDetail,
	MoveLookupColumnInput,
	MoveLookupRowInput,
	ReplaceLookupRowsInput,
	UpdateLookupColumnLabelInput,
	UpdateLookupColumnWireNameInput,
	UpdateLookupRowInput,
	UpdateLookupTableNameInput,
	UpdateLookupTableTagInput,
} from "./types";
import {
	advanceLookupProjectRevision as advanceProjectRevision,
	authorizeLookupWriteInTransaction,
	lockLookupProjectState as lockProjectState,
	lockLookupTableForUpdate as lockTable,
	notifyCommittedLookupMutation,
	lookupTableRevisions as revisionsOf,
	type StoredLookupTable as StoredTable,
	updateLockedLookupTable as updateLockedTable,
} from "./writerTransaction";

type StoredColumn = Selectable<LookupColumnsTable>;
type StoredRow = Selectable<LookupRowsTable>;

/**
 * The service receives a scope only after a request boundary has authenticated
 * and authorized the exact Project, which is enough for a read. A write never
 * trusts the scope's role: each one reads the member's role again in its own
 * transaction (`authorizeLookupWriteInTransaction`), with the capability that
 * write needs, before its first lock. This assertion catches an internal
 * caller constructing a broken scope.
 */
function assertScope(scope: LookupScope): void {
	if (
		typeof scope.projectId !== "string" ||
		scope.projectId.length === 0 ||
		typeof scope.actorId !== "string" ||
		scope.actorId.length === 0
	) {
		throw new Error("Lookup service received an invalid authorized scope.");
	}
}

function parseInput<T>(schema: ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	const details: LookupValidationDetail[] = parsed.error.issues
		.slice(0, LOOKUP_MAX_VALIDATION_DETAILS)
		.map((issue) => ({
			code: issue.code,
			message:
				issue.path.length === 0
					? issue.message
					: `${issue.path.join(".")}: ${issue.message}`,
		}));
	throw new LookupError("invalid_input", "Lookup input is invalid.", {
		details,
		totalDetailCount: parsed.error.issues.length,
	});
}

function parseTableId(value: unknown): LookupTableId {
	return parseInput(lookupTableIdSchema, value);
}

function toIso(value: Date): string {
	return value.toISOString();
}

function manifestEntryOf(table: StoredTable): LookupTableManifestEntry {
	const hq = lookupManifestHqOriginOf(table);
	return {
		id: lookupTableIdSchema.parse(table.id),
		name: table.name,
		...(table.worker_access === "assigned"
			? { workerAccess: "assigned" as const }
			: {}),
		tag: table.tag,
		columnCount: table.column_count,
		rowCount: requiresLookupProjection(hq) ? null : table.row_count,
		dataBytes: requiresLookupProjection(hq) ? null : Number(table.data_bytes),
		...revisionsOf(table),
		...(hq === undefined ? {} : { hq }),
	};
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function lookupRowOf(row: StoredRow): LookupRow {
	return {
		id: lookupRowIdSchema.parse(row.id),
		values: storedLookupRowValuesSchema.parse(row.values),
		...lookupRowContentSchema.parse(row.content),
		valueBytes: row.value_bytes + Number(row.external_bytes),
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}

function snapshotOf(args: {
	projectId: string;
	projectRevision: LookupRevision;
	table: StoredTable;
	columns: readonly StoredColumn[];
	members: ReadonlyMap<LookupColumnId | null, readonly LookupMember[]>;
	rows: readonly StoredRow[];
}): LookupTableSnapshot {
	const columns = args.columns.map((column) =>
		columnWithMembers(column, args.members.get(column.id)),
	);
	const attributes = args.members.get(null);
	const hq = lookupHqOriginOf(args.table, columns);
	return {
		projectId: args.projectId,
		projectRevision: args.projectRevision,
		id: lookupTableIdSchema.parse(args.table.id),
		name: args.table.name,
		...(args.table.worker_access === "assigned"
			? { workerAccess: "assigned" as const }
			: {}),
		tag: args.table.tag,
		columns,
		...(attributes?.length ? { attributes } : {}),
		columnCount: args.table.column_count,
		rows: args.rows.map(lookupRowOf),
		rowCount: requiresLookupProjection(hq) ? null : args.table.row_count,
		dataBytes: requiresLookupProjection(hq)
			? null
			: Number(args.table.data_bytes),
		createdBy: args.table.created_by,
		updatedBy: args.table.updated_by,
		createdAt: toIso(args.table.created_at),
		updatedAt: toIso(args.table.updated_at),
		...revisionsOf(args.table),
		...(hq === undefined ? {} : { hq }),
	};
}

const LOOKUP_AUTHORING_ROW_PAGE_SIZE = 100;
/** Leaves room for the shared-tool/MCP envelope below its 100k result cap. */
export const LOOKUP_AUTHORING_ROW_PAGE_MAX_BYTES = 70_000;

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
const lookupRowsCursorSchema = z.strictObject({
	v: z.literal(2),
	projectId: z.string().min(1),
	tableId: lookupTableIdSchema,
	tableRevision: z.string(),
	requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	offset: z.number().int().nonnegative().max(2147483647),
	part: z.number().int().positive().optional(),
});

function lookupRowsRequestDigest(input: {
	readonly query: string;
	readonly columnIds: readonly LookupColumnId[];
	readonly rowId?: LookupRowId;
	readonly attributeIds?: readonly LookupMemberId[];
	readonly attributesOnly?: boolean;
}): string {
	return canonicalJsonDigest(input);
}

export interface LookupRowsPageBudgetOptions {
	/** The exact value serialized by the model-facing caller. */
	readonly resultEnvelope?: (page: LookupRowsPage) => unknown;
}

function normalizedPageInput(input: LookupRowsPageInput): {
	tableId: LookupTableId;
	query: string;
	rowId?: LookupRowId;
	attributeIds?: LookupMemberId[];
	columnIds: LookupColumnId[];
	cursor?: string;
} {
	const parsed = z
		.strictObject({
			tableId: lookupTableIdSchema,
			rowId: lookupRowIdSchema.optional(),
			attributeIds: lookupMemberIdSchema
				.array()
				.max(LOOKUP_MAX_COLUMNS)
				.optional(),
			query: z.string().trim().max(200).optional(),
			columnIds: z
				.array(lookupColumnIdSchema)
				.max(LOOKUP_MAX_COLUMNS)
				.optional(),
			cursor: z.string().min(1).max(4096).optional(),
		})
		.safeParse(input);
	if (!parsed.success) {
		throw new LookupError(
			"invalid_input",
			"Lookup row-page input is invalid.",
			{
				details: parsed.error.issues.map((issue) => ({
					code: issue.code,
					message: `${issue.path.join(".")}: ${issue.message}`,
				})),
				totalDetailCount: parsed.error.issues.length,
			},
		);
	}
	const columnIds = [...new Set(parsed.data.columnIds ?? [])].sort(
		compareAscii,
	);
	return {
		tableId: parsed.data.tableId,
		...(parsed.data.rowId ? { rowId: parsed.data.rowId } : {}),
		query: (parsed.data.query ?? "").toLocaleLowerCase("en-US"),
		columnIds,
		...(parsed.data.attributeIds === undefined
			? {}
			: {
					attributeIds: [...new Set(parsed.data.attributeIds)].sort(
						compareAscii,
					),
				}),
		...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
	};
}

function decodeRowsCursor(value: string) {
	try {
		return lookupRowsCursorSchema.parse(
			JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
		);
	} catch {
		throw new LookupError(
			"invalid_input",
			"The lookup row cursor is invalid. Start again without a cursor.",
		);
	}
}

function encodeRowsCursor(
	value: z.infer<typeof lookupRowsCursorSchema>,
): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function receiptOf(
	table: StoredTable,
	projectRevision: LookupRevision,
): LookupMutationReceipt {
	return { projectRevision, ...revisionsOf(table) };
}

function notFound(): never {
	throw new LookupError("not_found", "Lookup resource was not found.");
}

/**
 * The one storage refusal, naming the size that was actually measured.
 *
 * A bare "this table is full" leaves the author with nothing to act on: they
 * cannot tell whether they are 200 bytes over or ten times over, nor whether
 * shortening one long value would be enough. `dataBytes` is the exact
 * Postgres-generated total the write would have produced, so the sentence is
 * a measurement rather than an estimate.
 */
function rejectInlineRowLimit(): never {
	throw new LookupError(
		"storage_limit",
		"This row is too large for one inline edit. You can edit the individual values or import the table in parts.",
	);
}

function rejectStorageLimit(dataBytes: number): never {
	throw new LookupError(
		"storage_limit",
		`This inline replacement uses ${formatLookupBytes(dataBytes)}. You can import it in parts to stay within ${formatLookupBytes(LOOKUP_MAX_CHANGE_BYTES)} per request.`,
	);
}

async function orderedColumns(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
): Promise<StoredColumn[]> {
	return tx
		.selectFrom("lookup_columns")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.orderBy("order_key", "asc")
		.orderBy("id", "asc")
		.execute();
}

async function orderedRows(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
): Promise<StoredRow[]> {
	return tx
		.selectFrom("lookup_rows")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.orderBy("order_key", "asc")
		.orderBy("id", "asc")
		.execute();
}

function validateRowsAgainstColumns(
	columns: readonly LookupColumn[],
	rows: readonly unknown[],
): LookupRowValues[] {
	const normalized: LookupRowValues[] = [];
	const details: LookupValidationDetail[] = [];
	let totalDetailCount = 0;
	for (const values of rows) {
		const result = validateLookupRowValues(columns, values, {
			maxIssues: Math.max(0, LOOKUP_MAX_VALIDATION_DETAILS - details.length),
		});
		totalDetailCount += result.totalIssueCount;
		if (!result.success) details.push(...result.issues);
		normalized.push(result.values);
	}
	if (totalDetailCount > 0) {
		throw new LookupError(
			"invalid_input",
			"One or more lookup row values are invalid for the current columns.",
			{ details, totalDetailCount },
		);
	}
	return normalized;
}

function assertCreateIndex(index: number, length: number, noun: string): void {
	if (index > length) {
		throw new LookupError(
			"invalid_input",
			`${noun} position must be between 0 and ${length}.`,
		);
	}
}

function assertMoveIndex(index: number, length: number, noun: string): void {
	if (index >= length) {
		throw new LookupError(
			"invalid_input",
			`${noun} position must be between 0 and ${Math.max(0, length - 1)}.`,
		);
	}
}

interface DatabaseErrorShape {
	code?: unknown;
	constraint?: unknown;
}

/** Translate only expected user-facing constraint races; all infrastructure
 * and invariant failures retain their original error and stack. */
function translateExpectedSqlError(error: unknown): never {
	if (error instanceof LookupError) throw error;
	const sqlError = error as DatabaseErrorShape;
	const constraint =
		typeof sqlError.constraint === "string" ? sqlError.constraint : "";
	if (
		sqlError.code === "23505" &&
		constraint === "lookup_tables_project_id_tag_key"
	) {
		throw new LookupError(
			"tag_taken",
			"That table tag is already used in this Project.",
			{ cause: error },
		);
	}
	if (
		sqlError.code === "23505" &&
		constraint === "lookup_columns_project_id_table_id_wire_name_key"
	) {
		throw new LookupError(
			"invalid_input",
			"That export name is already used in this table.",
			{ cause: error },
		);
	}
	if (
		(sqlError.code === "23514" &&
			constraint === "lookup_rows_value_bytes_check") ||
		(sqlError.code === "P0001" && constraint === "lookup_storage_capacity")
	) {
		throw new LookupError(
			"storage_limit",
			"Lookup data exceeds the allowed storage limit.",
			{ cause: error },
		);
	}
	throw error;
}

async function mutation<T>(body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		translateExpectedSqlError(error);
	}
}

/** Complete Project manifest from one read-only repeatable-read snapshot. */
export async function getLookupManifest(
	scope: LookupScope,
): Promise<LookupManifest> {
	assertScope(scope);
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const state = await tx
				.selectFrom("lookup_project_state")
				.select("revision")
				.where("project_id", "=", scope.projectId)
				.executeTakeFirst();
			const tables = await tx
				.selectFrom("lookup_tables")
				.selectAll()
				.where("project_id", "=", scope.projectId)
				.orderBy((eb) => eb.fn("lower", ["name"]), "asc")
				.orderBy("id", "asc")
				.execute();
			return {
				projectId: scope.projectId,
				projectRevision: parseLookupRevision(state?.revision ?? "0"),
				tables: tables.map(manifestEntryOf),
			};
		});
}

export { readLookupDefinitionsInTransaction } from "./definitionSnapshot";
export { readLookupFixtureDataInTransaction } from "./fixtureSnapshot";

/** Exact requested definitions from one read-only repeatable-read snapshot. */
export async function getLookupDefinitions(
	scope: LookupScope,
	tableIds: readonly LookupTableId[],
): Promise<LookupDefinitionsSnapshot> {
	assertScope(scope);
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) =>
			readLookupDefinitionsInTransaction(tx, scope.projectId, tableIds),
		);
}

/** Every rows-free table definition in one Project generation.
 *
 * The table-id discovery and definition projection share one repeatable-read
 * transaction. Builder authoring must not combine a manifest from generation N
 * with columns from generation N+1: the exact returned snapshot feeds both the
 * editor vocabulary and the client commit gate.
 */
export async function readAllLookupDefinitionsInTransaction(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<LookupDefinitionsSnapshot> {
	const tableRows = await tx
		.selectFrom("lookup_tables")
		.selectAll()
		.where("project_id", "=", projectId)
		.execute();
	const tableIds = tableRows.map((row) => lookupTableIdSchema.parse(row.id));
	const snapshot = await readLookupDefinitionsInTransaction(
		tx,
		projectId,
		tableIds,
	);
	const tablesById = new Map(
		tableRows.map((table) => [lookupTableIdSchema.parse(table.id), table]),
	);
	return {
		...snapshot,
		definitions: snapshot.definitions.map((definition) => {
			const table = tablesById.get(definition.id);
			if (table === undefined) {
				throw new Error(
					"Lookup authoring catalog lost a table in its snapshot.",
				);
			}
			return {
				...definition,
				columnCount: table.column_count,
				...(requiresLookupProjection(definition.hq)
					? {}
					: { rowCount: table.row_count, dataBytes: Number(table.data_bytes) }),
				...revisionsOf(table),
			};
		}),
	};
}

export async function getAllLookupDefinitions(
	scope: LookupScope,
): Promise<LookupDefinitionsSnapshot> {
	assertScope(scope);
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) =>
			readAllLookupDefinitionsInTransaction(tx, scope.projectId),
		);
}

/**
 * Exact requested definitions plus complete ordered rows from one read-only
 * repeatable-read snapshot. The compile boundary is the intended caller: it
 * must validate and emit against a single generation, so it must not loop
 * `getLookupTable`, whose per-call snapshots could mix generations.
 */
export async function getLookupFixtureData(
	scope: LookupScope,
	tableIds: readonly LookupTableId[],
	/** `download-export` is a downloadable app's: it walks every complete global copy. */
	purpose: "worker" | "export" | "download-export" = "worker",
): Promise<LookupFixtureDataSnapshot> {
	assertScope(scope);
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const snapshot = await readLookupFixtureDataInTransaction(
				tx,
				scope.projectId,
				tableIds,
				purpose === "export"
					? "archive"
					: purpose === "download-export"
						? "download-archive"
						: "device",
			);
			const unavailable = snapshot.definitions.find(
				(table) =>
					table.workerAccess === "assigned" ||
					requiresLookupProjection(table.hq),
			);
			if (purpose === "worker" && unavailable)
				throw new LookupError(
					"managed_in_hq",
					workerLookupUnavailable(unavailable.name),
				);
			return snapshot;
		});
}

/** The CSV header and its expected revision from one snapshot. No row
 * values are read, including when a scalar import is replacing a large table. */
export async function getLookupImportDefinition(
	scope: LookupScope,
	tableIdInput: LookupTableId,
) {
	assertScope(scope);
	const tableId = parseTableId(tableIdInput);
	return (await getAppDb())
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const table = await tx
				.selectFrom("lookup_tables")
				.selectAll()
				.where("project_id", "=", scope.projectId)
				.where("id", "=", tableId)
				.executeTakeFirst();
			if (!table) notFound();
			const [definition] = (
				await readLookupDefinitionsInTransaction(tx, scope.projectId, [tableId])
			).definitions;
			if (!definition) notFound();
			return { ...definition, ...revisionsOf(table) };
		});
}

/** Complete definition and ordered row body from one repeatable-read snapshot. */
export async function getLookupTable(
	scope: LookupScope,
	tableIdInput: LookupTableId,
): Promise<LookupTableSnapshot> {
	assertScope(scope);
	const tableId = parseTableId(tableIdInput);
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const state = await tx
				.selectFrom("lookup_project_state")
				.select("revision")
				.where("project_id", "=", scope.projectId)
				.executeTakeFirst();
			const table = await tx
				.selectFrom("lookup_tables")
				.selectAll()
				.where("project_id", "=", scope.projectId)
				.where("id", "=", tableId)
				.executeTakeFirst();
			if (!table) notFound();
			const hq = lookupManifestHqOriginOf(table);
			if (!inlineLookupInventoryAvailable(hq))
				throw new LookupError(
					"managed_in_hq",
					"You can open the latest source inventory in Project data.",
				);
			if (requiresLookupProjection(hq))
				throw new LookupError(
					"managed_in_hq",
					"You can open this table’s source inventory using its current connection.",
				);
			const columns = await orderedColumns(tx, scope.projectId, tableId);
			if (
				table.row_count > LOOKUP_MAX_ROWS ||
				Number(table.data_bytes) > LOOKUP_MAX_CHANGE_BYTES ||
				(await tx
					.selectFrom("lookup_rows")
					.select("id")
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", tableId)
					.where(rowHasExternalValues)
					.limit(1)
					.executeTakeFirst())
			)
				throw new LookupError(
					"storage_limit",
					"This table opens in pages. You can browse or search its rows in Project data.",
				);
			const rows = await orderedRows(tx, scope.projectId, tableId);
			return snapshotOf({
				projectId: scope.projectId,
				projectRevision: parseLookupRevision(state?.revision ?? "0"),
				table,
				columns,
				members: await readTableMembers(tx, scope.projectId, tableId),
				rows,
			});
		});
}

const rowHasExternalValues = sql<boolean>`EXISTS (
	SELECT 1 FROM lookup_cell_value_refs v WHERE v.project_id=lookup_rows.project_id AND v.table_id=lookup_rows.table_id AND v.row_id=lookup_rows.id)`;

function rowContainsText(
	query: string,
	projection?: readonly LookupColumnId[],
	attributes?: readonly LookupMemberId[],
) {
	return sql<boolean>`(EXISTS (
				SELECT 1 FROM (
					SELECT v FROM jsonb_each_text("values") c(k,v) WHERE (${projection ?? null}::text[] IS NULL OR k = ANY(${projection ?? null}::text[]))
					UNION ALL
					SELECT v FROM jsonb_each_text(content->'attributes') a(k,v) WHERE (${attributes ?? null}::text[] IS NULL OR k = ANY(${attributes ?? null}::text[]))
					UNION ALL
					SELECT t FROM jsonb_each(content->'occurrences') c(k,list)
						CROSS JOIN LATERAL jsonb_array_elements(list) o(item)
						CROSS JOIN LATERAL (SELECT item->>'text' AS t UNION ALL SELECT v FROM jsonb_each_text(item->'properties') p(k,v)) parts
						WHERE (${projection ?? null}::text[] IS NULL OR c.k = ANY(${projection ?? null}::text[]))
				) searchable WHERE strpos(lower(v),${query}) > 0
			) OR ${externalTextMatch(query, projection, attributes)})`;
}

/** Browser row navigation reads a bounded ordered window at one table revision.
 * Positions used by drag and move address source rows, including when search
 * hides other rows. A direct row jump can recover its current position. */
export async function getLookupTableWindow(
	scope: LookupScope,
	tableIdInput: LookupTableId,
	input: { after?: string; rowId?: LookupRowId; query?: string } = {},
): Promise<LookupTableSnapshot> {
	assertScope(scope);
	const tableId = parseTableId(tableIdInput);
	const query = z
		.string()
		.trim()
		.max(200)
		.parse(input.query ?? "")
		.toLocaleLowerCase("en-US");
	if (input.rowId) lookupRowIdSchema.parse(input.rowId);
	if (input.rowId && input.after)
		throw new LookupError("invalid_input", "Choose a row or a page to open.");
	const windowSize = 25;
	const digest = canonicalJsonDigest({ view: "project-data", query });
	const cursor = input.after ? decodeRowsCursor(input.after) : undefined;
	if (
		cursor &&
		(cursor.requestDigest !== digest ||
			cursor.projectId !== scope.projectId ||
			cursor.tableId !== tableId ||
			cursor.part !== undefined)
	)
		throw new LookupError(
			"invalid_input",
			"This page belongs to another table or search. You can restart the search.",
		);
	return (await getAppDb())
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const state = await tx
				.selectFrom("lookup_project_state")
				.select("revision")
				.where("project_id", "=", scope.projectId)
				.executeTakeFirst();
			const table = await tx
				.selectFrom("lookup_tables")
				.selectAll()
				.where("project_id", "=", scope.projectId)
				.where("id", "=", tableId)
				.executeTakeFirst();
			if (!table) notFound();
			const revisions = revisionsOf(table);
			if (cursor && cursor.tableRevision !== revisions.tableRevision)
				throw new LookupError(
					"conflict",
					"The table changed while this page was open. You can reload its rows.",
					{ currentRevisions: revisions },
				);
			const hq = lookupManifestHqOriginOf(table);
			if (requiresLookupProjection(hq)) {
				return {
					...snapshotOf({
						projectId: scope.projectId,
						projectRevision: parseLookupRevision(state?.revision ?? "0"),
						table,
						columns: await orderedColumns(tx, scope.projectId, tableId),
						members: await readTableMembers(tx, scope.projectId, tableId),
						rows: [],
					}),
					rowsUnavailable: true,
					matchingRowCount: 0,
					rowOffset: 0,
				};
			}
			let selection = tx
				.selectFrom("lookup_rows")
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", tableId);
			if (query) selection = selection.where(rowContainsText(query));
			const total = query
				? Number(
						(
							await selection
								.select((eb) => eb.fn.countAll().as("total"))
								.executeTakeFirstOrThrow()
						).total,
					)
				: table.row_count;
			let offset = cursor?.offset ?? 0;
			let missingRowId: LookupRowId | undefined;
			if (input.rowId) {
				const wanted = await selection
					.select(["id", "order_key"])
					.where("id", "=", input.rowId)
					.executeTakeFirst();
				if (!wanted) missingRowId = input.rowId;
				else {
					const rank = await selection
						.select((eb) => eb.fn.countAll().as("total"))
						.where(
							sql<boolean>`(order_key,id)<(${wanted.order_key}::text COLLATE "C",${wanted.id}::uuid)`,
						)
						.executeTakeFirstOrThrow();
					offset = Math.floor(Number(rank.total) / windowSize) * windowSize;
				}
			}
			const inlineBytes = 20 * 1024;
			const inline = sql<boolean>`(value_bytes<=${inlineBytes} AND NOT ${rowHasExternalValues})`;
			const rows = await selection
				.select([
					"id",
					"project_id",
					"table_id",
					"order_key",
					"created_at",
					"updated_at",
					"created_by",
					"updated_by",
					"value_bytes",
					"external_bytes",
					"hq_row_id",
					"hq_sort_key",
					inline.as("inline"),
				])
				.select([
					sql<
						StoredRow["values"]
					>`CASE WHEN ${inline} THEN "values" ELSE '{}'::jsonb END`.as(
						"values",
					),
					sql<unknown>`CASE WHEN ${inline} THEN content ELSE '{}'::jsonb END`.as(
						"content",
					),
				])
				.orderBy("order_key")
				.orderBy("id")
				.offset(offset)
				.limit(windowSize)
				.execute();
			const columns = await orderedColumns(tx, scope.projectId, tableId);
			const snapshot = snapshotOf({
				projectId: scope.projectId,
				projectRevision: parseLookupRevision(state?.revision ?? "0"),
				table,
				columns,
				members: await readTableMembers(tx, scope.projectId, tableId),
				rows,
			});
			const indexById = new Map<LookupRowId, number>();
			if (query && rows.length) {
				const ranked = await sql<{
					id: LookupRowId;
					pos: number;
				}>`SELECT id,pos FROM (SELECT id,(row_number() OVER (ORDER BY order_key,id)-1)::integer AS pos
				FROM lookup_rows WHERE project_id=${scope.projectId} AND table_id=${tableId}::uuid) ordered WHERE id=ANY(${rows.map((row) => row.id)}::uuid[])`.execute(
					tx,
				);
				for (const row of ranked.rows) indexById.set(row.id, row.pos);
			}
			const at = (next: number) =>
				encodeRowsCursor({
					v: 2,
					projectId: scope.projectId,
					tableId,
					tableRevision: revisions.tableRevision,
					requestDigest: digest,
					offset: next,
				});
			return {
				...snapshot,
				rowOffset: offset,
				...(missingRowId ? { missingRowId } : {}),
				matchingRowCount: total,
				rows: snapshot.rows.map((row, index) => ({
					...row,
					...(!rows[index].inline ? { fragmented: true as const } : {}),
					sourceIndex: indexById.get(row.id) ?? offset + index,
				})),
				...(offset > 0
					? { previousRowCursor: at(Math.max(0, offset - windowSize)) }
					: {}),
				...(offset + rows.length < total
					? { nextRowCursor: at(offset + rows.length) }
					: {}),
			};
		});
}

/** Bounded authoring read. The opaque cursor binds the exact table revision,
 * query, and projection, so pages can never mix table generations. */
export async function readLookupTableRowsPageInTransaction(
	tx: Transaction<AppDatabase>,
	projectId: string,
	input: LookupRowsPageInput,
	budget: LookupRowsPageBudgetOptions = {},
): Promise<LookupRowsPage> {
	const normalized = normalizedPageInput(input);
	const requestDigest = lookupRowsRequestDigest({
		query: normalized.query,
		columnIds: normalized.columnIds,
		...(normalized.rowId ? { rowId: normalized.rowId } : {}),
		...(normalized.attributeIds === undefined
			? {}
			: {
					attributeIds: normalized.attributeIds,
					attributesOnly:
						input.columnIds !== undefined && normalized.columnIds.length === 0,
				}),
	});
	const cursor =
		normalized.cursor === undefined
			? undefined
			: decodeRowsCursor(normalized.cursor);
	if (
		cursor !== undefined &&
		(cursor.tableId !== normalized.tableId ||
			cursor.projectId !== projectId ||
			cursor.requestDigest !== requestDigest)
	) {
		throw new LookupError(
			"invalid_input",
			"The lookup row cursor belongs to a different table, query, or column projection. Start again without a cursor.",
		);
	}

	return (async () => {
		const table = await tx
			.selectFrom("lookup_tables")
			.selectAll()
			.where("project_id", "=", projectId)
			.where("id", "=", normalized.tableId)
			.executeTakeFirst();
		if (table === undefined) notFound();
		const hq = lookupManifestHqOriginOf(table);
		if (!inlineLookupInventoryAvailable(hq))
			throw new LookupError(
				"managed_in_hq",
				"You can open the latest source inventory in Project data.",
			);
		if (requiresLookupProjection(hq))
			throw new LookupError(
				"managed_in_hq",
				"You can open this table’s source inventory using its current connection.",
			);
		const revisions = revisionsOf(table);
		if (
			cursor !== undefined &&
			cursor.tableRevision !== revisions.tableRevision
		) {
			throw new LookupError(
				"conflict",
				"This lookup table changed while its rows were being read. Start again without a cursor.",
				{ currentRevisions: revisions },
			);
		}
		const columns = await orderedColumns(tx, projectId, normalized.tableId);
		const members = await readTableMembers(tx, projectId, normalized.tableId);
		const allAttributes = members.get(null) ?? [];
		const attrSet = new Set(
			normalized.attributeIds ?? allAttributes.map((member) => member.id),
		);
		const attributes = allAttributes.filter((member) => attrSet.has(member.id));
		if (attributes.length !== attrSet.size) notFound();
		const columnsById = new Map(
			columns.map((column) => [lookupColumnIdSchema.parse(column.id), column]),
		);
		for (const columnId of normalized.columnIds) {
			if (!columnsById.has(columnId)) notFound();
		}
		const projection =
			normalized.columnIds.length === 0 &&
			!(input.columnIds !== undefined && normalized.attributeIds !== undefined)
				? columns.map((column) => lookupColumnIdSchema.parse(column.id))
				: normalized.columnIds;
		const offset = cursor?.offset ?? 0;
		let pageQuery = tx
			.selectFrom("lookup_rows")
			.select(["id", "value_bytes", rowHasExternalValues.as("external")])
			.where("project_id", "=", projectId)
			.where("table_id", "=", normalized.tableId);
		if (normalized.rowId)
			pageQuery = pageQuery.where("id", "=", normalized.rowId);
		if (normalized.query) {
			pageQuery = pageQuery.where(
				rowContainsText(normalized.query, projection, [...attrSet]),
			);
		}
		const matching = await pageQuery
			.orderBy("order_key")
			.orderBy("id")
			.offset(offset)
			.limit(LOOKUP_AUTHORING_ROW_PAGE_SIZE + 1)
			.execute();
		const projectedColumns = projection.map((columnId) => {
			const column = columnsById.get(columnId);
			if (column === undefined) notFound();
			return columnWithMembers(column, members.get(column.id));
		});
		let projectedTable: LookupRowsPage["table"] = {
			...manifestEntryOf(table),
			columns: projectedColumns,
			...(attributes?.length ? { attributes } : {}),
		};
		const pageOf = (
			pageRows: LookupRowsPage["rows"],
			nextPart?: number,
		): LookupRowsPage => {
			const nextOffset =
				nextPart === undefined ? offset + pageRows.length : offset;
			const complete =
				nextPart === undefined && pageRows.length >= matching.length;
			return {
				table: projectedTable,
				rows: pageRows,
				complete,
				...(complete
					? {}
					: {
							nextCursor: encodeRowsCursor({
								v: 2,
								projectId,
								tableId: normalized.tableId,
								tableRevision: revisions.tableRevision,
								requestDigest,
								offset: nextOffset,
								...(nextPart === undefined ? {} : { part: nextPart }),
							}),
						}),
			};
		};
		const fitsBudget = (page: LookupRowsPage): boolean =>
			jsonBytes(budget.resultEnvelope?.(page) ?? page) <=
			LOOKUP_AUTHORING_ROW_PAGE_MAX_BYTES;
		if (!fitsBudget(pageOf([]))) {
			projectedTable = {
				...manifestEntryOf(table),
				columns: [],
				definitionInCatalog: true,
			};
		}
		const pageRows: LookupRowsPage["rows"][number][] = [];
		// Bound the physical fetch. An oversized row takes the streamed part
		// query below even when its projected subset happens to be small.
		let bodyBytes = 0;
		const inlineIds: LookupRowId[] = [];
		for (const row of matching.slice(0, LOOKUP_AUTHORING_ROW_PAGE_SIZE)) {
			if (row.external || bodyBytes + row.value_bytes > LOOKUP_MAX_ROW_BYTES)
				break;
			inlineIds.push(row.id);
			bodyBytes += row.value_bytes;
		}
		const inline = inlineIds.length
			? await tx
					.selectFrom("lookup_rows")
					.selectAll()
					.where("project_id", "=", projectId)
					.where("table_id", "=", normalized.tableId)
					.where("id", "in", inlineIds)
					.execute()
			: [];
		const inlineById = new Map(inline.map((row) => [row.id, row]));
		for (const row of matching.slice(0, LOOKUP_AUTHORING_ROW_PAGE_SIZE)) {
			const stored = inlineById.get(row.id);
			if (!stored && pageRows.length) break;
			let projected: LookupRowsPage["rows"][number] | undefined;
			if (stored && cursor?.part === undefined) {
				const full = lookupRowOf(stored);
				const cells = projection.flatMap((columnId) =>
					full.values[columnId] === undefined
						? []
						: [{ columnId, value: full.values[columnId] }],
				);
				const occurrences = Object.fromEntries(
					projection.flatMap((columnId) =>
						full.occurrences?.[columnId] === undefined
							? []
							: ([[columnId, full.occurrences[columnId]]] as const),
					),
				);
				projected = {
					id: full.id,
					cells,
					...(attributes.length
						? {
								attributes: Object.fromEntries(
									attributes.map((member) => [
										member.id,
										full.attributes?.[member.id],
									]),
								),
							}
						: {}),
					...(Object.keys(occurrences).length ? { occurrences } : {}),
				};
			}
			if (!projected || !fitsBudget(pageOf([...pageRows, projected]))) {
				if (pageRows.length) break;
				const start = cursor?.part ?? 0;
				const { parts, complete } = await readLookupRowParts(
					tx,
					projectId,
					normalized.tableId,
					row.id,
					projection,
					[...attrSet],
					start,
				);
				if (!parts.length && start)
					throw new LookupError(
						"invalid_input",
						"This row cursor no longer identifies a value. You can start a fresh read.",
					);
				projectedTable = {
					...manifestEntryOf(table),
					columns: [],
					definitionInCatalog: true,
				};
				const fragment = (end: number) =>
					pageOf(
						[{ id: row.id, cells: [], parts: parts.slice(0, end) }],
						end === parts.length && complete ? undefined : start + end,
					);
				let low = parts.length ? 1 : 0;
				let high = parts.length;
				while (low < high) {
					const mid = Math.ceil((low + high) / 2);
					if (fitsBudget(fragment(mid))) low = mid;
					else high = mid - 1;
				}
				const result = fragment(low);
				if (!fitsBudget(result))
					throw new LookupError(
						"invalid_input",
						"The accompanying information is too large for this read. You can open the row in Project data.",
					);
				return result;
			}
			pageRows.push(projected);
		}
		return pageOf(pageRows);
	})();
}

export async function getLookupTableRowsPage(
	scope: LookupScope,
	input: LookupRowsPageInput,
): Promise<LookupRowsPage> {
	assertScope(scope);
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) =>
			readLookupTableRowsPageInTransaction(tx, scope.projectId, input, {
				resultEnvelope: (page) => ({ kind: "read", data: page }),
			}),
		);
}

export async function createLookupTable(
	scope: LookupScope,
	input: CreateLookupTableInput,
): Promise<LookupTableSnapshot> {
	assertScope(scope);
	const parsed = parseInput(createLookupTableInputSchema, input);
	const orderKeys = balancedKeysBetween(null, null, parsed.columns.length);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			await lockProjectState(tx, authority);
			const duplicate = await tx
				.selectFrom("lookup_tables")
				.select("id")
				.where("project_id", "=", scope.projectId)
				.where("tag", "=", parsed.tag)
				.executeTakeFirst();
			if (duplicate) {
				throw new LookupError(
					"tag_taken",
					"That table tag is already used in this Project.",
				);
			}

			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
			const table = await tx
				.insertInto("lookup_tables")
				.values({
					project_id: scope.projectId,
					name: parsed.name,
					tag: parsed.tag,
					definition_revision: projectRevision,
					rows_revision: projectRevision,
					column_count: parsed.columns.length,
					created_by: scope.actorId,
					updated_by: scope.actorId,
				})
				.returningAll()
				.executeTakeFirstOrThrow();
			const columns =
				parsed.columns.length === 0
					? []
					: await tx
							.insertInto("lookup_columns")
							.values(
								parsed.columns.map((column, index) => ({
									project_id: scope.projectId,
									table_id: table.id,
									wire_name: column.wireName,
									label: column.label,
									data_type: column.dataType,
									repeated: column.repeated ?? false,
									index_status: column.indexed
										? ("indexed" as const)
										: ("off" as const),
									order_key: orderKeys[index],
								})),
							)
							.returningAll()
							.execute();
			columns.sort(
				(left, right) =>
					compareAscii(left.order_key, right.order_key) ||
					compareAscii(left.id, right.id),
			);
			const members = new Map<LookupColumnId | null, LookupMember[]>();
			members.set(
				null,
				await insertLookupMembers(
					tx,
					scope.projectId,
					table.id,
					null,
					parsed.attributes ?? [],
				),
			);
			for (const [index, column] of columns.entries())
				members.set(
					column.id,
					await insertLookupMembers(
						tx,
						scope.projectId,
						table.id,
						column.id,
						parsed.columns[index].properties ?? [],
					),
				);
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return snapshotOf({
				projectId: scope.projectId,
				projectRevision,
				table,
				columns,
				members,
				rows: [],
			});
		}),
	);
}

export async function updateLookupTableName(
	scope: LookupScope,
	input: UpdateLookupTableNameInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(updateLookupTableNameInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			const state = await lockProjectState(tx, authority);
			const table = await lockTable(
				tx,
				authority,
				parsed.tableId,
				parsed.expectedTableRevision,
				"author",
			);
			if (table.name === parsed.name) return receiptOf(table, state.revision);
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
			const updated = await updateLockedTable(
				tx,
				scope.projectId,
				parsed.tableId,
				{
					name: parsed.name,
					definition_revision: projectRevision,
					updated_by: scope.actorId,
					updated_at: new Date(),
				},
			);
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
		}),
	);
}

export async function updateLookupTableTag(
	scope: LookupScope,
	input: UpdateLookupTableTagInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(updateLookupTableTagInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"delete",
			);
			const state = await lockProjectState(tx, authority);
			const table = await lockTable(
				tx,
				authority,
				parsed.tableId,
				parsed.expectedTableRevision,
				"author",
			);
			if (table.tag === parsed.tag) return receiptOf(table, state.revision);
			const duplicate = await tx
				.selectFrom("lookup_tables")
				.select("id")
				.where("project_id", "=", scope.projectId)
				.where("tag", "=", parsed.tag)
				.where("id", "!=", parsed.tableId)
				.executeTakeFirst();
			if (duplicate) {
				throw new LookupError(
					"tag_taken",
					"That table tag is already used in this Project.",
				);
			}
			await assertLookupRenamesAllowed(tx, scope.projectId, parsed.tableId, [
				{ name: parsed.tag },
			]);
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
			const updated = await updateLockedTable(
				tx,
				scope.projectId,
				parsed.tableId,
				{
					tag: parsed.tag,
					definition_revision: projectRevision,
					updated_by: scope.actorId,
					updated_at: new Date(),
				},
			);
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
		}),
	);
}

export async function addLookupColumn(
	scope: LookupScope,
	input: AddLookupColumnInput,
): Promise<LookupCreatedColumnReceipt> {
	assertScope(scope);
	const parsed = parseInput(addLookupColumnInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			const state = await lockProjectState(tx, authority);
			const table = await lockTable(
				tx,
				authority,
				parsed.tableId,
				parsed.expectedTableRevision,
				"author",
			);
			if (parsed.column.repeated || parsed.column.indexed !== undefined)
				await holdLookupReaderReview(
					tx,
					scope.projectId,
					table.id,
					parseLookupRevision(state.revision),
					parsed.reviewed,
				);
			const columns = await orderedColumns(tx, scope.projectId, parsed.tableId);
			if (columns.some((item) => item.wire_name === parsed.column.wireName)) {
				throw new LookupError(
					"invalid_input",
					"That export name is already used in this table.",
				);
			}
			const orderKey = deriveKeyAtIndex(
				columns.map((item) => item.order_key),
				columns.length,
			);
			const column = await tx
				.insertInto("lookup_columns")
				.values({
					project_id: scope.projectId,
					table_id: parsed.tableId,
					wire_name: parsed.column.wireName,
					label: parsed.column.label,
					data_type: parsed.column.dataType,
					repeated: parsed.column.repeated ?? false,
					index_status: parsed.column.indexed ? "indexed" : "off",
					order_key: orderKey,
				})
				.returning("id")
				.executeTakeFirstOrThrow();
			await insertLookupMembers(
				tx,
				scope.projectId,
				parsed.tableId,
				column.id,
				parsed.column.properties ?? [],
			);
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
			const updated = await updateLockedTable(
				tx,
				scope.projectId,
				parsed.tableId,
				{
					column_count: table.column_count + 1,
					definition_revision: projectRevision,
					updated_by: scope.actorId,
					updated_at: new Date(),
				},
			);
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return {
				columnId: lookupColumnIdSchema.parse(column.id),
				...receiptOf(updated, projectRevision),
			};
		}),
	);
}

export async function updateLookupColumnLabel(
	scope: LookupScope,
	input: UpdateLookupColumnLabelInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(updateLookupColumnLabelInputSchema, input);
	return updateLookupColumnProjection(scope, parsed, "label", parsed.label);
}

export async function updateLookupColumnWireName(
	scope: LookupScope,
	input: UpdateLookupColumnWireNameInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(updateLookupColumnWireNameInputSchema, input);
	return updateLookupColumnProjection(
		scope,
		parsed,
		"wire_name",
		parsed.wireName,
	);
}

async function updateLookupColumnProjection(
	scope: LookupScope,
	input: UpdateLookupColumnLabelInput | UpdateLookupColumnWireNameInput,
	field: "label" | "wire_name",
	value: string,
): Promise<LookupMutationReceipt> {
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				field === "wire_name" ? "delete" : "edit",
			);
			const state = await lockProjectState(tx, authority);
			const table = await lockTable(
				tx,
				authority,
				input.tableId,
				input.expectedTableRevision,
				"author",
			);
			const column = await tx
				.selectFrom("lookup_columns")
				.selectAll()
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", input.tableId)
				.where("id", "=", input.columnId)
				.executeTakeFirst();
			if (!column) notFound();
			if (column[field] === value) {
				return receiptOf(table, state.revision);
			}
			if (field === "wire_name") {
				const duplicate = await tx
					.selectFrom("lookup_columns")
					.select("id")
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", input.tableId)
					.where("wire_name", "=", value)
					.where("id", "!=", input.columnId)
					.executeTakeFirst();
				if (duplicate) {
					throw new LookupError(
						"invalid_input",
						"That export name is already used in this table.",
					);
				}
				await assertLookupRenamesAllowed(tx, scope.projectId, input.tableId, [
					{ columnId: input.columnId, name: value },
				]);
			}
			const update = tx
				.updateTable("lookup_columns")
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", input.tableId)
				.where("id", "=", input.columnId);
			if (field === "label") {
				await update.set({ label: value }).execute();
			} else {
				await update.set({ wire_name: value }).execute();
			}
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
			const updated = await updateLockedTable(
				tx,
				scope.projectId,
				input.tableId,
				{
					definition_revision: projectRevision,
					updated_by: scope.actorId,
					updated_at: new Date(),
				},
			);
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
		}),
	);
}

export async function moveLookupColumn(
	scope: LookupScope,
	input: MoveLookupColumnInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(moveLookupColumnInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			const state = await lockProjectState(tx, authority);
			const table = await lockTable(
				tx,
				authority,
				parsed.tableId,
				parsed.expectedTableRevision,
				"author",
			);
			const columns = await orderedColumns(tx, scope.projectId, parsed.tableId);
			const currentIndex = columns.findIndex(
				(item) => item.id === parsed.columnId,
			);
			if (currentIndex < 0) notFound();
			assertMoveIndex(parsed.toIndex, columns.length, "Column");
			if (currentIndex === parsed.toIndex)
				return receiptOf(table, state.revision);
			const siblings = columns.filter((item) => item.id !== parsed.columnId);
			const orderKey = deriveKeyAtIndex(
				siblings.map((item) => item.order_key),
				parsed.toIndex,
			);
			await tx
				.updateTable("lookup_columns")
				.set({ order_key: orderKey })
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", parsed.tableId)
				.where("id", "=", parsed.columnId)
				.execute();
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
			const updated = await updateLockedTable(
				tx,
				scope.projectId,
				parsed.tableId,
				{
					definition_revision: projectRevision,
					updated_by: scope.actorId,
					updated_at: new Date(),
				},
			);
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
		}),
	);
}

export async function createLookupRow(
	scope: LookupScope,
	input: CreateLookupRowInput,
): Promise<LookupCreatedRowReceipt> {
	assertScope(scope);
	const parsed = parseInput(createLookupRowInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			await lockProjectState(tx, authority);
			return lookupEditOnce(
				tx,
				authority,
				parsed.operationId,
				"createLookupRow",
				parsed,
				async () => {
					const table = await lockTable(
						tx,
						authority,
						parsed.tableId,
						parsed.expectedTableRevision,
						"author",
					);
					assertCreateIndex(parsed.toIndex, table.row_count, "Row");
					const columns = await orderedColumns(
						tx,
						scope.projectId,
						parsed.tableId,
					);

					const members = await readTableMembers(
						tx,
						scope.projectId,
						parsed.tableId,
					);
					const definition = columns.map((column) =>
						columnWithMembers(column, members.get(column.id)),
					);
					const values = validateRowsAgainstColumns(definition, [
						parsed.values,
					])[0];
					const content = checkedRowContent(
						definition,
						members.get(null) ?? [],
						values,
						parsed.content ?? {},
					);
					const orderKey = await rowOrderForPlacement(
						tx,
						scope.projectId,
						parsed.tableId,
						{ toIndex: parsed.toIndex },
					);
					const inserted = await tx
						.insertInto("lookup_rows")
						.values({
							project_id: scope.projectId,
							table_id: parsed.tableId,
							order_key: orderKey,
							values: JSON.stringify(values),
							content: JSON.stringify(content),
							created_by: scope.actorId,
							updated_by: scope.actorId,
						})
						.returning(["id", "value_bytes"])
						.executeTakeFirstOrThrow();
					if (inserted.value_bytes > LOOKUP_MAX_ROW_BYTES)
						rejectInlineRowLimit();
					const dataBytes = Number(table.data_bytes) + inserted.value_bytes;
					const projectRevision = await advanceProjectRevision(
						tx,
						scope.projectId,
					);
					const updated = await updateLockedTable(
						tx,
						scope.projectId,
						parsed.tableId,
						{
							row_count: table.row_count + 1,
							data_bytes: dataBytes,
							rows_revision: projectRevision,
							updated_by: scope.actorId,
							updated_at: new Date(),
						},
					);
					await notifyCommittedLookupMutation(
						tx,
						scope.projectId,
						projectRevision,
					);
					return {
						rowId: lookupRowIdSchema.parse(inserted.id),
						...receiptOf(updated, projectRevision),
					};
				},
			);
		}),
	);
}

export async function updateLookupRow(
	scope: LookupScope,
	input: UpdateLookupRowInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(updateLookupRowInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			const state = await lockProjectState(tx, authority);
			return lookupEditOnce(
				tx,
				authority,
				parsed.operationId,
				"updateLookupRow",
				parsed,
				async () => {
					const table = await lockTable(
						tx,
						authority,
						parsed.tableId,
						parsed.expectedTableRevision,
						"author",
					);
					const columns = await orderedColumns(
						tx,
						scope.projectId,
						parsed.tableId,
					);
					const members = await readTableMembers(
						tx,
						scope.projectId,
						parsed.tableId,
					);
					const definition = columns.map((column) =>
						columnWithMembers(column, members.get(column.id)),
					);
					let delta: number;
					if ("changes" in parsed) {
						const patch = await patchLookupRowInTransaction(
							tx,
							scope,
							parsed.tableId,
							parsed.rowId,
							definition,
							members.get(null) ?? [],
							parsed.changes,
						);
						if (!patch.changed) return receiptOf(table, state.revision);
						delta = patch.delta;
					} else {
						const values = validateRowsAgainstColumns(definition, [
							parsed.values,
						])[0];
						const content = checkedRowContent(
							definition,
							parsed.content === undefined ? [] : (members.get(null) ?? []),
							values,
							parsed.content ?? {},
						);
						const updated = await replaceLookupRowInTransaction(
							tx,
							scope,
							parsed.tableId,
							parsed.rowId,
							values,
							parsed.content === undefined ? undefined : content,
						);
						if (!updated.changed) return receiptOf(table, state.revision);
						delta = updated.delta;
					}
					const dataBytes = Number(table.data_bytes) + delta;
					const projectRevision = await advanceProjectRevision(
						tx,
						scope.projectId,
					);
					const updated = await updateLockedTable(
						tx,
						scope.projectId,
						parsed.tableId,
						{
							data_bytes: dataBytes,
							rows_revision: projectRevision,
							updated_by: scope.actorId,
							updated_at: new Date(),
						},
					);
					await notifyCommittedLookupMutation(
						tx,
						scope.projectId,
						projectRevision,
					);
					return receiptOf(updated, projectRevision);
				},
			);
		}),
	);
}

export async function deleteLookupRow(
	scope: LookupScope,
	input: DeleteLookupRowInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(deleteLookupRowInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			await lockProjectState(tx, authority);
			return lookupEditOnce(
				tx,
				authority,
				parsed.operationId,
				"deleteLookupRow",
				parsed,
				async () => {
					const table = await lockTable(
						tx,
						authority,
						parsed.tableId,
						parsed.expectedTableRevision,
						"author",
					);
					const deleted = await tx
						.deleteFrom("lookup_rows")
						.where("project_id", "=", scope.projectId)
						.where("table_id", "=", parsed.tableId)
						.where("id", "=", parsed.rowId)
						.returning(["value_bytes", "external_bytes"])
						.executeTakeFirst();
					if (!deleted) notFound();
					const projectRevision = await advanceProjectRevision(
						tx,
						scope.projectId,
					);
					const updated = await updateLockedTable(
						tx,
						scope.projectId,
						parsed.tableId,
						{
							row_count: table.row_count - 1,
							data_bytes:
								Number(table.data_bytes) -
								deleted.value_bytes -
								Number(deleted.external_bytes),
							rows_revision: projectRevision,
							updated_by: scope.actorId,
							updated_at: new Date(),
						},
					);
					await notifyCommittedLookupMutation(
						tx,
						scope.projectId,
						projectRevision,
					);
					return receiptOf(updated, projectRevision);
				},
			);
		}),
	);
}

export async function moveLookupRow(
	scope: LookupScope,
	input: MoveLookupRowInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(moveLookupRowInputSchema, input);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			const state = await lockProjectState(tx, authority);
			return lookupEditOnce(
				tx,
				authority,
				parsed.operationId,
				"moveLookupRow",
				parsed,
				async () => {
					const table = await lockTable(
						tx,
						authority,
						parsed.tableId,
						parsed.expectedTableRevision,
						"author",
					);
					const currentIndex = await rowIndex(
						tx,
						scope.projectId,
						parsed.tableId,
						parsed.rowId,
					);
					assertMoveIndex(parsed.toIndex, table.row_count, "Row");
					if (currentIndex === parsed.toIndex)
						return receiptOf(table, state.revision);
					const orderKey = await rowOrderForPlacement(
						tx,
						scope.projectId,
						parsed.tableId,
						{ toIndex: parsed.toIndex },
						parsed.rowId,
					);
					await tx
						.updateTable("lookup_rows")
						.set({
							order_key: orderKey,
							updated_by: scope.actorId,
							updated_at: new Date(),
						})
						.where("project_id", "=", scope.projectId)
						.where("table_id", "=", parsed.tableId)
						.where("id", "=", parsed.rowId)
						.execute();
					const projectRevision = await advanceProjectRevision(
						tx,
						scope.projectId,
					);
					const updated = await updateLockedTable(
						tx,
						scope.projectId,
						parsed.tableId,
						{
							rows_revision: projectRevision,
							updated_by: scope.actorId,
							updated_at: new Date(),
						},
					);
					await notifyCommittedLookupMutation(
						tx,
						scope.projectId,
						projectRevision,
					);
					return receiptOf(updated, projectRevision);
				},
			);
		}),
	);
}

/** Server-only wholesale replacement. The CSV route is its only browser
 * boundary; every successful nonempty replacement receives fresh row UUIDv7s. */
export async function replayLookupCsvImport(
	scope: LookupScope,
	tableId: LookupTableId,
	expectedTableRevision: LookupRevision,
	operationId: string,
	bodyDigest: string,
) {
	return withAppTx(async (tx) => {
		const authority = await authorizeLookupWriteInTransaction(
			tx,
			scope,
			"edit",
		);
		return lookupPriorReceipt<LookupMutationReceipt>(
			tx,
			authority,
			operationId,
			canonicalJsonDigest({
				kind: "replaceLookupRows",
				input: { tableId, expectedTableRevision, bodyDigest },
			}),
		);
	});
}

export async function replaceLookupRows(
	scope: LookupScope,
	input: ReplaceLookupRowsInput,
	csvBodyDigest?: string,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(replaceLookupRowsInputSchema, input);
	const orderKeys = balancedKeysBetween(null, null, parsed.rows.length);
	return mutation(() =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			const state = await lockProjectState(tx, authority);
			return lookupEditOnce(
				tx,
				authority,
				parsed.operationId,
				"replaceLookupRows",
				csvBodyDigest
					? {
							tableId: parsed.tableId,
							expectedTableRevision: parsed.expectedTableRevision,
							bodyDigest: csvBodyDigest,
						}
					: parsed,
				async () => {
					const table = await lockTable(
						tx,
						authority,
						parsed.tableId,
						parsed.expectedTableRevision,
						"author",
					);
					if (table.worker_access === "assigned")
						throw new LookupError(
							"invalid_input",
							"Replacing this table would clear its row assignments. You can update individual rows and keep their workers, groups and places.",
						);
					const columns = await orderedColumns(
						tx,
						scope.projectId,
						parsed.tableId,
					);
					const members = await readTableMembers(
						tx,
						scope.projectId,
						parsed.tableId,
					);
					if (members.has(null) || columns.some((column) => column.repeated))
						throw new LookupError(
							"invalid_input",
							"CSV can replace rows in a table with single values. You can edit this table’s repeated values and row details in Project data.",
						);
					const values = validateRowsAgainstColumns(
						columns.map((column) => columnWithMembers(column)),
						parsed.rows,
					);
					if (values.length === 0 && table.row_count === 0) {
						return receiptOf(table, state.revision);
					}
					await tx
						.deleteFrom("lookup_rows")
						.where("project_id", "=", scope.projectId)
						.where("table_id", "=", parsed.tableId)
						.execute();
					let dataBytes = 0;
					if (values.length > 0) {
						const inserted = await tx
							.insertInto("lookup_rows")
							.values(
								values.map((rowValues, index) => ({
									project_id: scope.projectId,
									table_id: parsed.tableId,
									order_key: orderKeys[index],
									values: JSON.stringify(rowValues),
									created_by: scope.actorId,
									updated_by: scope.actorId,
								})),
							)
							.returning("value_bytes")
							.execute();
						if (inserted.some((row) => row.value_bytes > LOOKUP_MAX_ROW_BYTES))
							rejectInlineRowLimit();
						dataBytes = inserted.reduce(
							(total, row) => total + row.value_bytes,
							0,
						);
					}
					if (dataBytes > LOOKUP_MAX_CHANGE_BYTES)
						rejectStorageLimit(dataBytes);
					const projectRevision = await advanceProjectRevision(
						tx,
						scope.projectId,
					);
					const updated = await updateLockedTable(
						tx,
						scope.projectId,
						parsed.tableId,
						{
							row_count: values.length,
							data_bytes: dataBytes,
							rows_revision: projectRevision,
							updated_by: scope.actorId,
							updated_at: new Date(),
						},
					);
					await notifyCommittedLookupMutation(
						tx,
						scope.projectId,
						projectRevision,
					);
					return receiptOf(updated, projectRevision);
				},
			);
		}),
	);
}
