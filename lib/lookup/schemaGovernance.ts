import "server-only";

import { sql, type Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	CURRENT_LOOKUP_REFERENCE_WRITER_VERSION,
	declareLookupReferenceWriter,
} from "@/lib/db/lookupReferenceWriter";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import {
	type LookupColumnId,
	type LookupRowId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { coerceLookupCell } from "./coercion";
import { LookupError } from "./errors";
import { lookupDataTypeSchema, parseLookupRevision } from "./schema";
import type {
	LookupDataType,
	LookupRevision,
	LookupScope,
	LookupTableRevisions,
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

export type LookupSchemaGovernanceOperation =
	| {
			kind: "delete-table";
			tableId: LookupTableId;
			expectedTableRevision: LookupRevision;
	  }
	| {
			kind: "remove-column";
			tableId: LookupTableId;
			columnId: LookupColumnId;
			expectedTableRevision: LookupRevision;
	  }
	| {
			kind: "retype-column";
			tableId: LookupTableId;
			columnId: LookupColumnId;
			dataType: LookupDataType;
			expectedTableRevision: LookupRevision;
	  };

export interface DeletedLookupTableResult {
	kind: "delete-table";
	tableId: LookupTableId;
	projectRevision: LookupRevision;
	deletedColumnCount: number;
	deletedRowCount: number;
	freedBytes: number;
}

export interface RemovedLookupColumnResult extends LookupTableRevisions {
	kind: "remove-column";
	tableId: LookupTableId;
	columnId: LookupColumnId;
	projectRevision: LookupRevision;
	affectedRows: number;
	affectedCells: number;
	freedBytes: number;
}

export interface RetypedLookupColumnResult extends LookupTableRevisions {
	kind: "retype-column";
	tableId: LookupTableId;
	columnId: LookupColumnId;
	dataType: LookupDataType;
	projectRevision: LookupRevision;
	checkedCells: number;
	changed: boolean;
}

export type LookupSchemaGovernanceResult =
	| DeletedLookupTableResult
	| RemovedLookupColumnResult
	| RetypedLookupColumnResult;

export type LookupSchemaGovernanceErrorCode =
	| "schema_actions_disabled"
	| "not_found"
	| "conflict"
	| "referenced"
	| "last_column"
	| "incompatible_values";

export class LookupSchemaGovernanceError extends Error {
	readonly code: LookupSchemaGovernanceErrorCode;
	readonly blockingAppIds?: readonly string[];
	readonly incompatibleRowIds?: readonly LookupRowId[];
	readonly currentRevisions?: LookupTableRevisions;

	constructor(
		code: LookupSchemaGovernanceErrorCode,
		message: string,
		options: {
			cause?: unknown;
			blockingAppIds?: readonly string[];
			incompatibleRowIds?: readonly LookupRowId[];
			currentRevisions?: LookupTableRevisions;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "LookupSchemaGovernanceError";
		this.code = code;
		this.blockingAppIds = options.blockingAppIds
			? [...options.blockingAppIds]
			: undefined;
		this.incompatibleRowIds = options.incompatibleRowIds
			? [...options.incompatibleRowIds]
			: undefined;
		this.currentRevisions = options.currentRevisions;
	}
}

interface NormalizedOperationBase {
	tableId: LookupTableId;
	expectedTableRevision: LookupRevision;
}

type NormalizedOperation =
	| (NormalizedOperationBase & { kind: "delete-table" })
	| (NormalizedOperationBase & {
			kind: "remove-column";
			columnId: LookupColumnId;
	  })
	| (NormalizedOperationBase & {
			kind: "retype-column";
			columnId: LookupColumnId;
			dataType: LookupDataType;
	  });

interface RemovalAccounting {
	affected_rows: number;
	affected_cells: number;
	freed_bytes: number;
}

interface PresentCellRow {
	row_id: string;
	cell_value: unknown;
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
		throw new Error("Lookup schema governance received an invalid scope.");
	}
}

function assertDeleteCapability(scope: LookupScope): void {
	if (!roleAllowsApp(scope.role, "delete")) {
		throw new LookupSchemaGovernanceError(
			"not_found",
			"Lookup resource was not found.",
		);
	}
}

function assertDeclaredWriterVersion(version: number): void {
	if (
		!Number.isSafeInteger(version) ||
		version < 0 ||
		version > 2_147_483_647
	) {
		throw new RangeError(
			"lookup schema governance writer version must be a nonnegative int4",
		);
	}
}

function normalizeOperation(
	operation: LookupSchemaGovernanceOperation,
): NormalizedOperation {
	const tableId = lookupTableIdSchema.parse(operation.tableId);
	const expectedTableRevision = parseLookupRevision(
		operation.expectedTableRevision,
	);
	switch (operation.kind) {
		case "delete-table":
			return { kind: operation.kind, tableId, expectedTableRevision };
		case "remove-column":
			return {
				kind: operation.kind,
				tableId,
				columnId: lookupColumnIdSchema.parse(operation.columnId),
				expectedTableRevision,
			};
		case "retype-column":
			return {
				kind: operation.kind,
				tableId,
				columnId: lookupColumnIdSchema.parse(operation.columnId),
				dataType: lookupDataTypeSchema.parse(operation.dataType),
				expectedTableRevision,
			};
	}
}

function translateLockedTableError(error: unknown): never {
	if (
		error instanceof LookupError &&
		(error.code === "not_found" || error.code === "conflict")
	) {
		throw new LookupSchemaGovernanceError(error.code, error.message, {
			cause: error,
			currentRevisions: error.currentRevisions,
		});
	}
	throw error;
}

async function lockTargetTable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	operation: NormalizedOperation,
): Promise<StoredLookupTable> {
	try {
		return await lockLookupTableForUpdate(
			tx,
			projectId,
			operation.tableId,
			operation.expectedTableRevision,
		);
	} catch (error) {
		translateLockedTableError(error);
	}
}

async function lockEnabledCompatibility(
	tx: Transaction<AppDatabase>,
	declaredWriterVersion: number,
): Promise<void> {
	const compatibility = await tx
		.selectFrom("lookup_reference_compatibility")
		.select(["minimum_writer_version", "destructive_schema_actions_enabled"])
		.where("id", "=", 1)
		.forShare()
		.executeTakeFirst();
	if (
		!compatibility?.destructive_schema_actions_enabled ||
		declaredWriterVersion < compatibility.minimum_writer_version
	) {
		throw new LookupSchemaGovernanceError(
			"schema_actions_disabled",
			"Lookup schema actions are not enabled for this writer.",
		);
	}
}

async function exactTableBlockers(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
): Promise<string[]> {
	const edges = await tx
		.selectFrom("lookup_table_references")
		.select("app_id")
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.orderBy("app_id", "asc")
		.execute();
	return edges.map(({ app_id: appId }) => appId);
}

async function exactColumnBlockers(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId,
): Promise<string[]> {
	const edges = await tx
		.selectFrom("lookup_column_references")
		.select("app_id")
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.where("column_id", "=", columnId)
		.orderBy("app_id", "asc")
		.execute();
	return edges.map(({ app_id: appId }) => appId);
}

function rejectReferenced(blockingAppIds: readonly string[]): never {
	throw new LookupSchemaGovernanceError(
		"referenced",
		"One or more apps still reference this lookup resource.",
		{ blockingAppIds: [...blockingAppIds] },
	);
}

async function requireColumn(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId,
): Promise<{ dataType: LookupDataType }> {
	const column = await tx
		.selectFrom("lookup_columns")
		.select("data_type")
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId)
		.where("id", "=", columnId)
		.executeTakeFirst();
	if (!column) {
		throw new LookupSchemaGovernanceError(
			"not_found",
			"Lookup resource was not found.",
		);
	}
	return { dataType: lookupDataTypeSchema.parse(column.data_type) };
}

