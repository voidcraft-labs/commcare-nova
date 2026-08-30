import "server-only";

import { sql, type Transaction } from "kysely";
import type { z } from "zod";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type LookupColumnId,
	type LookupRowId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { validateLookupRowValues } from "./coercion";
import {
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "./constants";
import { LookupError } from "./errors";
import { balancedKeysBetween, deriveKeyAtIndex } from "./orderKeys";
import {
	lookupColumnDraftSchema,
	lookupColumnLabelSchema,
	lookupDataTypeSchema,
	lookupRevisionSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
	parseLookupRevision,
} from "./schema";
import type {
	LookupAuthoringBatchInput,
	LookupAuthoringBatchReceipt,
	LookupAuthoringCell,
	LookupAuthoringColumnOperation,
	LookupAuthoringExistingTable,
	LookupAuthoringRowOperation,
	LookupColumn,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupRowValues,
	LookupScope,
} from "./types";
import {
	advanceLookupProjectRevision,
	lockLookupProjectState,
	lockLookupTableForUpdate,
	lookupTableRevisions,
	notifyCommittedLookupMutation,
	type StoredLookupTable,
	updateLockedLookupTable,
} from "./writerTransaction";

interface MutableColumn extends LookupColumn {
	orderKey: string;
}

interface MutableRow {
	id: LookupRowId;
	orderKey: string;
	values: LookupRowValues;
}

interface TableWork {
	input: LookupAuthoringExistingTable;
	table: StoredLookupTable;
	columns: MutableColumn[];
	rows: MutableRow[];
	columnIds: { key: string; id: LookupColumnId }[];
	rowIds: { key: string; id: LookupRowId }[];
	definitionChanged: boolean;
	rowsChanged: boolean;
	deleted: boolean;
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
	throw new LookupError("invalid_input", message);
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		invalid(result.error.issues[0]?.message ?? `${label} is invalid.`);
	}
	return result.data;
}

function notFound(): never {
	throw new LookupError("not_found", "Lookup resource was not found.");
}

function acceptedDesignDependency(): never {
	throw new LookupError(
		"accepted_design",
		"An accepted app design still depends on this lookup resource while its app is being created. Finish or supersede that design before removing or retyping the resource.",
	);
}

function referenced(
	blockingApps: readonly LookupReferencingAppSummary[],
): never {
	throw new LookupError(
		"referenced",
		blockingApps.length >= 100
			? "At least 100 apps still reference this lookup resource. The first 100 are included."
			: "One or more apps still reference this lookup resource.",
		{ blockingApps },
	);
}

function assertScope(scope: LookupScope): void {
	if (
		typeof scope.projectId !== "string" ||
		scope.projectId.length === 0 ||
		typeof scope.actorId !== "string" ||
		scope.actorId.length === 0 ||
		typeof scope.role !== "string" ||
		scope.role.length === 0
	) {
		throw new Error("Lookup authoring batch received an invalid scope.");
	}
}

function needsDeleteCapability(input: LookupAuthoringBatchInput): boolean {
	return (input.updateTables ?? []).some(
		(table) =>
			table.delete === true ||
			table.tag !== undefined ||
			(table.columnOperations ?? []).some(
				(operation) =>
					operation.kind === "remove" ||
					operation.kind === "retype" ||
					(operation.kind === "update" && operation.wireName !== undefined),
			),
	);
}

function assertCapability(
	scope: LookupScope,
	input: LookupAuthoringBatchInput,
): void {
	const capability = needsDeleteCapability(input) ? "delete" : "edit";
	if (!roleAllowsApp(scope.role, capability)) notFound();
}

function assertKey(value: string, label: string): void {
	if (
		value.length === 0 ||
		value.length > 200 ||
		value.includes("\0") ||
		!/[A-Za-z0-9]/.test(value)
	) {
		invalid(`${label} must be a nonblank request-local key.`);
	}
}

function assertUniqueKeys(
	items: readonly { key: string }[],
	label: string,
): void {
	const seen = new Set<string>();
	for (const item of items) {
		assertKey(item.key, label);
		if (seen.has(item.key)) invalid(`Duplicate ${label} "${item.key}".`);
		seen.add(item.key);
	}
}

