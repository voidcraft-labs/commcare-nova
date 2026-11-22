import { ownRecordValue } from "@/lib/domain/records";
import "server-only";

import { type Insertable, sql, type Transaction } from "kysely";
import { z } from "zod";
import type { AppDatabase, LookupTablesTable } from "@/lib/db/pg";
import { deepEqual } from "@/lib/doc/deepEqual";
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
import { rowAssigneesSchema } from "./assignmentVocabulary";
import { validateLookupRowValues } from "./coercion";
import {
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "./constants";
import { LookupError } from "./errors";
import { dropDefinitionExternalRefs } from "./largeValues/projection";
import { holdLookupReaderReview } from "./memberGovernance";
import {
	columnWithMembers,
	insertLookupMembers,
	readTableMembers,
	updateLookupMembers,
} from "./members";
import { lookupEditOnce } from "./operationReceipt";
import { balancedKeysBetween, deriveKeyAtIndex } from "./orderKeys";
import { checkLookupRetype } from "./retypeCells";
import { replaceRowAssignments } from "./rowAssignments";
import { checkedRowContent, resolveNamedRowContent } from "./rowContent";
import { rowIndex, rowOrderForPlacement } from "./rowOrdering";
import {
	patchLookupRowInTransaction,
	replaceLookupRowInTransaction,
} from "./rowPatch";
import {
	lookupColumnDraftSchema,
	lookupColumnLabelSchema,
	lookupDataTypeSchema,
	lookupMemberDraftSchema,
	lookupReaderReviewSchema,
	lookupRevisionSchema,
	lookupRowChangesSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
	parseLookupRevision,
} from "./schema";
import { changeLookupRowShape } from "./schemaRowShape";
import type {
	LookupAuthoringBatchInput,
	LookupAuthoringBatchReceipt,
	LookupAuthoringCell,
	LookupAuthoringColumnOperation,
	LookupAuthoringExistingTable,
	LookupAuthoringRowOperation,
	LookupColumn,
	LookupMember,
	LookupMemberEdit,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupRowContent,
	LookupRowValues,
	LookupScope,
} from "./types";
import {
	advanceLookupProjectRevision,
	LookupAuthorityError,
	type LookupWriteAuthority,
	lockLookupProjectState,
	lockLookupTableForUpdate,
	lookupTableRevisions,
	notifyCommittedLookupMutation,
	requireLookupCapability,
	type StoredLookupTable,
	updateLockedLookupTable,
} from "./writerTransaction";

interface MutableColumn extends LookupColumn {
	orderKey: string;
}

interface MutableRow {
	content: LookupRowContent;
	remoteId?: string;
	sortKey?: number;
	id: LookupRowId;
	orderKey: string;
	values: LookupRowValues;
}

interface TableWork {
	input: LookupAuthoringExistingTable;
	table: StoredLookupTable;
	columns: MutableColumn[];
	attributes: LookupMember[];
	rowCount: number;
	dataBytes: number;
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

export function lookupBatchNeedsDelete(
	input: LookupAuthoringBatchInput,
): boolean {
	return (input.updateTables ?? []).some(
		(table) =>
			table.delete === true ||
			table.workerAccess === "all" ||
			table.tag !== undefined ||
			(table.columnOperations ?? []).some(
				(operation) =>
					operation.kind === "remove" ||
					operation.kind === "retype" ||
					(operation.kind === "update" && operation.wireName !== undefined),
			),
	);
}

/** The batch's capability, held by the authority its transaction read. */
function assertCapability(
	tx: Transaction<AppDatabase>,
	authority: LookupWriteAuthority,
	input: LookupAuthoringBatchInput,
): void {
	try {
		requireLookupCapability(
			tx,
			authority,
			lookupBatchNeedsDelete(input) ? "delete" : "edit",
		);
	} catch (error) {
		if (error instanceof LookupAuthorityError) notFound();
		throw error;
	}
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
	if (input.operationId !== undefined)
		parseInput(z.uuid(), input.operationId, "Operation ID");
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
			(!create.columns.length && !create.attributes?.length) ||
			create.columns.length > LOOKUP_MAX_COLUMNS
		) {
			invalid(
				`A lookup table needs between 1 and ${LOOKUP_MAX_COLUMNS} columns.`,
			);
		}
		if (create.rows.length > LOOKUP_MAX_ROWS) {
			invalid(`A lookup table may have at most ${LOOKUP_MAX_ROWS} rows.`);
		}
		if (create.attributes !== undefined) {
			parseInput(
				lookupMemberDraftSchema.array().max(LOOKUP_MAX_COLUMNS),
				create.attributes,
				"Row details",
			);
			if (
				new Set(create.attributes.map((member) => member.wireName)).size !==
				create.attributes.length
			)
				invalid("Each row detail needs its own export name.");
		}
		assertUniqueKeys(create.columns, "column key");
		assertUniqueKeys(create.rows, "row key");
		const wireNames = new Set<string>();
		for (const column of create.columns) {
			const { key: _key, ...draft } = column;
			parseInput(lookupColumnDraftSchema, draft, "Column");
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
		if (update.workerAccess !== undefined)
			parseInput(
				z.enum(["all", "assigned"]),
				update.workerAccess,
				"Worker access",
			);
		if (update.name !== undefined) {
			parseInput(lookupTableNameSchema, update.name, "Table name");
		}
		if (update.attributes !== undefined) validateMemberEdits(update.attributes);
		if (update.reviewed !== undefined)
			parseInput(lookupReaderReviewSchema, update.reviewed, "Reader review");
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
				update.workerAccess !== undefined ||
				update.name !== undefined ||
				update.tag !== undefined ||
				update.attributes !== undefined ||
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

function validateMemberEdits(members: LookupMemberEdit[]) {
	parseInput(
		lookupMemberDraftSchema
			.extend({ id: lookupMemberIdSchema.optional() })
			.array()
			.max(LOOKUP_MAX_COLUMNS),
		members,
		"Details",
	);
	if (new Set(members.map((member) => member.wireName)).size !== members.length)
		invalid("Each detail needs its own export name.");
	const ids = members.flatMap((member) => (member.id ? [member.id] : []));
	if (new Set(ids).size !== ids.length)
		invalid("A detail can only appear once in its definition.");
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
			if (operation.properties !== undefined)
				validateMemberEdits(operation.properties);
			if (
				operation.label === undefined &&
				operation.wireName === undefined &&
				operation.repeated === undefined &&
				operation.indexed === undefined &&
				operation.properties === undefined
			) {
				invalid("Choose a column setting to change.");
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
		case "assign":
			parseInput(lookupRowIdSchema, operation.rowId, "Row id");
			parseInput(
				rowAssigneesSchema,
				operation.assignments,
				"Workers who receive this row",
			);
			return;
		case "add":
			if (operation.assignments !== undefined)
				parseInput(
					rowAssigneesSchema,
					operation.assignments,
					"Workers who receive this row",
				);
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
		case "patch":
			parseInput(lookupRowChangesSchema, operation.changes, "Row changes");
			parseInput(lookupRowIdSchema, operation.rowId, "Row id");
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
	scope: LookupWriteAuthority,
	input: LookupAuthoringExistingTable,
): Promise<TableWork> {
	const table = await lockLookupTableForUpdate(
		tx,
		scope,
		input.tableId,
		input.expectedTableRevision,
		/* A delete removes only Nova's copy, which is allowed in every state;
		 * every other change of the table is an author's edit. */
		input.delete === true ? "remove-table" : "author",
	);
	const columns = await tx
		.selectFrom("lookup_columns")
		.selectAll()
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", input.tableId)
		.orderBy("order_key", "asc")
		.orderBy("id", "asc")
		.execute();
	const members = await readTableMembers(tx, scope.projectId, input.tableId);
	return {
		input,
		table,
		attributes: members.get(null) ?? [],
		columns: columns.map((column) => ({
			...columnWithMembers(column, members.get(column.id)),
			orderKey: column.order_key,
		})),
		rowCount: table.row_count,
		dataBytes: Number(table.data_bytes),
		columnIds: [],
		rowIds: [],
		definitionChanged: false,
		rowsChanged: false,
		deleted: false,
	};
}

async function editMembers(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	work: TableWork,
	columnId: LookupColumnId | null,
	before: readonly LookupMember[],
	edits: readonly LookupMemberEdit[],
): Promise<LookupMember[]> {
	const byId = new Map(before.map((member) => [member.id, member]));
	const minted = (
		await mintIds(tx, edits.filter((member) => member.id === undefined).length)
	).map((id) => lookupMemberIdSchema.parse(id));
	let mint = 0;
	const after = edits.map((member) => {
		if (member.id && !byId.has(member.id)) notFound();
		return {
			id: member.id ?? minted[mint++],
			wireName: member.wireName,
			label: member.label,
		};
	});
	const afterById = new Map(after.map((member) => [member.id, member]));
	if (
		before.some(
			(member) => afterById.get(member.id)?.wireName !== member.wireName,
		)
	) {
		try {
			requireLookupCapability(tx, scope, "delete");
		} catch (error) {
			if (error instanceof LookupAuthorityError) notFound();
			throw error;
		}
	}
	for (const member of before) {
		if (!afterById.has(member.id))
			work.dataBytes -= await dropDefinitionExternalRefs(
				tx,
				scope.projectId,
				work.input.tableId,
				columnId === null
					? { attributeId: member.id }
					: { columnId, propertyId: member.id },
			);
	}
	if (
		await updateLookupMembers(
			tx,
			scope.projectId,
			work.input.tableId,
			new Map([[columnId, before]]),
			new Map([[columnId, after]]),
			[columnId],
		)
	)
		work.definitionChanged = true;
	return after;
}

async function syncAuthoredRows(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	work: TableWork,
	before?: LookupColumn,
	after?: LookupColumn,
) {
	if (work.input.replaceRows !== undefined) return;
	const result = await changeLookupRowShape(
		tx,
		scope,
		work.input.tableId,
		work.attributes,
		before,
		after,
	);
	work.dataBytes += result.delta;
	work.rowsChanged ||= result.changed;
}

async function applyColumnOperations(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
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
						repeated: operation.column.repeated ?? false,
						index_status: operation.column.indexed ? "indexed" : "off",
						order_key: orderKey,
					})
					.execute();
				const props = await insertLookupMembers(
					tx,
					scope.projectId,
					work.input.tableId,
					id,
					operation.column.properties ?? [],
				);
				work.columns.splice(index, 0, {
					id,
					orderKey,
					wireName: operation.column.wireName,
					label: operation.column.label,
					dataType: operation.column.dataType,
					...(operation.column.repeated ? { repeated: true } : {}),
					...(props.length ? { properties: props } : {}),
					...(operation.column.indexed ? { index: "indexed" } : {}),
				});
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
				const repeated = operation.repeated ?? column.repeated ?? false;
				const properties =
					operation.properties === undefined
						? (column.properties ?? [])
						: await editMembers(
								tx,
								scope,
								work,
								column.id,
								column.properties ?? [],
								operation.properties,
							);
				const index =
					operation.indexed === undefined
						? column.index
						: operation.indexed
							? "indexed"
							: undefined;
				if (repeated && column.dataType !== "text")
					invalid("Repeated values need a text column.");
				if (!repeated && properties.length)
					invalid("A column with value details needs repeated values.");
				if (repeated !== (column.repeated ?? false)) {
					try {
						requireLookupCapability(tx, scope, "delete");
					} catch (error) {
						if (error instanceof LookupAuthorityError) notFound();
						throw error;
					}
					await assertColumnDestructiveChangeAllowed(
						tx,
						scope.projectId,
						work.input.tableId,
						column.id,
					);
				}
				if (
					nextLabel === column.label &&
					nextWireName === column.wireName &&
					repeated === (column.repeated ?? false) &&
					index === column.index &&
					deepEqual(properties, column.properties ?? [])
				)
					break;
				const before = { ...column };
				if (repeated) column.repeated = true;
				else delete column.repeated;
				if (properties.length) column.properties = properties;
				else delete column.properties;
				if (index) column.index = index;
				else delete column.index;
				await tx
					.updateTable("lookup_columns")
					.set({
						label: nextLabel,
						wire_name: nextWireName,
						repeated,
						index_status: index ?? "off",
					})
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", column.id)
					.execute();
				column.label = nextLabel;
				column.wireName = nextWireName;
				if (
					before.repeated !== column.repeated ||
					!deepEqual(before.properties, column.properties)
				)
					await syncAuthoredRows(tx, scope, work, before, column);
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
				if (work.columns.length <= 1 && work.attributes.length === 0) {
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
				work.dataBytes -= await dropDefinitionExternalRefs(
					tx,
					scope.projectId,
					work.input.tableId,
					{ columnId: operation.columnId },
				);
				await syncAuthoredRows(tx, scope, work, work.columns[index]);
				await tx
					.deleteFrom("lookup_columns")
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", operation.columnId)
					.execute();
				work.columns.splice(index, 1);
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
				if (column.repeated)
					invalid(
						"A repeated column needs text values. You can change how it holds values first.",
					);
				await assertColumnDestructiveChangeAllowed(
					tx,
					scope.projectId,
					work.input.tableId,
					operation.columnId,
				);
				// A complete atomic replacement validates its new values against the
				// final definition. Otherwise check the exact stored cells in pages.
				const { incompatibleRowCount, incompatibleRowIds } =
					work.input.replaceRows === undefined
						? await checkLookupRetype(
								tx,
								scope.projectId,
								work.input.tableId,
								column.id,
								operation.dataType,
							)
						: { incompatibleRowCount: 0, incompatibleRowIds: [] };
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
	rows: readonly MutableRow[],
): Promise<number> {
	if (rows.length === 0) return 0;
	let bytes = 0;
	for (let start = 0; start < rows.length; start += 250) {
		const written = await tx
			.insertInto("lookup_rows")
			.values(
				rows.slice(start, start + 250).map((row) => ({
					project_id: scope.projectId,
					table_id: tableId,
					id: row.id,
					order_key: row.orderKey,
					values: JSON.stringify(row.values),
					content: JSON.stringify(row.content),
					hq_row_id: row.remoteId,
					hq_sort_key: row.sortKey,
					created_by: scope.actorId,
					updated_by: scope.actorId,
				})),
			)
			.returning("value_bytes")
			.execute();
		if (written.some((row) => row.value_bytes > LOOKUP_MAX_ROW_BYTES))
			throw new LookupError(
				"storage_limit",
				"This row is too large for one inline edit. You can edit its values in parts.",
			);
		bytes += written.reduce((sum, row) => sum + row.value_bytes, 0);
	}
	return bytes;
}

async function applyRowOperations(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	work: TableWork,
	columnKeys: ReadonlyMap<string, LookupColumnId>,
): Promise<void> {
	const rowKeys = new Map<string, LookupRowId>();
	if (work.input.replaceRows !== undefined) {
		if (
			work.table.worker_access === "assigned" ||
			work.input.workerAccess === "assigned"
		)
			invalid(
				"Replacing this table would clear its row assignments. You can update individual rows and keep their workers, groups and places.",
			);
		const drafts = work.input.replaceRows;
		const ids = (await mintIds(tx, drafts.length)).map((id) =>
			lookupRowIdSchema.parse(id),
		);
		const keys = balancedKeysBetween(null, null, drafts.length);
		const rows = drafts.map((draft, index) => {
			const values = valuesFromCells(work.columns, columnKeys, draft.cells);
			return {
				id: ids[index],
				orderKey: keys[index],
				values,
				content: resolveNamedRowContent(
					work.columns,
					work.attributes,
					values,
					draft.content ?? {},
				),
			};
		});
		if (rows.length > 0 || work.rowCount > 0) {
			await tx
				.deleteFrom("lookup_rows")
				.where("project_id", "=", scope.projectId)
				.where("table_id", "=", work.input.tableId)
				.execute();
			work.dataBytes = await insertRows(tx, scope, work.input.tableId, rows);
			work.rowCount = rows.length;
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
			case "assign": {
				if (
					(work.input.workerAccess ?? work.table.worker_access) !== "assigned"
				)
					invalid(
						"This table goes to everyone. You can choose assigned workers for the table first.",
					);
				const changed = await replaceRowAssignments(
					tx,
					scope.projectId,
					work.input.tableId,
					operation.rowId,
					operation.assignments,
				);
				work.rowsChanged ||= changed;
				break;
			}
			case "add": {
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
				const orderKey = await rowOrderForPlacement(
					tx,
					scope.projectId,
					work.input.tableId,
					{ afterRowId },
				);
				const values = valuesFromCells(
					work.columns,
					columnKeys,
					operation.cells,
				);
				const row = {
					id,
					orderKey,
					values,
					content: resolveNamedRowContent(
						work.columns,
						work.attributes,
						values,
						operation.content ?? {},
					),
				};
				work.dataBytes += await insertRows(tx, scope, work.input.tableId, [
					row,
				]);
				if (operation.assignments !== undefined) {
					if (
						(work.input.workerAccess ?? work.table.worker_access) !== "assigned"
					)
						invalid(
							"This table goes to everyone. You can choose assigned workers for the table first.",
						);
					await replaceRowAssignments(
						tx,
						scope.projectId,
						work.input.tableId,
						id,
						operation.assignments,
					);
				}
				work.rowCount++;
				work.rowIds.push({ key: operation.key, id });
				rowKeys.set(operation.key, id);
				work.rowsChanged = true;
				break;
			}
			case "patch": {
				const result = await patchLookupRowInTransaction(
					tx,
					scope,
					work.input.tableId,
					operation.rowId,
					work.columns,
					work.attributes,
					operation.changes,
				);
				work.dataBytes += result.delta;
				work.rowsChanged ||= result.changed;
				break;
			}
			case "update": {
				const values = valuesFromCells(
					work.columns,
					columnKeys,
					operation.cells,
				);
				const content =
					operation.content === undefined
						? checkedRowContent(work.columns, [], values, {})
						: resolveNamedRowContent(
								work.columns,
								work.attributes,
								values,
								operation.content,
							);
				const updated = await replaceLookupRowInTransaction(
					tx,
					scope,
					work.input.tableId,
					operation.rowId,
					values,
					operation.content === undefined ? undefined : content,
				);
				work.dataBytes += updated.delta;
				work.rowsChanged ||= updated.changed;
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
				const currentIndex = await rowIndex(
					tx,
					scope.projectId,
					work.input.tableId,
					targetId,
				);
				const afterRowId =
					operation.afterRowKey === undefined
						? operation.afterRowId
						: rowKeys.get(operation.afterRowKey);
				if (operation.afterRowKey !== undefined && afterRowId === undefined) {
					invalid(
						`Row anchor key "${operation.afterRowKey}" has not been created earlier in this batch.`,
					);
				}
				const anchorIndex =
					afterRowId == null
						? -1
						: await rowIndex(
								tx,
								scope.projectId,
								work.input.tableId,
								afterRowId,
							);
				const index =
					afterRowId === undefined
						? work.rowCount - 1
						: anchorIndex + 1 - (currentIndex < anchorIndex ? 1 : 0);
				if (currentIndex === index) break;
				const orderKey = await rowOrderForPlacement(
					tx,
					scope.projectId,
					work.input.tableId,
					{ afterRowId },
					targetId,
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
					.where("id", "=", targetId)
					.execute();
				work.rowsChanged = true;
				break;
			}
			case "remove": {
				const removed = await tx
					.deleteFrom("lookup_rows")
					.where("project_id", "=", scope.projectId)
					.where("table_id", "=", work.input.tableId)
					.where("id", "=", operation.rowId)
					.returning(["value_bytes", "external_bytes"])
					.executeTakeFirst();
				if (!removed) notFound();
				work.rowCount--;
				work.dataBytes -= removed.value_bytes + Number(removed.external_bytes);
				work.rowsChanged = true;
				break;
			}
		}
	}
}

/** The ids a created table and its columns take, in the input's column order. */
export interface LookupCreatedTableIds {
	readonly tableId: LookupTableId;
	readonly columnIds: readonly LookupColumnId[];
	readonly memberIds?: ManagedLookupMemberIds;
	readonly fieldIndexes?: Readonly<
		Record<string, "off" | "indexed" | "unobserved">
	>;
	readonly sourceRows?: readonly {
		readonly remoteId: string;
		readonly sortKey?: number;
	}[];
}

export interface ManagedLookupMemberIds {
	readonly attributes: Readonly<Record<string, LookupMemberId>>;
	readonly properties: Readonly<
		Record<string, Readonly<Record<string, LookupMemberId>>>
	>;
}

/** The CommCare HQ origin a created table carries, written in its insert. */
export type LookupTableOriginColumns = Pick<
	Insertable<LookupTablesTable>,
	| "hq_server"
	| "hq_domain"
	| "hq_remote_id"
	| "hq_canonical"
	| "hq_brought_in_at"
	| "hq_brought_in_by"
	| "hq_refreshed_at"
	| "hq_refreshed_by"
>;

/**
 * Create one complete table under the ids it is given, with its rows under
 * server-minted ids. The caller holds Project state and advances its
 * revision; `revision` is the one that advance will reach. The public batch
 * mints the ids; the managed-copy writers in `managed.ts` derive them and
 * pass the table's CommCare HQ origin, which lands in the same insert.
 */
export async function createTable(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	revision: LookupRevision,
	input: NonNullable<LookupAuthoringBatchInput["createTables"]>[number],
	ids: LookupCreatedTableIds,
	origin?: LookupTableOriginColumns,
) {
	if (ids.columnIds.length !== input.columns.length) {
		throw new Error(
			"A created lookup table needs exactly one id for each of its columns.",
		);
	}
	const { tableId, columnIds } = ids;
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
		...(column.repeated ? { repeated: true } : {}),
		...(column.indexed ? { index: "indexed" } : {}),
	}));
	const scalarRows = input.rows.map((row) =>
		valuesFromCells(columns, columnKeys, row.cells),
	);
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
			row_count: input.rows.length,
			created_by: scope.actorId,
			updated_by: scope.actorId,
			...origin,
		})
		.execute();
	for (let start = 0; start < columns.length; start += 250)
		await tx
			.insertInto("lookup_columns")
			.values(
				columns.slice(start, start + 250).map((column) => ({
					project_id: scope.projectId,
					table_id: tableId,
					id: column.id,
					wire_name: column.wireName,
					label: column.label,
					data_type: column.dataType,
					repeated: column.repeated ?? false,
					index_status:
						ownRecordValue(ids.fieldIndexes, column.wireName) ??
						column.index ??
						(origin ? "unobserved" : "off"),
					order_key: column.orderKey,
				})),
			)
			.execute();
	const attributes = await insertLookupMembers(
		tx,
		scope.projectId,
		tableId,
		null,
		input.attributes ?? [],
		ids.memberIds?.attributes,
	);
	for (const [index, draft] of input.columns.entries()) {
		const column = columns[index];
		const properties = await insertLookupMembers(
			tx,
			scope.projectId,
			tableId,
			column.id,
			draft.properties ?? [],
			ownRecordValue(ids.memberIds?.properties, draft.wireName),
		);
		if (properties.length) column.properties = properties;
	}
	const rowKeys = balancedKeysBetween(null, null, input.rows.length);
	const rows = input.rows.map((row, index) => {
		const values = scalarRows[index];
		return {
			id: rowIds[index],
			orderKey: rowKeys[index],
			values,
			content: resolveNamedRowContent(
				columns,
				attributes,
				values,
				row.content ?? {},
			),
			...ids.sourceRows?.[index],
		};
	});
	const dataBytes = await insertRows(tx, scope, tableId, rows);
	if (dataBytes > LOOKUP_MAX_TABLE_BYTES)
		invalid(
			"This inline table is too large for one request. You can import it in parts.",
		);
	const table = await updateLockedLookupTable(tx, scope.projectId, tableId, {
		data_bytes: dataBytes,
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
 * and the public SA/MCP tools. The caller owns the transaction and supplies the
 * authority read on it (`authorizeLookupWriteInTransaction`); a batch that
 * renames a tag or a wire name, retypes or removes a column, or removes a
 * table needs that authority's `delete`. This function locks Project state
 * once, locks existing tables in UUID order, advances the Project revision at
 * most once, and emits one transactional invalidation notification.
 */
export async function applyLookupAuthoringBatchInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	inputValue: LookupAuthoringBatchInput,
): Promise<LookupAuthoringBatchReceipt> {
	if (
		Buffer.byteLength(JSON.stringify(inputValue), "utf8") >
		LOOKUP_MAX_TABLE_BYTES
	)
		throw new LookupError(
			"storage_limit",
			"This edit is too large for one request. You can import it in parts.",
		);
	const input = parseBatch(inputValue);
	assertCapability(tx, scope, input);
	const projectState = await lockLookupProjectState(tx, scope);
	return lookupEditOnce(
		tx,
		scope,
		input.operationId,
		"lookupBatch",
		input,
		() => applyBatch(tx, scope, input, projectState),
	);
}

async function applyBatch(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	input: LookupAuthoringBatchInput,
	projectState: { revision: LookupRevision },
): Promise<LookupAuthoringBatchReceipt> {
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
		if (
			work.input.workerAccess !== undefined &&
			work.input.workerAccess !== work.table.worker_access
		) {
			await holdLookupReaderReview(
				tx,
				scope.projectId,
				work.input.tableId,
				projectState.revision,
				work.input.reviewed,
			);
			await tx
				.updateTable("lookup_tables")
				.set({ worker_access: work.input.workerAccess })
				.where("project_id", "=", scope.projectId)
				.where("id", "=", work.input.tableId)
				.execute();
			work.definitionChanged = true;
		}
		const richEdit =
			work.input.attributes !== undefined ||
			work.input.columnOperations?.some(
				(operation) =>
					(operation.kind === "add" &&
						(operation.column.repeated ||
							operation.column.indexed !== undefined)) ||
					(operation.kind === "update" &&
						(operation.repeated !== undefined ||
							operation.indexed !== undefined ||
							operation.properties !== undefined)) ||
					(operation.kind === "remove" &&
						work.columns.find((column) => column.id === operation.columnId)
							?.repeated),
			);
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
		if (work.input.attributes !== undefined) {
			const oldIds = new Set(work.attributes.map(({ id }) => id));
			work.attributes = await editMembers(
				tx,
				scope,
				work,
				null,
				work.attributes,
				work.input.attributes,
			);
			if (
				oldIds.size !== work.attributes.length ||
				work.attributes.some(({ id }) => !oldIds.has(id))
			)
				await syncAuthoredRows(tx, scope, work);
		}
		const columnKeys = await applyColumnOperations(tx, scope, work);
		if (!work.columns.length && !work.attributes.length)
			invalid("A table needs at least one column or row detail.");
		if (work.definitionChanged && richEdit)
			await holdLookupReaderReview(
				tx,
				scope.projectId,
				work.input.tableId,
				parseLookupRevision(projectState.revision),
				work.input.reviewed,
			);
		await applyRowOperations(tx, scope, work, columnKeys);
		changed ||= work.definitionChanged || work.rowsChanged;
	}

	const createdReceipts = [];
	for (const create of input.createTables ?? []) {
		const [tableId] = await mintIds(tx, 1);
		const columnIds = await mintIds(tx, create.columns.length);
		createdReceipts.push(
			await createTable(tx, scope, nextRevision, create, {
				tableId: lookupTableIdSchema.parse(tableId),
				columnIds: columnIds.map((id) => lookupColumnIdSchema.parse(id)),
			}),
		);
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
			const accounting = { rowCount: work.rowCount, dataBytes: work.dataBytes };
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