async function deleteTable(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	table: StoredLookupTable,
	operation: Extract<NormalizedOperation, { kind: "delete-table" }>,
): Promise<DeletedLookupTableResult> {
	const blockers = await exactTableBlockers(
		tx,
		scope.projectId,
		operation.tableId,
	);
	if (blockers.length > 0) rejectReferenced(blockers);

	const deleted = await tx
		.deleteFrom("lookup_tables")
		.where("project_id", "=", scope.projectId)
		.where("id", "=", operation.tableId)
		.returning("id")
		.executeTakeFirst();
	if (!deleted) {
		throw new Error("Locked lookup table disappeared before deletion.");
	}
	const projectRevision = await advanceLookupProjectRevision(
		tx,
		scope.projectId,
	);
	await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
	return {
		kind: operation.kind,
		tableId: operation.tableId,
		projectRevision,
		deletedColumnCount: table.column_count,
		deletedRowCount: table.row_count,
		freedBytes: table.data_bytes,
	};
}

async function removeColumn(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	table: StoredLookupTable,
	operation: Extract<NormalizedOperation, { kind: "remove-column" }>,
): Promise<RemovedLookupColumnResult> {
	await requireColumn(
		tx,
		scope.projectId,
		operation.tableId,
		operation.columnId,
	);
	if (table.column_count <= 1) {
		throw new LookupSchemaGovernanceError(
			"last_column",
			"A lookup table must retain at least one column.",
		);
	}
	const blockers = await exactColumnBlockers(
		tx,
		scope.projectId,
		operation.tableId,
		operation.columnId,
	);
	if (blockers.length > 0) rejectReferenced(blockers);

	const changedAt = new Date();
	const accountingResult = await sql<RemovalAccounting>`
		WITH candidates AS MATERIALIZED (
			SELECT project_id, table_id, id, value_bytes AS before_bytes
			FROM lookup_rows
			WHERE project_id = ${scope.projectId}
				AND table_id = ${operation.tableId}
				AND "values" ? ${operation.columnId}::text
			FOR UPDATE
		), updated AS (
			UPDATE lookup_rows AS target
			SET "values" = target."values" - ${operation.columnId}::text,
				updated_by = ${scope.actorId},
				updated_at = ${changedAt}
			FROM candidates
			WHERE target.project_id = candidates.project_id
				AND target.table_id = candidates.table_id
				AND target.id = candidates.id
			RETURNING candidates.before_bytes,
				target.value_bytes AS after_bytes
		)
		SELECT count(*)::integer AS affected_rows,
			count(*)::integer AS affected_cells,
			COALESCE(sum(before_bytes - after_bytes), 0)::integer AS freed_bytes
		FROM updated
	`.execute(tx);
	const accounting = accountingResult.rows[0];
	if (!accounting) {
		throw new Error("Lookup column removal returned no accounting row.");
	}
	const dataBytes = table.data_bytes - accounting.freed_bytes;
	if (dataBytes < 0) {
		throw new Error("Lookup column removal produced negative byte accounting.");
	}

	const deleted = await tx
		.deleteFrom("lookup_columns")
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", operation.tableId)
		.where("id", "=", operation.columnId)
		.returning("id")
		.executeTakeFirst();
	if (!deleted) {
		throw new Error("Locked lookup column disappeared before deletion.");
	}
	const projectRevision = await advanceLookupProjectRevision(
		tx,
		scope.projectId,
	);
	const updated = await updateLockedLookupTable(
		tx,
		scope.projectId,
		operation.tableId,
		{
			column_count: table.column_count - 1,
			data_bytes: dataBytes,
			definition_revision: projectRevision,
			rows_revision: projectRevision,
			updated_by: scope.actorId,
			updated_at: changedAt,
		},
	);
	await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
	return {
		kind: operation.kind,
		tableId: operation.tableId,
		columnId: operation.columnId,
		projectRevision,
		affectedRows: accounting.affected_rows,
		affectedCells: accounting.affected_cells,
		freedBytes: accounting.freed_bytes,
		...lookupTableRevisions(updated),
	};
}

