import { z } from "zod";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	applyAuthorizedLookupAuthoringBatch,
	readAuthorizedLookupRowsPage,
} from "@/lib/lookup/agentService";
import { LookupError } from "@/lib/lookup/errors";
import {
	lookupColumnDraftSchema,
	lookupColumnLabelSchema,
	lookupDataTypeSchema,
	lookupRevisionSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
} from "@/lib/lookup/schema";
import type {
	LookupAgentWriteScope,
	LookupAuthoringBatchReceipt,
} from "@/lib/lookup/types";
import type { ToolInvocationContext } from "../workspace/types";
import { type ReadToolResult, requireInvocationAppId } from "./common";

const authoringKeySchema = z
	.string()
	.min(1)
	.max(200)
	.refine((value) => /[A-Za-z0-9]/.test(value), "Use a nonblank request key.");
const cellValueSchema = z.union([z.string(), z.number().finite()]);
const createCellSchema = z
	.object({
		columnKey: authoringKeySchema.describe(
			"Request-local column key from this createLookupTable call.",
		),
		value: cellValueSchema,
	})
	.strict();
const existingCellSchema = z
	.object({
		columnId: lookupColumnIdSchema,
		value: cellValueSchema,
	})
	.strict();
const createRowSchema = z
	.object({ cells: z.array(createCellSchema).max(250) })
	.strict();
const existingRowSchema = z
	.object({ cells: z.array(existingCellSchema).max(250) })
	.strict();

/** Keeps every success receipt safely below the shared MCP/model result
 * ceiling. Larger tables remain authorable through successive bounded calls. */
export const LOOKUP_TOOL_MAX_CREATED_IDENTITIES = 750;
/** Leaves room for the shared-tool envelope below its 100k result cap. */
export const LOOKUP_TOOL_RESULT_MAX_BYTES = 70_000;
const RECEIPT_UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RECEIPT_REVISION = "9223372036854775807";
const RECEIPT_REVISIONS = {
	definitionRevision: RECEIPT_REVISION,
	rowsRevision: RECEIPT_REVISION,
	tableRevision: RECEIPT_REVISION,
};

function receiptWouldOverflow(
	count: number,
	projectedData: unknown,
): LookupToolFailure | null {
	if (count > LOOKUP_TOOL_MAX_CREATED_IDENTITIES) {
		return {
			error: `This call would create ${count} identities, more than the ${LOOKUP_TOOL_MAX_CREATED_IDENTITIES} that can be returned safely in one tool result. Split the rows across successive calls.`,
			code: "invalid_input",
		};
	}
	const projectedBytes = Buffer.byteLength(
		JSON.stringify({ kind: "read", data: projectedData }),
		"utf8",
	);
	return projectedBytes <= LOOKUP_TOOL_RESULT_MAX_BYTES
		? null
		: {
				error: `This call's success receipt would be ${projectedBytes} bytes, more than the ${LOOKUP_TOOL_RESULT_MAX_BYTES}-byte safe result budget. Split the rows or columns across successive calls.`,
				code: "invalid_input",
			};
}

function writeScope(ctx: ToolInvocationContext): LookupAgentWriteScope {
	return {
		appId: requireInvocationAppId(ctx),
		projectId: ctx.projectId,
		actorId: ctx.userId,
		runId: ctx.runId,
		...(ctx.chatRunHolder === undefined
			? {}
			: { chatRunHolder: ctx.chatRunHolder }),
	};
}

type LookupToolFailure = {
	error: string;
	code?: string;
	details?: unknown;
	totalDetailCount?: number;
	currentRevisions?: unknown;
	blockingApps?: unknown;
	incompatibleRowIds?: unknown;
};

function lookupFailure(error: LookupError): LookupToolFailure {
	return {
		error: error.message,
		code: error.code,
		...(error.details === undefined ? {} : { details: error.details }),
		...(error.totalDetailCount === undefined
			? {}
			: { totalDetailCount: error.totalDetailCount }),
		...(error.currentRevisions === undefined
			? {}
			: { currentRevisions: error.currentRevisions }),
		...(error.blockingApps === undefined
			? {}
			: { blockingApps: error.blockingApps }),
		...(error.incompatibleRowIds === undefined
			? {}
			: { incompatibleRowIds: error.incompatibleRowIds }),
	};
}