function parseBatch(
	input: LookupAuthoringBatchInput,
): LookupAuthoringBatchInput {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		invalid("Lookup authoring input must be an object.");
	}
	const creates = input.createTables ?? [];
	const updates = input.updateTables ?? [];
	if (creates.length === 0 && updates.length === 0) {
		invalid("A lookup authoring batch needs at least one table change.");
	}
	assertUniqueKeys(creates, "table key");
	const tableIds = new Set<string>();
	for (const create of creates) {
		parseInput(lookupTableNameSchema, create.name, "Table name");
		parseInput(lookupTagSchema, create.tag, "Table tag");
		if (
			create.columns.length === 0 ||
			create.columns.length > LOOKUP_MAX_COLUMNS
		) {
			invalid(
				`A lookup table needs between 1 and ${LOOKUP_MAX_COLUMNS} columns.`,
			);
		}
		if (create.rows.length > LOOKUP_MAX_ROWS) {
			invalid(`A lookup table may have at most ${LOOKUP_MAX_ROWS} rows.`);
		}
		assertUniqueKeys(create.columns, "column key");
		assertUniqueKeys(create.rows, "row key");
		const wireNames = new Set<string>();
		for (const column of create.columns) {
			parseInput(
				lookupColumnDraftSchema,
				{
					wireName: column.wireName,
					label: column.label,
					dataType: column.dataType,
				},
				"Column",
			);
			if (wireNames.has(column.wireName)) {
				invalid(`Duplicate column wire name "${column.wireName}".`);
			}
			wireNames.add(column.wireName);
		}
	}
	for (const update of updates) {
		parseInput(lookupTableIdSchema, update.tableId, "Table id");
		parseInput(
			lookupRevisionSchema,
			update.expectedTableRevision,
			"Expected table revision",
		);
		if (tableIds.has(update.tableId)) {
			invalid(`Table "${update.tableId}" appears more than once in the batch.`);
		}
		tableIds.add(update.tableId);
		if (update.name !== undefined) {
			parseInput(lookupTableNameSchema, update.name, "Table name");
		}
		if (update.tag !== undefined) {
			parseInput(lookupTagSchema, update.tag, "Table tag");
		}
		if (
			update.replaceRows !== undefined &&
			update.rowOperations !== undefined
		) {
			invalid("replaceRows and rowOperations cannot appear together.");
		}
		if (update.delete === true) {
			if (
				update.name !== undefined ||
				update.tag !== undefined ||
				(update.columnOperations?.length ?? 0) > 0 ||
				(update.rowOperations?.length ?? 0) > 0 ||
				update.replaceRows !== undefined
			) {
				invalid(
					"Deleting a table cannot be combined with edits to that table.",
				);
			}
		}
		const addedColumns = (update.columnOperations ?? []).filter(
			(
				operation,
			): operation is Extract<
				LookupAuthoringColumnOperation,
				{ kind: "add" }
			> => operation.kind === "add",
		);
		assertUniqueKeys(addedColumns, "column key");
		for (const operation of update.columnOperations ?? []) {
			validateColumnOperation(operation);
		}
		const addedRows = (update.rowOperations ?? []).filter(
			(
				operation,
			): operation is Extract<LookupAuthoringRowOperation, { kind: "add" }> =>
				operation.kind === "add",
		);
		assertUniqueKeys(addedRows, "row key");
		for (const operation of update.rowOperations ?? []) {
			validateRowOperation(operation);
		}
		if (update.replaceRows !== undefined) {
			if (update.replaceRows.length > LOOKUP_MAX_ROWS) {
				invalid(`A lookup table may have at most ${LOOKUP_MAX_ROWS} rows.`);
			}
			assertUniqueKeys(update.replaceRows, "row key");
		}
	}
	return input;
}

function validateColumnOperation(
	operation: LookupAuthoringColumnOperation,
): void {
	switch (operation.kind) {
		case "add":
			assertKey(operation.key, "column key");
			parseInput(lookupColumnDraftSchema, operation.column, "Column");
			if (
				operation.afterColumnId !== undefined &&
				operation.afterColumnId !== null
			) {
				parseInput(
					lookupColumnIdSchema,
					operation.afterColumnId,
					"Column anchor id",
				);
			}
			if (
				operation.afterColumnId !== undefined &&
				operation.afterColumnKey !== undefined
			) {
				invalid("Use afterColumnId or afterColumnKey, not both.");
			}
			if (operation.afterColumnKey !== undefined) {
				assertKey(operation.afterColumnKey, "column anchor key");
			}
			return;
		case "update":
			parseInput(lookupColumnIdSchema, operation.columnId, "Column id");
			if (operation.label === undefined && operation.wireName === undefined) {
				invalid("A column update needs a label or wireName change.");
			}
			if (operation.label !== undefined) {
				parseInput(lookupColumnLabelSchema, operation.label, "Column label");
			}
			if (operation.wireName !== undefined) {
				parseInput(
					lookupWireNameSchema,
					operation.wireName,
					"Column wire name",
				);
			}
			return;
		case "move":
			if (
				(operation.columnId === undefined) ===
				(operation.columnKey === undefined)
			) {
				invalid("A column move needs exactly one of columnId or columnKey.");
			}
			if (operation.columnId !== undefined) {
				parseInput(lookupColumnIdSchema, operation.columnId, "Column id");
			}
			if (operation.columnKey !== undefined)
				assertKey(operation.columnKey, "column key");
			if (
				(operation.afterColumnId === undefined) ===
				(operation.afterColumnKey === undefined)
			) {
				invalid(
					"A column move needs exactly one of afterColumnId or afterColumnKey.",
				);
			}
			if (
				operation.afterColumnId !== undefined &&
				operation.afterColumnId !== null
			) {
				parseInput(
					lookupColumnIdSchema,
					operation.afterColumnId,
					"Column anchor id",
				);
			}
			if (operation.afterColumnKey !== undefined) {
				assertKey(operation.afterColumnKey, "column anchor key");
			}
			if (
				(operation.afterColumnId !== undefined &&
					operation.afterColumnId === operation.columnId) ||
				(operation.afterColumnKey !== undefined &&
					operation.afterColumnKey === operation.columnKey)
			) {
				invalid("A column cannot be moved after itself.");
			}
			return;
		case "remove":
			parseInput(lookupColumnIdSchema, operation.columnId, "Column id");
			return;
		case "retype":
			parseInput(lookupColumnIdSchema, operation.columnId, "Column id");
			parseInput(lookupDataTypeSchema, operation.dataType, "Column data type");
	}
}