async function retypeColumn(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	table: StoredLookupTable,
	projectRevisionBefore: LookupRevision,
	operation: Extract<NormalizedOperation, { kind: "retype-column" }>,
): Promise<RetypedLookupColumnResult> {
	const column = await requireColumn(
		tx,
		scope.projectId,
		operation.tableId,
		operation.columnId,
	);
	if (column.dataType === operation.dataType) {
		return {
			kind: operation.kind,
			tableId: operation.tableId,
			columnId: operation.columnId,
			dataType: operation.dataType,
			projectRevision: projectRevisionBefore,
			checkedCells: 0,
			changed: false,
			...lookupTableRevisions(table),
		};
	}
	const blockers = await exactColumnBlockers(
		tx,
		scope.projectId,
		operation.tableId,
		operation.columnId,
	);
	if (blockers.length > 0) rejectReferenced(blockers);

	const presentCells = await sql<PresentCellRow>`
		SELECT id::text AS row_id,
			"values" -> ${operation.columnId}::text AS cell_value
		FROM lookup_rows
		WHERE project_id = ${scope.projectId}
			AND table_id = ${operation.tableId}
			AND "values" ? ${operation.columnId}::text
		ORDER BY id ASC
	`.execute(tx);
	const incompatibleRowIds: LookupRowId[] = [];
	for (const cell of presentCells.rows) {
		if (
			!coerceLookupCell(operation.dataType, cell.cell_value, "typed").success
		) {
			incompatibleRowIds.push(lookupRowIdSchema.parse(cell.row_id));
		}
	}
	if (incompatibleRowIds.length > 0) {
		throw new LookupSchemaGovernanceError(
			"incompatible_values",
			"One or more stored cells do not already satisfy the requested type.",
			{ incompatibleRowIds },
		);
	}

	const changed = await tx
		.updateTable("lookup_columns")
		.set({ data_type: operation.dataType })
		.where("project_id", "=", scope.projectId)
		.where("table_id", "=", operation.tableId)
		.where("id", "=", operation.columnId)
		.returning("id")
		.executeTakeFirst();
	if (!changed) {
		throw new Error("Locked lookup column disappeared before retype.");
	}
	const projectRevision = await advanceLookupProjectRevision(
		tx,
		scope.projectId,
	);
	const updated = await updateLockedLookupTable(
		tx,
		scope.projectId,
		operation.tableId,
		{
			definition_revision: projectRevision,
			updated_by: scope.actorId,
			updated_at: new Date(),
		},
	);
	await notifyCommittedLookupMutation(tx, scope.projectId, projectRevision);
	return {
		kind: operation.kind,
		tableId: operation.tableId,
		columnId: operation.columnId,
		dataType: operation.dataType,
		projectRevision,
		checkedCells: presentCells.rows.length,
		changed: true,
		...lookupTableRevisions(updated),
	};
}

