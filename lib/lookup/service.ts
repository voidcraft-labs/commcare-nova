import "server-only";

import {
	type Selectable,
	sql,
	type Transaction,
	type Updateable,
} from "kysely";
import type { ZodType } from "zod";
import {
	type AppDatabase,
	getAppDb,
	type LookupColumnsTable,
	type LookupRowsTable,
	type LookupTablesTable,
	notifyLookupProject,
	withAppTx,
} from "@/lib/db/pg";
import { balancedKeysBetween, deriveKeyAtIndex } from "@/lib/doc/order/keys";
import { validateLookupRowValues } from "./coercion";
import {
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
	LOOKUP_MAX_VALIDATION_DETAILS,
} from "./constants";
import { LookupError } from "./errors";
import {
	addLookupColumnInputSchema,
	createLookupRowInputSchema,
	createLookupTableInputSchema,
	deleteLookupRowInputSchema,
	lookupIdSchema,
	maxLookupRevision,
	moveLookupColumnInputSchema,
	moveLookupRowInputSchema,
	parseLookupRevision,
	replaceLookupRowsInputSchema,
	updateLookupColumnLabelInputSchema,
	updateLookupColumnWireNameInputSchema,
	updateLookupRowInputSchema,
	updateLookupTableNameInputSchema,
	updateLookupTableTagInputSchema,
} from "./schema";
import type {
	AddLookupColumnInput,
	CreateLookupRowInput,
	CreateLookupTableInput,
	DeleteLookupRowInput,
	LookupColumn,
	LookupCreatedColumnReceipt,
	LookupCreatedRowReceipt,
	LookupId,
	LookupManifest,
	LookupMutationReceipt,
	LookupRevision,
	LookupRow,
	LookupRowValues,
	LookupScope,
	LookupTableManifestEntry,
	LookupTableRevisions,
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

type StoredTable = Selectable<LookupTablesTable>;
type StoredColumn = Selectable<LookupColumnsTable>;
type StoredRow = Selectable<LookupRowsTable>;

interface LockedProjectState {
	revision: LookupRevision;
}

/**
 * The service receives a scope only after a request boundary has authenticated
 * and authorized the exact Project. Role checks deliberately stay at that
 * boundary; this assertion catches an internal caller constructing a broken
 * scope without turning attribution into a second access gate.
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

function parseTableId(value: unknown): LookupId {
	return parseInput(lookupIdSchema, value);
}

function toIso(value: Date): string {
	return value.toISOString();
}

function revisionsOf(table: StoredTable): LookupTableRevisions {
	const definitionRevision = parseLookupRevision(table.definition_revision);
	const rowsRevision = parseLookupRevision(table.rows_revision);
	return {
		definitionRevision,
		rowsRevision,
		tableRevision: maxLookupRevision(definitionRevision, rowsRevision),
	};
}

function manifestEntryOf(table: StoredTable): LookupTableManifestEntry {
	return {
		id: table.id as LookupId,
		name: table.name,
		tag: table.tag,
		columnCount: table.column_count,
		rowCount: table.row_count,
		dataBytes: table.data_bytes,
		...revisionsOf(table),
	};
}

function columnOf(row: StoredColumn): LookupColumn {
	return {
		id: row.id as LookupId,
		wireName: row.wire_name,
		label: row.label,
		dataType: row.data_type,
	};
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function lookupRowOf(row: StoredRow): LookupRow {
	return {
		id: row.id as LookupId,
		values: row.values as LookupRowValues,
		valueBytes: row.value_bytes,
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
	rows: readonly StoredRow[];
}): LookupTableSnapshot {
	return {
		projectId: args.projectId,
		projectRevision: args.projectRevision,
		id: args.table.id as LookupId,
		name: args.table.name,
		tag: args.table.tag,
		columns: args.columns.map(columnOf),
		columnCount: args.table.column_count,
		rows: args.rows.map(lookupRowOf),
		rowCount: args.table.row_count,
		dataBytes: args.table.data_bytes,
		createdBy: args.table.created_by,
		updatedBy: args.table.updated_by,
		createdAt: toIso(args.table.created_at),
		updatedAt: toIso(args.table.updated_at),
		...revisionsOf(args.table),
	};
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

function currentRevisionConflict(table: StoredTable): never {
	throw new LookupError(
		"conflict",
		"This lookup table changed since it was loaded. Refresh and try again.",
		{ currentRevisions: revisionsOf(table) },
	);
}

function assertExpectedRevision(
	table: StoredTable,
	expected: LookupRevision,
): void {
	if (revisionsOf(table).tableRevision !== expected) {
		currentRevisionConflict(table);
	}
}

async function lockProjectState(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<LockedProjectState> {
	await tx
		.insertInto("lookup_project_state")
		.values({ project_id: projectId })
		.onConflict((conflict) => conflict.column("project_id").doNothing())
		.execute();
	const state = await tx
		.selectFrom("lookup_project_state")
		.select("revision")
		.where("project_id", "=", projectId)
		.forUpdate()
		.executeTakeFirst();
	if (!state) {
		throw new Error(
			"Lookup Project state disappeared after its locked upsert.",
		);
	}
	return { revision: parseLookupRevision(state.revision) };
}

async function lockTable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupId,
	expectedRevision: LookupRevision,
): Promise<StoredTable> {
	const table = await tx
		.selectFrom("lookup_tables")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("id", "=", tableId)
		.forUpdate()
		.executeTakeFirst();
	if (!table) notFound();
	assertExpectedRevision(table, expectedRevision);
	return table;
}

async function orderedColumns(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupId,
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
	tableId: LookupId,
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

async function advanceProjectRevision(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<LookupRevision> {
	const row = await tx
		.updateTable("lookup_project_state")
		.set({
			revision: sql<string>`revision + 1`,
			updated_at: new Date(),
		})
		.where("project_id", "=", projectId)
		.returning("revision")
		.executeTakeFirst();
	if (!row) {
		throw new Error(
			"Lookup Project state disappeared while advancing revision.",
		);
	}
	return parseLookupRevision(row.revision);
}

async function updateLockedTable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupId,
	values: Updateable<LookupTablesTable>,
): Promise<StoredTable> {
	const table = await tx
		.updateTable("lookup_tables")
		.set(values)
		.where("project_id", "=", projectId)
		.where("id", "=", tableId)
		.returningAll()
		.executeTakeFirst();
	if (!table) {
		throw new Error("Locked lookup table disappeared before its update.");
	}
	return table;
}

async function notifyCommittedLookupMutation(
	tx: Transaction<AppDatabase>,
	projectId: string,
	projectRevision: LookupRevision,
): Promise<void> {
	await notifyLookupProject(tx, projectId, projectRevision);
}

function valuesEqual(left: LookupRowValues, right: LookupRowValues): boolean {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	if (leftKeys.length !== rightKeys.length) return false;
	for (let index = 0; index < leftKeys.length; index++) {
		const key = leftKeys[index];
		if (
			key !== rightKeys[index] ||
			left[key as LookupId] !== right[key as LookupId]
		) {
			return false;
		}
	}
	return true;
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
			"That column wire name is already used in this table.",
			{ cause: error },
		);
	}
	if (
		sqlError.code === "23514" &&
		constraint === "lookup_rows_value_bytes_check"
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

/** Complete definition and ordered row body from one repeatable-read snapshot. */
export async function getLookupTable(
	scope: LookupScope,
	tableIdInput: LookupId,
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
			const columns = await orderedColumns(tx, scope.projectId, tableId);
			const rows = await orderedRows(tx, scope.projectId, tableId);
			return snapshotOf({
				projectId: scope.projectId,
				projectRevision: parseLookupRevision(state?.revision ?? "0"),
				table,
				columns,
				rows,
			});
		});
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
			await lockProjectState(tx, scope.projectId);
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
			const columns = await tx
				.insertInto("lookup_columns")
				.values(
					parsed.columns.map((column, index) => ({
						project_id: scope.projectId,
						table_id: table.id,
						wire_name: column.wireName,
						label: column.label,
						data_type: column.dataType,
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
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return snapshotOf({
				projectId: scope.projectId,
				projectRevision,
				table,
				columns,
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
			const state = await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
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
			const state = await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
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
			await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
			);
			if (table.column_count >= LOOKUP_MAX_COLUMNS) {
				throw new LookupError(
					"invalid_input",
					`A lookup table may have at most ${LOOKUP_MAX_COLUMNS} columns.`,
				);
			}
			const columns = await orderedColumns(tx, scope.projectId, parsed.tableId);
			if (columns.some((item) => item.wire_name === parsed.column.wireName)) {
				throw new LookupError(
					"invalid_input",
					"That column wire name is already used in this table.",
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
					order_key: orderKey,
				})
				.returning("id")
				.executeTakeFirstOrThrow();
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
				columnId: column.id as LookupId,
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
			const state = await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				input.tableId,
				input.expectedTableRevision,
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
						"That column wire name is already used in this table.",
					);
				}
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
			const state = await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
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
			await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
			);
			if (table.row_count >= LOOKUP_MAX_ROWS) {
				throw new LookupError(
					"row_limit",
					`A lookup table may have at most ${LOOKUP_MAX_ROWS} rows.`,
				);
			}
			assertCreateIndex(parsed.toIndex, table.row_count, "Row");
			const columns = await orderedColumns(tx, scope.projectId, parsed.tableId);
			const rows = await orderedRows(tx, scope.projectId, parsed.tableId);
			const values = validateRowsAgainstColumns(columns.map(columnOf), [
				parsed.values,
			])[0];
			const orderKey = deriveKeyAtIndex(
				rows.map((row) => row.order_key),
				parsed.toIndex,
			);
			const inserted = await tx
				.insertInto("lookup_rows")
				.values({
					project_id: scope.projectId,
					table_id: parsed.tableId,
					order_key: orderKey,
					values: JSON.stringify(values),
					created_by: scope.actorId,
					updated_by: scope.actorId,
				})
				.returning(["id", "value_bytes"])
				.executeTakeFirstOrThrow();
			const dataBytes = table.data_bytes + inserted.value_bytes;
			if (dataBytes > LOOKUP_MAX_TABLE_BYTES) {
				throw new LookupError(
					"storage_limit",
					"This lookup table has reached its storage limit.",
				);
			}
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
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
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return {
				rowId: inserted.id as LookupId,
				...receiptOf(updated, projectRevision),
			};
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
			const state = await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
			);
			const columns = await orderedColumns(tx, scope.projectId, parsed.tableId);
			const values = validateRowsAgainstColumns(columns.map(columnOf), [
				parsed.values,
			])[0];
			const current = await tx
				.selectFrom("lookup_rows")
				.selectAll()
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", parsed.tableId)
				.where("id", "=", parsed.rowId)
				.executeTakeFirst();
			if (!current) notFound();
			if (valuesEqual(current.values as LookupRowValues, values)) {
				return receiptOf(table, state.revision);
			}
			const updatedRow = await tx
				.updateTable("lookup_rows")
				.set({
					values: JSON.stringify(values),
					updated_by: scope.actorId,
					updated_at: new Date(),
				})
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", parsed.tableId)
				.where("id", "=", parsed.rowId)
				.returning("value_bytes")
				.executeTakeFirstOrThrow();
			const dataBytes =
				table.data_bytes - current.value_bytes + updatedRow.value_bytes;
			if (dataBytes > LOOKUP_MAX_TABLE_BYTES) {
				throw new LookupError(
					"storage_limit",
					"This lookup table has reached its storage limit.",
				);
			}
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
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
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
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
			await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
			);
			const deleted = await tx
				.deleteFrom("lookup_rows")
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", parsed.tableId)
				.where("id", "=", parsed.rowId)
				.returning("value_bytes")
				.executeTakeFirst();
			if (!deleted) notFound();
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
			const updated = await updateLockedTable(
				tx,
				scope.projectId,
				parsed.tableId,
				{
					row_count: table.row_count - 1,
					data_bytes: table.data_bytes - deleted.value_bytes,
					rows_revision: projectRevision,
					updated_by: scope.actorId,
					updated_at: new Date(),
				},
			);
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
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
			const state = await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
			);
			const rows = await orderedRows(tx, scope.projectId, parsed.tableId);
			const currentIndex = rows.findIndex((row) => row.id === parsed.rowId);
			if (currentIndex < 0) notFound();
			assertMoveIndex(parsed.toIndex, rows.length, "Row");
			if (currentIndex === parsed.toIndex)
				return receiptOf(table, state.revision);
			const siblings = rows.filter((row) => row.id !== parsed.rowId);
			const orderKey = deriveKeyAtIndex(
				siblings.map((row) => row.order_key),
				parsed.toIndex,
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
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
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
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
		}),
	);
}