async function author(
	ctx: ToolInvocationContext,
	input: Parameters<typeof applyAuthorizedLookupAuthoringBatch>[1],
): Promise<LookupAuthoringBatchReceipt | LookupToolFailure> {
	try {
		return await applyAuthorizedLookupAuthoringBatch(writeScope(ctx), input);
	} catch (error) {
		if (error instanceof LookupError) return lookupFailure(error);
		throw error;
	}
}

function resultTable(receipt: LookupAuthoringBatchReceipt) {
	const table = receipt.tables[0];
	if (table === undefined)
		throw new Error("Lookup authoring returned no table receipt.");
	return { receipt, table };
}

function requireCreatedId<T>(
	value: T | undefined,
	kind: "column" | "row",
	index: number,
): T {
	if (value !== undefined) return value;
	throw new Error(
		`Lookup authoring omitted the created ${kind} receipt at input index ${index}.`,
	);
}
export const getLookupTableRowsInputSchema = z
	.object({
		tableId: lookupTableIdSchema,
		query: z.string().trim().max(200).optional(),
		columnIds: z.array(lookupColumnIdSchema).max(250).optional(),
		cursor: z.string().min(1).max(4096).optional(),
	})
	.strict();

export const getLookupTableRowsTool = {
	description:
		"Read one ordered page of up to 100 rows from a Project data table. Optionally search the projected columns. To continue, repeat the same query and columnIds with the returned cursor; a changed table refuses instead of mixing snapshots.",
	inputSchema: getLookupTableRowsInputSchema,
	async execute(
		input: z.infer<typeof getLookupTableRowsInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		try {
			const page = await readAuthorizedLookupRowsPage(writeScope(ctx), input);
			return {
				kind: "read",
				data: {
					table: page.table,
					rows: page.rows,
					complete: page.complete,
					...(page.nextCursor === undefined
						? {}
						: { nextCursor: page.nextCursor }),
				},
			};
		} catch (error) {
			if (error instanceof LookupError) {
				return { kind: "read", data: lookupFailure(error) };
			}
			throw error;
		}
	},
};

export const createLookupTableToolInputSchema = z
	.object({
		name: lookupTableNameSchema,
		tag: lookupTagSchema,
		columns: z
			.array(lookupColumnDraftSchema.safeExtend({ key: authoringKeySchema }))
			.min(1)
			.max(250),
		rows: z.array(createRowSchema).max(5000).optional(),
	})
	.strict();

export const createLookupTableTool = {
	description:
		"Create one Project data table with its complete initial schema and optional rows in one atomic write. Give each column a request-local key and use that key in row cells. Returns every durable table, column, and row UUID in input order.",
	inputSchema: createLookupTableToolInputSchema,
	async execute(
		input: z.infer<typeof createLookupTableToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const rowCount = input.rows?.length ?? 0;
		const overflow = receiptWouldOverflow(1 + input.columns.length + rowCount, {
			message: `Created Project data table "${input.name}" with ${input.columns.length} columns and ${rowCount} rows.`,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_UUID,
			columns: input.columns.map((column) => ({
				key: column.key,
				columnId: RECEIPT_UUID,
			})),
			rows: Array.from({ length: rowCount }, (_, index) => ({
				index,
				rowId: RECEIPT_UUID,
			})),
			revisions: RECEIPT_REVISIONS,
		});
		if (overflow !== null) return { kind: "read", data: overflow };
		const result = await author(ctx, {
			createTables: [
				{
					key: "table",
					name: input.name,
					tag: input.tag,
					columns: input.columns,
					rows: (input.rows ?? []).map((row, index) => ({
						key: `row-${index}`,
						cells: row.cells,
					})),
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				message: `Created Project data table "${input.name}" with ${input.columns.length} columns and ${input.rows?.length ?? 0} rows.`,
				projectRevision: receipt.projectRevision,
				tableId: table.tableId,
				columns: input.columns.map((column, index) => ({
					key: column.key,
					columnId: requireCreatedId(table.columnIds[index], "column", index)
						.id,
				})),
				rows: (input.rows ?? []).map((_row, index) => ({
					index,
					rowId: requireCreatedId(table.rowIds[index], "row", index).id,
				})),
				revisions: table.revisions,
			},
		};
	},
};

export const updateLookupTableToolInputSchema = z
	.object({
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
		name: lookupTableNameSchema.optional(),
		tag: lookupTagSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.name === undefined && value.tag === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "Provide name or tag to update.",
			});
		}
	});