function validateRowOperation(operation: LookupAuthoringRowOperation): void {
	switch (operation.kind) {
		case "add":
			assertKey(operation.key, "row key");
			if (operation.afterRowId !== undefined && operation.afterRowId !== null) {
				parseInput(lookupRowIdSchema, operation.afterRowId, "Row anchor id");
			}
			if (
				operation.afterRowId !== undefined &&
				operation.afterRowKey !== undefined
			) {
				invalid("Use afterRowId or afterRowKey, not both.");
			}
			if (operation.afterRowKey !== undefined) {
				assertKey(operation.afterRowKey, "row anchor key");
			}
			return;
		case "update":
			parseInput(lookupRowIdSchema, operation.rowId, "Row id");
			return;
		case "move":
			if (
				(operation.rowId === undefined) ===
				(operation.rowKey === undefined)
			) {
				invalid("A row move needs exactly one of rowId or rowKey.");
			}
			if (operation.rowId !== undefined) {
				parseInput(lookupRowIdSchema, operation.rowId, "Row id");
			}
			if (operation.rowKey !== undefined)
				assertKey(operation.rowKey, "row key");
			if (
				(operation.afterRowId === undefined) ===
				(operation.afterRowKey === undefined)
			) {
				invalid("A row move needs exactly one of afterRowId or afterRowKey.");
			}
			if (operation.afterRowId !== undefined && operation.afterRowId !== null) {
				parseInput(lookupRowIdSchema, operation.afterRowId, "Row anchor id");
			}
			if (operation.afterRowKey !== undefined) {
				assertKey(operation.afterRowKey, "row anchor key");
			}
			if (
				(operation.afterRowId !== undefined &&
					operation.afterRowId === operation.rowId) ||
				(operation.afterRowKey !== undefined &&
					operation.afterRowKey === operation.rowKey)
			) {
				invalid("A row cannot be moved after itself.");
			}
			return;
		case "remove":
			parseInput(lookupRowIdSchema, operation.rowId, "Row id");
	}
}

async function mintIds(
	tx: Transaction<AppDatabase>,
	count: number,
): Promise<string[]> {
	if (count === 0) return [];
	const result = await sql<{ ordinal: number; id: string }>`
		SELECT (ordinality - 1)::integer AS ordinal, uuidv7()::text AS id
		FROM generate_series(1, ${count}) WITH ORDINALITY AS generated(value, ordinality)
		ORDER BY ordinality
	`.execute(tx);
	if (result.rows.length !== count) {
		throw new Error("Postgres returned the wrong number of lookup UUIDs.");
	}
	return result.rows.map((row, index) => {
		if (row.ordinal !== index) {
			throw new Error("Postgres returned lookup UUIDs out of order.");
		}
		return row.id;
	});
}

function valuesFromCells(
	columns: readonly LookupColumn[],
	columnKeys: ReadonlyMap<string, LookupColumnId>,
	cells: readonly LookupAuthoringCell[],
): LookupRowValues {
	const raw: Record<string, string | number> = {};
	for (const cell of cells) {
		const columnId =
			"columnId" in cell ? cell.columnId : columnKeys.get(cell.columnKey);
		if (columnId === undefined) {
			invalid(
				`No column was created for request key "${"columnKey" in cell ? cell.columnKey : ""}".`,
			);
		}
		if (Object.hasOwn(raw, columnId)) {
			invalid(`A row names column "${columnId}" more than once.`);
		}
		raw[columnId] = cell.value;
	}
	const result = validateLookupRowValues(columns, raw);
	if (!result.success) {
		throw new LookupError(
			"invalid_input",
			"One or more lookup row values are invalid for the current columns.",
			{ details: result.issues, totalDetailCount: result.totalIssueCount },
		);
	}
	return result.values;
}

function insertionIndex<T extends { id: string }>(
	items: readonly T[],
	afterId: string | null | undefined,
	noun: string,
): number {
	if (afterId === undefined) return items.length;
	if (afterId === null) return 0;
	const index = items.findIndex((item) => item.id === afterId);
	if (index < 0) notFound();
	if (index >= items.length) invalid(`${noun} anchor is outside the table.`);
	return index + 1;
}