/** Server-only wholesale replacement. The CSV route is its only browser
 * boundary; every successful nonempty replacement receives fresh row UUIDv7s. */
export async function replaceLookupRows(
	scope: LookupScope,
	input: ReplaceLookupRowsInput,
): Promise<LookupMutationReceipt> {
	assertScope(scope);
	const parsed = parseInput(replaceLookupRowsInputSchema, input);
	const orderKeys = balancedKeysBetween(null, null, parsed.rows.length);
	return mutation(() =>
		withAppTx(async (tx) => {
			const state = await lockProjectState(tx, scope.projectId);
			const table = await lockTable(
				tx,
				scope.projectId,
				parsed.tableId,
				parsed.expectedTableRevision,
			);
			const columns = await orderedColumns(tx, scope.projectId, parsed.tableId);
			const values = validateRowsAgainstColumns(
				columns.map(columnOf),
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
				dataBytes = inserted.reduce((total, row) => total + row.value_bytes, 0);
			}
			if (dataBytes > LOOKUP_MAX_TABLE_BYTES) {
				throw new LookupError(
					"storage_limit",
					"This lookup table has reached its storage limit.",
				);
			}
			const projectRevision = await advanceProjectRevision(tx, scope.projectId);
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
			await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
			return receiptOf(updated, projectRevision);
		}),
	);
}