export const updateLookupTableTool = {
	description:
		"Update a Project data table's display name or export tag. A tag change requires delete capability because HQ treats a new tag as a different remote table.",
	inputSchema: updateLookupTableToolInputSchema,
	async execute(
		input: z.infer<typeof updateLookupTableToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const result = await author(ctx, { updateTables: [input] });
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				message: "Updated the Project data table.",
				projectRevision: receipt.projectRevision,
				tableId: table.tableId,
				revisions: table.revisions,
			},
		};
	},
};

const columnOperationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("add"),
			key: authoringKeySchema,
			column: lookupColumnDraftSchema,
			afterColumnId: lookupColumnIdSchema.nullable().optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("update"),
			columnId: lookupColumnIdSchema,
			label: lookupColumnLabelSchema.optional(),
			wireName: lookupWireNameSchema.optional(),
		})
		.strict()
		.superRefine((value, ctx) => {
			if (value.label === undefined && value.wireName === undefined) {
				ctx.addIssue({
					code: "custom",
					message: "Provide label or wireName to update.",
				});
			}
		}),
	z
		.object({
			kind: z.literal("move"),
			columnId: lookupColumnIdSchema,
			afterColumnId: lookupColumnIdSchema.nullable(),
		})
		.strict(),
	z
		.object({ kind: z.literal("remove"), columnId: lookupColumnIdSchema })
		.strict(),
	z
		.object({
			kind: z.literal("retype"),
			columnId: lookupColumnIdSchema,
			dataType: lookupDataTypeSchema,
		})
		.strict(),
]);

export const editLookupColumnsToolInputSchema = z
	.object({
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
		operations: z.array(columnOperationSchema).min(1).max(250),
	})
	.strict();

export const editLookupColumnsTool = {
	description:
		"Atomically add, rename, move, remove, or retype columns in one Project data table. UUID anchors are resolved under the table lock; null means first and an omitted add anchor appends. Destructive operations retain reference and accepted-design guards.",
	inputSchema: editLookupColumnsToolInputSchema,
	async execute(
		input: z.infer<typeof editLookupColumnsToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const added = input.operations.filter(
			(operation) => operation.kind === "add",
		);
		const overflow = receiptWouldOverflow(added.length, {
			message: `Applied ${input.operations.length} column changes atomically.`,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_UUID,
			createdColumns: added.map((operation) => ({
				key: operation.key,
				columnId: RECEIPT_UUID,
			})),
			revisions: RECEIPT_REVISIONS,
		});
		if (overflow !== null) return { kind: "read", data: overflow };
		const result = await author(ctx, {
			updateTables: [
				{
					tableId: input.tableId,
					expectedTableRevision: input.expectedTableRevision,
					columnOperations: input.operations,
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				message: `Applied ${input.operations.length} column changes atomically.`,
				projectRevision: receipt.projectRevision,
				tableId: table.tableId,
				createdColumns: table.columnIds.map(({ key, id }) => ({
					key,
					columnId: id,
				})),
				revisions: table.revisions,
			},
		};
	},
};

const rowOperationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("add"),
			cells: z.array(existingCellSchema).max(250),
			afterRowId: lookupRowIdSchema.nullable().optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("update"),
			rowId: lookupRowIdSchema,
			cells: z.array(existingCellSchema).max(250),
		})
		.strict(),
	z
		.object({
			kind: z.literal("move"),
			rowId: lookupRowIdSchema,
			afterRowId: lookupRowIdSchema.nullable(),
		})
		.strict(),
	z.object({ kind: z.literal("remove"), rowId: lookupRowIdSchema }).strict(),
]);