function sameValues(left: LookupRowValues, right: LookupRowValues): boolean {
	const leftKeys = Object.keys(left).sort(compareAscii);
	const rightKeys = Object.keys(right).sort(compareAscii);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key, index) =>
				key === rightKeys[index] &&
				left[key as LookupColumnId] === right[key as LookupColumnId],
		)
	);
}

async function hasTableProtection(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
): Promise<boolean> {
	return (
		(await tx
			.selectFrom("design_lookup_protections")
			.select("id")
			.where("project_id", "=", projectId)
			.where("table_id", "=", tableId)
			.executeTakeFirst()) !== undefined
	);
}

async function hasColumnProtection(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId,
): Promise<boolean> {
	return (
		(await tx
			.selectFrom("design_lookup_protections")
			.select("id")
			.where("project_id", "=", projectId)
			.where("table_id", "=", tableId)
			.where((eb) =>
				eb.or([eb("column_id", "is", null), eb("column_id", "=", columnId)]),
			)
			.executeTakeFirst()) !== undefined
	);
}

async function blockingAppsFor(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId?: LookupColumnId,
): Promise<LookupReferencingAppSummary[]> {
	const edges =
		columnId === undefined
			? tx
					.selectFrom("lookup_table_references")
					.select("app_id")
					.where("project_id", "=", projectId)
					.where("table_id", "=", tableId)
			: tx
					.selectFrom("lookup_column_references")
					.select("app_id")
					.where("project_id", "=", projectId)
					.where("table_id", "=", tableId)
					.where("column_id", "=", columnId);
	const rows = await tx
		.selectFrom("apps")
		.select(["id", "app_name", "deleted_at"])
		.where("project_id", "=", projectId)
		.where("id", "in", edges)
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

async function assertTableRemovable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
): Promise<void> {
	if (await hasTableProtection(tx, projectId, tableId))
		acceptedDesignDependency();
	const blockingApps = await blockingAppsFor(tx, projectId, tableId);
	if (blockingApps.length > 0) referenced(blockingApps);
}

async function assertColumnDestructiveChangeAllowed(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId,
): Promise<void> {
	if (await hasColumnProtection(tx, projectId, tableId, columnId)) {
		acceptedDesignDependency();
	}
	const blockingApps = await blockingAppsFor(tx, projectId, tableId, columnId);
	if (blockingApps.length > 0) referenced(blockingApps);
}

async function loadWork(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	input: LookupAuthoringExistingTable,
): Promise<TableWork> {
	const table = await lockLookupTableForUpdate(
		tx,
		scope.projectId,
		input.tableId,
		input.expectedTableRevision,
	);
	const columns = await tx
		.selectFrom("lookup_columns")
		.selectAll()
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", input.tableId)
		.orderBy("order_key", "asc")
		.orderBy("id", "asc")
		.execute();
	const rows = await tx
		.selectFrom("lookup_rows")
		.selectAll()
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", input.tableId)
		.orderBy("order_key", "asc")
		.orderBy("id", "asc")
		.execute();
	return {
		input,
		table,
		columns: columns.map((column) => ({
			id: lookupColumnIdSchema.parse(column.id),
			wireName: column.wire_name,
			label: column.label,
			dataType: column.data_type,
			orderKey: column.order_key,
		})),
		rows: rows.map((row) => ({
			id: lookupRowIdSchema.parse(row.id),
			orderKey: row.order_key,
			values: row.values as LookupRowValues,
		})),
		columnIds: [],
		rowIds: [],
		definitionChanged: false,
		rowsChanged: false,
		deleted: false,
	};
}