/**
 * Package-private production wrapper. It declares the one shared runtime
 * writer capability; the database floor and destructive-action flag remain
 * the admission authority. No route, action, or public lookup barrel imports
 * this module.
 */
export async function applyLookupSchemaGovernance(
	scope: LookupScope,
	operation: LookupSchemaGovernanceOperation,
): Promise<LookupSchemaGovernanceResult> {
	assertScope(scope);
	assertDeleteCapability(scope);
	const normalized = normalizeOperation(operation);
	return withAppTx(async (tx) => {
		await declareLookupReferenceWriter(tx);
		return applyLookupSchemaGovernanceInTransaction(
			tx,
			scope,
			normalized,
			CURRENT_LOOKUP_REFERENCE_WRITER_VERSION,
		);
	});
}

/**
 * Transaction core for the package's seeded integration harness. The caller
 * must set the transaction-local database writer declaration to the exact
 * `declaredWriterVersion` before entry. This function never acquires an app
 * lock: Project state -> table -> compatibility -> exact edges is its complete
 * lock prefix.
 */
export async function applyLookupSchemaGovernanceInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	operationInput: LookupSchemaGovernanceOperation,
	declaredWriterVersion: number,
): Promise<LookupSchemaGovernanceResult> {
	assertScope(scope);
	assertDeleteCapability(scope);
	assertDeclaredWriterVersion(declaredWriterVersion);
	const operation = normalizeOperation(operationInput);
	const projectState = await lockLookupProjectState(tx, scope.projectId);
	const table = await lockTargetTable(tx, scope.projectId, operation);
	await lockEnabledCompatibility(tx, declaredWriterVersion);

	switch (operation.kind) {
		case "delete-table":
			return deleteTable(tx, scope, table, operation);
		case "remove-column":
			return removeColumn(tx, scope, table, operation);
		case "retype-column":
			return retypeColumn(tx, scope, table, projectState.revision, operation);
	}
}