export const editLookupRowsToolInputSchema = z
	.object({
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
		operations: z.array(rowOperationSchema).min(1).max(5000),
	})
	.strict();

export const editLookupRowsTool = {
	description:
		"Atomically add, wholly update, move, or remove rows in one Project data table. Row cells are UUID-addressed; omitted cells are missing and an explicit empty string remains a value. UUID anchors are resolved under the table lock.",
	inputSchema: editLookupRowsToolInputSchema,
	async execute(
		input: z.infer<typeof editLookupRowsToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const addedCount = input.operations.filter(
			(operation) => operation.kind === "add",
		).length;
		const overflow = receiptWouldOverflow(addedCount, {
			message: `Applied ${input.operations.length} row changes atomically.`,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_UUID,
			createdRows: Array.from({ length: addedCount }, (_, operationIndex) => ({
				operationIndex,
				rowId: RECEIPT_UUID,
			})),
			revisions: RECEIPT_REVISIONS,
		});
		if (overflow !== null) return { kind: "read", data: overflow };
		const rowOperations = input.operations.map((operation, operationIndex) =>
			operation.kind === "add"
				? { ...operation, key: `operation-${operationIndex}` }
				: operation,
		);
		const result = await author(ctx, {
			updateTables: [
				{
					tableId: input.tableId,
					expectedTableRevision: input.expectedTableRevision,
					rowOperations,
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				message: `Applied ${input.operations.length} row changes atomically.`,
				projectRevision: receipt.projectRevision,
				tableId: table.tableId,
				createdRows: table.rowIds.map(({ key, id }) => ({
					operationIndex: Number(key.slice("operation-".length)),
					rowId: id,
				})),
				revisions: table.revisions,
			},
		};
	},
};

export const replaceLookupRowsToolInputSchema = z
	.object({
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
		rows: z.array(existingRowSchema).max(5000),
	})
	.strict();

export const replaceLookupRowsTool = {
	description:
		"Replace a Project data table's complete row set atomically. A nonempty replacement mints fresh row UUIDs and returns them in input order. An empty list clears the table.",
	inputSchema: replaceLookupRowsToolInputSchema,
	async execute(
		input: z.infer<typeof replaceLookupRowsToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const overflow = receiptWouldOverflow(input.rows.length, {
			message: `Replaced the table with ${input.rows.length} rows.`,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_UUID,
			rows: input.rows.map((_row, inputIndex) => ({
				inputIndex,
				rowId: RECEIPT_UUID,
			})),
			revisions: RECEIPT_REVISIONS,
		});
		if (overflow !== null) return { kind: "read", data: overflow };
		const result = await author(ctx, {
			updateTables: [
				{
					tableId: input.tableId,
					expectedTableRevision: input.expectedTableRevision,
					replaceRows: input.rows.map((row, index) => ({
						key: `row-${index}`,
						cells: row.cells,
					})),
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				message: `Replaced the table with ${input.rows.length} rows.`,
				projectRevision: receipt.projectRevision,
				tableId: table.tableId,
				rows: table.rowIds.map(({ key, id }) => ({
					inputIndex: Number(key.slice("row-".length)),
					rowId: id,
				})),
				revisions: table.revisions,
			},
		};
	},
};

export const removeLookupTableToolInputSchema = z
	.object({
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
	})
	.strict();

export const removeLookupTableTool = {
	description:
		"Delete one unreferenced Project data table. Requires delete capability and refuses while an app or accepted pre-genesis design still depends on it.",
	inputSchema: removeLookupTableToolInputSchema,
	async execute(
		input: z.infer<typeof removeLookupTableToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const result = await author(ctx, {
			updateTables: [{ ...input, delete: true }],
		});
		if ("error" in result) return { kind: "read", data: result };
		return {
			kind: "read",
			data: {
				message: `Deleted Project data table "${input.tableId}".`,
				projectRevision: result.projectRevision,
				tableId: input.tableId,
			},
		};
	},
};