async function applyColumnOperations(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	work: TableWork,
): Promise<Map<string, LookupColumnId>> {
	const keyMap = new Map<string, LookupColumnId>();
	const addCount = (work.input.columnOperations ?? []).filter(
		(operation) => operation.kind === "add",
	).length;
	const minted = (await mintIds(tx, addCount)).map((id) =>
		lookupColumnIdSchema.parse(id),
	);
	let mintedIndex = 0;
	for (const operation of work.input.columnOperations ?? []) {
		switch (operation.kind) {
			case "add": {
				if (keyMap.has(operation.key))
					invalid(`Duplicate column key "${operation.key}".`);
				if (work.columns.length >= LOOKUP_MAX_COLUMNS) {
					invalid(
						`A lookup table may have at most ${LOOKUP_MAX_COLUMNS} columns.`,
					);
				}
				if (
					work.columns.some(
						(column) => column.wireName === operation.column.wireName,
					)
				) {
					invalid(
						`Column wire name "${operation.column.wireName}" is already used in this table.`,
					);
				}
				const id = minted[mintedIndex++];
				const afterColumnId =
					operation.afterColumnKey === undefined
						? operation.afterColumnId
						: keyMap.get(operation.afterColumnKey);
				if (
					operation.afterColumnKey !== undefined &&
					afterColumnId === undefined
				) {
					invalid(
						`Column anchor key "${operation.afterColumnKey}" has not been created earlier in this batch.`,
					);
				}
				const index = insertionIndex(work.columns, afterColumnId, "Column");
				const orderKey = deriveKeyAtIndex(
					work.columns.map((column) => column.orderKey),
					index,
				);
				await tx
					.insertInto("lookup_columns")
					.values({
						project_id: scope.projectId,
						table_id: work.input.tableId,
						id,
						wire_name: operation.column.wireName,
						label: operation.column.label,
						data_type: operation.column.dataType,
						order_key: orderKey,
					})
					.execute();
				work.columns.splice(index, 0, { id, orderKey, ...operation.column });
				keyMap.set(operation.key, id);
				work.columnIds.push({ key: operation.key, id });
				work.definitionChanged = true;
				break;
			}
			case "update": {
				const column = work.columns.find(
					(candidate) => candidate.id === operation.columnId,
				);
				if (column === undefined) notFound();
				const nextLabel = operation.label ?? column.label;
				const nextWireName = operation.wireName ?? column.wireName;
				if (
					nextWireName !== column.wireName &&
					work.columns.some(
						(candidate) =>
							candidate.id !== column.id && candidate.wireName === nextWireName,
					)
				) {
					invalid(
						`Column wire name "${nextWireName}" is already used in this table.`,
					);
				}
				if (nextLabel === column.label && nextWireName === column.wireName)
					break;
				await tx
					.updateTable("lookup_columns")
					.set({ label: nextLabel, wire_name: nextWireName })
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", column.id)
					.execute();
				column.label = nextLabel;
				column.wireName = nextWireName;
				work.definitionChanged = true;
				break;
			}
			case "move": {
				const targetId =
					operation.columnId ??
					(operation.columnKey === undefined
						? undefined
						: keyMap.get(operation.columnKey));
				if (targetId === undefined) {
					invalid(
						`Column key "${operation.columnKey ?? ""}" has not been created earlier in this batch.`,
					);
				}
				const currentIndex = work.columns.findIndex(
					(column) => column.id === targetId,
				);
				if (currentIndex < 0) notFound();
				const [column] = work.columns.splice(currentIndex, 1);
				const afterColumnId =
					operation.afterColumnKey === undefined
						? operation.afterColumnId
						: keyMap.get(operation.afterColumnKey);
				if (
					operation.afterColumnKey !== undefined &&
					afterColumnId === undefined
				) {
					invalid(
						`Column anchor key "${operation.afterColumnKey}" has not been created earlier in this batch.`,
					);
				}
				const index = insertionIndex(work.columns, afterColumnId, "Column");
				if (index === currentIndex) {
					work.columns.splice(currentIndex, 0, column);
					break;
				}
				const orderKey = deriveKeyAtIndex(
					work.columns.map((candidate) => candidate.orderKey),
					index,
				);
				await tx
					.updateTable("lookup_columns")
					.set({ order_key: orderKey })
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", column.id)
					.execute();
				column.orderKey = orderKey;
				work.columns.splice(index, 0, column);
				work.definitionChanged = true;
				break;
			}
			case "remove": {
				if (work.columns.length <= 1) {
					throw new LookupError(
						"last_column",
						"A lookup table must retain at least one column.",
					);
				}
				const index = work.columns.findIndex(
					(column) => column.id === operation.columnId,
				);
				if (index < 0) notFound();
				await assertColumnDestructiveChangeAllowed(
					tx,
					scope.projectId,
					work.input.tableId,
					operation.columnId,
				);
				await sql`
					UPDATE lookup_rows
					SET "values" = "values" - ${operation.columnId}::text,
						updated_by = ${scope.actorId}, updated_at = ${new Date()}
					WHERE project_id = ${scope.projectId}
						AND table_id = ${work.input.tableId}
						AND "values" ? ${operation.columnId}::text
				`.execute(tx);
				await tx
					.deleteFrom("lookup_columns")
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", operation.columnId)
					.execute();
				work.columns.splice(index, 1);
				for (const row of work.rows) delete row.values[operation.columnId];
				work.definitionChanged = true;
				work.rowsChanged = true;
				break;
			}
			case "retype": {
				const column = work.columns.find(
					(candidate) => candidate.id === operation.columnId,
				);
				if (column === undefined) notFound();
				if (column.dataType === operation.dataType) break;
				await assertColumnDestructiveChangeAllowed(
					tx,
					scope.projectId,
					work.input.tableId,
					operation.columnId,
				);
				const candidate = { ...column, dataType: operation.dataType };
				const incompatibleRowIds: LookupRowId[] = [];
				let incompatibleRowCount = 0;
				// A complete replacement makes the stored rows intermediate state, not
				// the batch result. `applyRowOperations` validates every replacement
				// cell against the fully updated column set before this transaction can
				// commit, so rejecting on the rows about to be deleted would make a
				// valid atomic migration impossible.
				if (work.input.replaceRows === undefined) {
					for (const row of work.rows) {
						const result = validateLookupRowValues(
							work.columns.map((item) =>
								item.id === column.id ? candidate : item,
							),
							row.values,
						);
						if (!result.success) {
							incompatibleRowCount++;
							if (incompatibleRowIds.length < 100)
								incompatibleRowIds.push(row.id);
						}
					}
				}
				if (incompatibleRowCount > 0) {
					throw new LookupError(
						"incompatible_values",
						incompatibleRowCount > incompatibleRowIds.length
							? `${incompatibleRowCount} stored rows do not satisfy the requested type. The first 100 row ids are included.`
							: `${incompatibleRowCount} stored rows do not satisfy the requested type.`,
						{ incompatibleRowIds },
					);
				}
				await tx
					.updateTable("lookup_columns")
					.set({ data_type: operation.dataType })
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", operation.columnId)
					.execute();
				column.dataType = operation.dataType;
				work.definitionChanged = true;
				break;
			}
		}
	}
	return keyMap;
}

async function insertRows(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	tableId: LookupTableId,
	rows: readonly {
		id: LookupRowId;
		orderKey: string;
		values: LookupRowValues;
	}[],
): Promise<void> {
	if (rows.length === 0) return;
	await tx
		.insertInto("lookup_rows")
		.values(
			rows.map((row) => ({
				project_id: scope.projectId,
				table_id: tableId,
				id: row.id,
				order_key: row.orderKey,
				values: JSON.stringify(row.values),
				created_by: scope.actorId,
				updated_by: scope.actorId,
			})),
		)
		.execute();
}

async function applyRowOperations(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	work: TableWork,
	columnKeys: ReadonlyMap<string, LookupColumnId>,
): Promise<void> {
	const rowKeys = new Map<string, LookupRowId>();
	if (work.input.replaceRows !== undefined) {
		const drafts = work.input.replaceRows;
		const ids = (await mintIds(tx, drafts.length)).map((id) =>
			lookupRowIdSchema.parse(id),
		);
		const keys = balancedKeysBetween(null, null, drafts.length);
		const rows = drafts.map((draft, index) => ({
			id: ids[index],
			orderKey: keys[index],
			values: valuesFromCells(work.columns, columnKeys, draft.cells),
		}));
		if (rows.length > 0 || work.rows.length > 0) {
			await tx
				.deleteFrom("lookup_rows")
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", work.input.tableId)
				.execute();
			await insertRows(tx, scope, work.input.tableId, rows);
			work.rows = rows;
			work.rowsChanged = true;
			work.rowIds.push(
				...drafts.map((draft, index) => ({ key: draft.key, id: ids[index] })),
			);
		}
		return;
	}

	const addCount = (work.input.rowOperations ?? []).filter(
		(operation) => operation.kind === "add",
	).length;
	const minted = (await mintIds(tx, addCount)).map((id) =>
		lookupRowIdSchema.parse(id),
	);
	let mintedIndex = 0;
	for (const operation of work.input.rowOperations ?? []) {
		switch (operation.kind) {
			case "add": {
				if (work.rows.length >= LOOKUP_MAX_ROWS) {
					throw new LookupError(
						"row_limit",
						`A lookup table may have at most ${LOOKUP_MAX_ROWS} rows.`,
					);
				}
				const id = minted[mintedIndex++];
				const afterRowId =
					operation.afterRowKey === undefined
						? operation.afterRowId
						: rowKeys.get(operation.afterRowKey);
				if (operation.afterRowKey !== undefined && afterRowId === undefined) {
					invalid(
						`Row anchor key "${operation.afterRowKey}" has not been created earlier in this batch.`,
					);
				}
				const index = insertionIndex(work.rows, afterRowId, "Row");
				const orderKey = deriveKeyAtIndex(
					work.rows.map((row) => row.orderKey),
					index,
				);
				const row = {
					id,
					orderKey,
					values: valuesFromCells(work.columns, columnKeys, operation.cells),
				};
				await insertRows(tx, scope, work.input.tableId, [row]);
				work.rows.splice(index, 0, row);
				work.rowIds.push({ key: operation.key, id });
				rowKeys.set(operation.key, id);
				work.rowsChanged = true;
				break;
			}
			case "update": {
				const row = work.rows.find(
					(candidate) => candidate.id === operation.rowId,
				);
				if (row === undefined) notFound();
				const values = valuesFromCells(
					work.columns,
					columnKeys,
					operation.cells,
				);
				if (sameValues(row.values, values)) break;
				await tx
					.updateTable("lookup_rows")
					.set({
						values: JSON.stringify(values),
						updated_by: scope.actorId,
						updated_at: new Date(),
					})
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", row.id)
					.execute();
				row.values = values;
				work.rowsChanged = true;
				break;
			}
			case "move": {
				const targetId =
					operation.rowId ??
					(operation.rowKey === undefined
						? undefined
						: rowKeys.get(operation.rowKey));
				if (targetId === undefined) {
					invalid(
						`Row key "${operation.rowKey ?? ""}" has not been created earlier in this batch.`,
					);
				}
				const currentIndex = work.rows.findIndex((row) => row.id === targetId);
				if (currentIndex < 0) notFound();
				const [row] = work.rows.splice(currentIndex, 1);
				const afterRowId =
					operation.afterRowKey === undefined
						? operation.afterRowId
						: rowKeys.get(operation.afterRowKey);
				if (operation.afterRowKey !== undefined && afterRowId === undefined) {
					invalid(
						`Row anchor key "${operation.afterRowKey}" has not been created earlier in this batch.`,
					);
				}
				const index = insertionIndex(work.rows, afterRowId, "Row");
				if (index === currentIndex) {
					work.rows.splice(currentIndex, 0, row);
					break;
				}
				const orderKey = deriveKeyAtIndex(
					work.rows.map((candidate) => candidate.orderKey),
					index,
				);
				await tx
					.updateTable("lookup_rows")
					.set({
						order_key: orderKey,
						updated_by: scope.actorId,
						updated_at: new Date(),
					})
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", row.id)
					.execute();
				row.orderKey = orderKey;
				work.rows.splice(index, 0, row);
				work.rowsChanged = true;
				break;
			}
			case "remove": {
				const index = work.rows.findIndex((row) => row.id === operation.rowId);
				if (index < 0) notFound();
				await tx
					.deleteFrom("lookup_rows")
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", operation.rowId)
					.execute();
				work.rows.splice(index, 1);
				work.rowsChanged = true;
				break;
			}
		}
	}
}

async function tableAccounting(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
): Promise<{ rowCount: number; dataBytes: number }> {
	const result = await sql<{ row_count: number; data_bytes: number }>`
		SELECT count(*)::integer AS row_count,
			COALESCE(sum(value_bytes), 0)::integer AS data_bytes
		FROM lookup_rows
		WHERE project_id = ${projectId} AND table_id = ${tableId}
	`.execute(tx);
	const accounting = result.rows[0];
	if (accounting === undefined)
		throw new Error("Lookup row accounting returned no row.");
	if (accounting.data_bytes > LOOKUP_MAX_TABLE_BYTES) {
		throw new LookupError(
			"storage_limit",
			`This change would put ${accounting.data_bytes} bytes of data in the table, which is over its ${LOOKUP_MAX_TABLE_BYTES}-byte limit.`,
		);
	}
	return { rowCount: accounting.row_count, dataBytes: accounting.data_bytes };
}

async function createTable(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	revision: LookupRevision,
	input: NonNullable<LookupAuthoringBatchInput["createTables"]>[number],
) {
	const [rawTableId] = await mintIds(tx, 1);
	const tableId = lookupTableIdSchema.parse(rawTableId);
	const columnIds = (await mintIds(tx, input.columns.length)).map((id) =>
		lookupColumnIdSchema.parse(id),
	);
	const rowIds = (await mintIds(tx, input.rows.length)).map((id) =>
		lookupRowIdSchema.parse(id),
	);
	const columnKeys = new Map(
		input.columns.map((column, index) => [column.key, columnIds[index]]),
	);
	const columnOrderKeys = balancedKeysBetween(null, null, input.columns.length);
	const columns: MutableColumn[] = input.columns.map((column, index) => ({
		id: columnIds[index],
		wireName: column.wireName,
		label: column.label,
		dataType: column.dataType,
		orderKey: columnOrderKeys[index],
	}));
	const rowKeys = balancedKeysBetween(null, null, input.rows.length);
	const rows = input.rows.map((row, index) => ({
		id: rowIds[index],
		orderKey: rowKeys[index],
		values: valuesFromCells(columns, columnKeys, row.cells),
	}));
	await tx
		.insertInto("lookup_tables")
		.values({
			project_id: scope.projectId,
			id: tableId,
			name: input.name,
			tag: input.tag,
			definition_revision: revision,
			rows_revision: revision,
			column_count: columns.length,
			row_count: rows.length,
			created_by: scope.actorId,
			updated_by: scope.actorId,
		})
		.execute();
	await tx
		.insertInto("lookup_columns")
		.values(
			columns.map((column) => ({
				project_id: scope.projectId,
				table_id: tableId,
				id: column.id,
				wire_name: column.wireName,
				label: column.label,
				data_type: column.dataType,
				order_key: column.orderKey,
			})),
		)
		.execute();
	await insertRows(tx, scope, tableId, rows);
	const accounting = await tableAccounting(tx, scope.projectId, tableId);
	const table = await updateLockedLookupTable(tx, scope.projectId, tableId, {
		data_bytes: accounting.dataBytes,
	});
	return {
		key: input.key,
		tableId,
		deleted: false as const,
		columnIds: input.columns.map((column, index) => ({
			key: column.key,
			id: columnIds[index],
		})),
		rowIds: input.rows.map((row, index) => ({
			key: row.key,
			id: rowIds[index],
		})),
		revisions: lookupTableRevisions(table),
	};
}

/**
 * Atomic Project-data authoring core shared by accepted-design materialization
 * and the public SA/MCP tools. The caller owns the transaction and supplies a
 * freshly authorized scope. This function locks Project state once, locks
 * existing tables in UUID order, advances the Project revision at most once,
 * and emits one transactional invalidation notification.
 */
export async function applyLookupAuthoringBatchInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	inputValue: LookupAuthoringBatchInput,
): Promise<LookupAuthoringBatchReceipt> {
	assertScope(scope);
	const input = parseBatch(inputValue);
	assertCapability(scope, input);
	const projectState = await lockLookupProjectState(tx, scope.projectId);
	const nextRevision = parseLookupRevision(
		(BigInt(projectState.revision) + BigInt(1)).toString(),
	);
	const desiredTags: { tag: string; tableId?: LookupTableId }[] = [
		...(input.createTables ?? []).map((table) => ({ tag: table.tag })),
		...(input.updateTables ?? []).flatMap((table) =>
			table.tag === undefined
				? []
				: [{ tag: table.tag, tableId: table.tableId }],
		),
	];
	const seenTags = new Map<string, LookupTableId | undefined>();
	for (const desired of desiredTags) {
		if (seenTags.has(desired.tag)) {
			throw new LookupError(
				"tag_taken",
				`Table tag "${desired.tag}" appears more than once in this authoring batch.`,
			);
		}
		seenTags.set(desired.tag, desired.tableId);
		const existing = await tx
			.selectFrom("lookup_tables")
			.select("id")
			.where("project_id", "=", scope.projectId)
			.where("tag", "=", desired.tag)
			.executeTakeFirst();
		if (
			existing !== undefined &&
			(desired.tableId === undefined || existing.id !== desired.tableId)
		) {
			throw new LookupError(
				"tag_taken",
				`Table tag "${desired.tag}" is already used in this Project.`,
			);
		}
	}

	const sortedUpdates = [...(input.updateTables ?? [])].sort((left, right) =>
		compareAscii(left.tableId, right.tableId),
	);
	const works: TableWork[] = [];
	for (const update of sortedUpdates)
		works.push(await loadWork(tx, scope, update));

	let changed = (input.createTables?.length ?? 0) > 0;
	for (const work of works) {
		if (work.input.delete === true) {
			await assertTableRemovable(tx, scope.projectId, work.input.tableId);
			await tx
				.deleteFrom("lookup_tables")
				.where("project_id", "=", scope.projectId)
				.where("id", "=", work.input.tableId)
				.execute();
			work.deleted = true;
			changed = true;
			continue;
		}
		const name = work.input.name ?? work.table.name;
		const tag = work.input.tag ?? work.table.tag;
		if (name !== work.table.name || tag !== work.table.tag) {
			await tx
				.updateTable("lookup_tables")
				.set({ name, tag })
				.where("project_id", "=", scope.projectId)
				.where("id", "=", work.input.tableId)
				.execute();
			work.definitionChanged = true;
		}
		const columnKeys = await applyColumnOperations(tx, scope, work);
		await applyRowOperations(tx, scope, work, columnKeys);
		changed ||= work.definitionChanged || work.rowsChanged;
	}

	const createdReceipts = [];
	for (const create of input.createTables ?? []) {
		createdReceipts.push(await createTable(tx, scope, nextRevision, create));
	}

	const updatedReceipts = [];
	for (const work of works) {
		if (work.deleted) {
			updatedReceipts.push({
				tableId: work.input.tableId,
				deleted: true as const,
				columnIds: work.columnIds,
				rowIds: work.rowIds,
			});
			continue;
		}
		let table = work.table;
		if (work.definitionChanged || work.rowsChanged) {
			const accounting = await tableAccounting(
				tx,
				scope.projectId,
				work.input.tableId,
			);
			table = await updateLockedLookupTable(
				tx,
				scope.projectId,
				work.input.tableId,
				{
					column_count: work.columns.length,
					row_count: accounting.rowCount,
					data_bytes: accounting.dataBytes,
					...(work.definitionChanged
						? { definition_revision: nextRevision }
						: {}),
					...(work.rowsChanged ? { rows_revision: nextRevision } : {}),
					updated_by: scope.actorId,
					updated_at: new Date(),
				},
			);
		}
		updatedReceipts.push({
			tableId: work.input.tableId,
			deleted: false as const,
			columnIds: work.columnIds,
			rowIds: work.rowIds,
			revisions: lookupTableRevisions(table),
		});
	}

	if (!changed) {
		return {
			projectRevision: projectState.revision,
			tables: [...createdReceipts, ...updatedReceipts],
		};
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
	return {
		projectRevision,
		tables: [...createdReceipts, ...updatedReceipts],
	};
}
