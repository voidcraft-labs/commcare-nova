import { z } from "zod";
import {
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	applyAuthorizedLookupAuthoringBatch,
	editAuthorizedLookupValue,
	readAuthorizedLookupRowsPage,
	readAuthorizedLookupValue,
	readAuthorizedRowAssignments,
	readAuthorizedTableReaders,
} from "@/lib/lookup/agentService";
import {
	assignmentDirectorySchema,
	rowAssigneesSchema,
} from "@/lib/lookup/assignmentVocabulary";
import { LookupError } from "@/lib/lookup/errors";
import {
	lookupValueEditRequestSchema,
	lookupValueReadRequestSchema,
} from "@/lib/lookup/largeValues/input";
import { contentInput, rowContentSchema } from "@/lib/lookup/namedRowInput";
import {
	lookupColumnDraftSchema,
	lookupColumnLabelSchema,
	lookupDataTypeSchema,
	lookupMemberDraftSchema,
	lookupReaderReviewSchema,
	lookupRevisionSchema,
	lookupRowPatchSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
} from "@/lib/lookup/schema";
import type { LookupAuthoringBatchReceipt } from "@/lib/lookup/types";
import type { ToolInvocationContext } from "../workspace/types";
import type { ReadToolResult } from "./common";
import { lookupAgentScope } from "./shared/lookupScope";

const authoringKeySchema = z
	.string()
	.min(1)
	.max(200)
	.refine((value) => /[A-Za-z0-9]/.test(value), "Use a nonblank request key.");
const cellValueSchema = z.union([z.string(), z.number()]);
const createCellSchema = z.strictObject({
	columnKey: authoringKeySchema.describe(
		"Request-local column key from this createLookupTable call.",
	),
	value: cellValueSchema,
});
const existingCellSchema = z.strictObject({
	columnId: lookupColumnIdSchema,
	value: cellValueSchema,
});
const memberEditSchema = lookupMemberDraftSchema.extend({
	id: lookupMemberIdSchema
		.optional()
		.describe("Keep this ID when editing an existing detail."),
});
const createRowSchema = z.strictObject({
	cells: z.array(createCellSchema).max(250),
	content: rowContentSchema.optional(),
});
const existingRowSchema = z.strictObject({
	cells: z.array(existingCellSchema).max(250),
	content: rowContentSchema.optional(),
});

/** Keeps every success receipt safely below the shared MCP/model result
 * ceiling. Larger tables remain authorable through successive bounded calls. */
export const LOOKUP_TOOL_MAX_CREATED_IDENTITIES = 750;
/** Leaves room for the shared-tool envelope below its 100k result cap. */
export const LOOKUP_TOOL_RESULT_MAX_BYTES = 70_000;
/** Canonical UUIDs are always 36 unescaped JSON bytes. The budget projection
 * needs that width, not an authored identity value. */
const RECEIPT_IDENTITY_WIDTH = "x".repeat(36);
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
		return await applyAuthorizedLookupAuthoringBatch(
			lookupAgentScope(ctx),
			input,
		);
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
	.strictObject({
		valueSlice: lookupValueReadRequestSchema.omit({ tableId: true }).optional(),
		readerPage: z
			.strictObject({
				offset: z.number().int().nonnegative(),
				digest: z.string().optional(),
			})
			.optional()
			.describe(
				"For a schema change, read the apps using this table. Start at offset 0 and continue with nextReaderPage until complete.",
			),
		tableId: lookupTableIdSchema,
		assignments: z
			.strictObject({
				rowId: lookupRowIdSchema,
				search: assignmentDirectorySchema,
			})
			.optional(),
		rowId: lookupRowIdSchema
			.optional()
			.describe("Open one row by stable ID, including its later pages."),
		query: z.string().trim().max(200).optional(),
		columnIds: z.array(lookupColumnIdSchema).max(250).optional(),
		attributeIds: z.array(lookupMemberIdSchema).max(250).optional(),
		cursor: z.string().min(1).max(4096).optional(),
	})
	.superRefine((input, context) => {
		if (
			(input.readerPage || input.valueSlice || input.assignments) &&
			Object.keys(input).filter(
				(key) =>
					key !== "tableId" && input[key as keyof typeof input] !== undefined,
			).length !== 1
		)
			context.addIssue({
				code: "custom",
				message:
					"Use readerPage or valueSlice by itself with the table ID. Row searches and their cursors belong to a separate read.",
			});
	});

export const getLookupTableRowsTool = {
	description:
		"Read an ordered page of rows or the apps using a table. An editor can inspect a row’s assignments and search available workers, groups or places by name using assignments; continue with nextOffset. Continue with the same query and cursor. Assemble large values from parts by row, slot and text offset. When definitionInCatalog is true, getLookupTables supplies the definition. Read an individual text slice by its row, slot, expected table revision and UTF-8 byte offset with valueSlice. The digest and nextByteOffset belong to the complete value.",
	inputSchema: getLookupTableRowsInputSchema,
	async execute(
		input: z.infer<typeof getLookupTableRowsInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		try {
			if (input.assignments)
				return {
					kind: "read",
					data: await readAuthorizedRowAssignments(
						lookupAgentScope(ctx),
						input.tableId,
						input.assignments.rowId,
						input.assignments.search,
						ctx.dataGrant,
					),
				};
			if (input.valueSlice)
				return {
					kind: "read",
					data: await readAuthorizedLookupValue(
						lookupAgentScope(ctx),
						{ ...input.valueSlice, tableId: input.tableId },
						ctx.dataGrant,
					),
				};
			if (input.readerPage)
				return {
					kind: "read",
					data: await readAuthorizedTableReaders(
						lookupAgentScope(ctx),
						input.tableId,
						input.readerPage,
					),
				};
			const page = await readAuthorizedLookupRowsPage(
				lookupAgentScope(ctx),
				input,
			);
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

export const createLookupTableToolInputSchema = z.strictObject({
	name: lookupTableNameSchema,
	tag: lookupTagSchema,
	attributes: z.array(lookupMemberDraftSchema).max(250).optional(),
	columns: z
		.array(lookupColumnDraftSchema.safeExtend({ key: authoringKeySchema }))
		.max(250),
	rows: z.array(createRowSchema).max(5000).optional(),
});

export const createLookupTableTool = {
	description:
		"Create a Project data table with columns, row details, or both. Scalar cells use request-local column keys. A repeated text column holds an ordered list with optional details on each value. Look up detail IDs in the catalog after creating them.",
	inputSchema: createLookupTableToolInputSchema,
	async execute(
		input: z.infer<typeof createLookupTableToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const rowCount = input.rows?.length ?? 0;
		const overflow = receiptWouldOverflow(1 + input.columns.length + rowCount, {
			ok: true,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_IDENTITY_WIDTH,
			columns: input.columns.map((column) => ({
				key: column.key,
				columnId: RECEIPT_IDENTITY_WIDTH,
			})),
			rows: Array.from({ length: rowCount }, (_, index) => ({
				index,
				rowId: RECEIPT_IDENTITY_WIDTH,
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
					attributes: input.attributes,
					rows: (input.rows ?? []).map((row, index) => ({
						key: `row-${index}`,
						cells: row.cells,
						...contentInput(row.content),
					})),
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				ok: true,
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
	.strictObject({
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
		name: lookupTableNameSchema.optional(),
		tag: lookupTagSchema.optional(),
		attributes: z.array(memberEditSchema).max(250).optional(),
		reviewed: lookupReaderReviewSchema.optional(),
	})
	.superRefine((value, ctx) => {
		if (
			value.name === undefined &&
			value.tag === undefined &&
			value.attributes === undefined
		) {
			ctx.addIssue({
				code: "custom",
				message: "Provide a name, export tag or ordered row details to update.",
			});
		}
	});

export const updateLookupTableTool = {
	description:
		"Update a Project data table's display name, export tag or complete ordered row details. Preserve existing IDs for each retained detail. A tag change requires delete capability because HQ treats a new tag as a different remote table.",
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
				ok: true,
				projectRevision: receipt.projectRevision,
				tableId: table.tableId,
				revisions: table.revisions,
			},
		};
	},
};

const columnOperationSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("add"),
		key: authoringKeySchema,
		column: lookupColumnDraftSchema,
		afterColumnId: lookupColumnIdSchema.nullable().optional(),
	}),
	z
		.strictObject({
			kind: z.literal("update"),
			columnId: lookupColumnIdSchema,
			label: lookupColumnLabelSchema.optional(),
			wireName: lookupWireNameSchema.optional(),
			repeated: z.boolean().optional(),
			properties: z.array(memberEditSchema).max(250).optional(),
			indexed: z.boolean().optional(),
		})
		.superRefine((value, ctx) => {
			if (
				[
					value.label,
					value.wireName,
					value.repeated,
					value.properties,
					value.indexed,
				].every((field) => field === undefined)
			) {
				ctx.addIssue({
					code: "custom",
					message: "Choose at least one column setting to update.",
				});
			}
		}),
	z.strictObject({
		kind: z.literal("move"),
		columnId: lookupColumnIdSchema,
		afterColumnId: lookupColumnIdSchema.nullable(),
	}),
	z.strictObject({ kind: z.literal("remove"), columnId: lookupColumnIdSchema }),
	z.strictObject({
		kind: z.literal("retype"),
		columnId: lookupColumnIdSchema,
		dataType: lookupDataTypeSchema,
	}),
]);

export const editLookupColumnsToolInputSchema = z.strictObject({
	tableId: lookupTableIdSchema,
	expectedTableRevision: lookupRevisionSchema,
	operations: z.array(columnOperationSchema).min(1).max(250),
	reviewed: lookupReaderReviewSchema.optional(),
});

export const editLookupColumnsTool = {
	description:
		"Add, edit, move or remove columns. A repeated text column can have ordered value details. When editing those details supply the whole list with existing IDs for retained entries. Indexing helps workers find data in the column.",
	inputSchema: editLookupColumnsToolInputSchema,
	async execute(
		input: z.infer<typeof editLookupColumnsToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const added = input.operations.filter(
			(operation) => operation.kind === "add",
		);
		const overflow = receiptWouldOverflow(added.length, {
			ok: true,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_IDENTITY_WIDTH,
			createdColumns: added.map((operation) => ({
				key: operation.key,
				columnId: RECEIPT_IDENTITY_WIDTH,
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
					reviewed: input.reviewed,
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				ok: true,
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

// The tool receives fixed property names; the store receives an identity-keyed
// value detail map. All other addressed changes share the service schema.
const insertedValueSchema = z
	.strictObject({
		kind: z.literal("insert"),
		columnId: lookupColumnIdSchema,
		index: z.number().int().nonnegative(),
		text: z.string(),
		properties: z
			.array(
				z.strictObject({ propertyId: lookupMemberIdSchema, text: z.string() }),
			)
			.max(250),
	})
	.refine(
		(value) =>
			new Set(value.properties.map((item) => item.propertyId)).size ===
			value.properties.length,
		"Each value detail needs its own ID.",
	);
const toolPatchSchema = z.union([
	...lookupRowPatchSchema.options.filter(
		(
			schema,
		): schema is Exclude<
			(typeof lookupRowPatchSchema.options)[number],
			{ shape: { kind: z.ZodLiteral<"insert"> } }
		> => schema.shape.kind.value !== "insert",
	),
	insertedValueSchema,
]);

const rowOperationSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("assign"),
		rowId: lookupRowIdSchema,
		assignments: rowAssigneesSchema,
	}),
	z.strictObject({
		kind: z.literal("patch"),
		rowId: lookupRowIdSchema,
		changes: z.array(toolPatchSchema).min(1).max(250),
	}),
	z.strictObject({
		kind: z.literal("add"),
		assignments: rowAssigneesSchema.optional(),
		cells: z.array(existingCellSchema).max(250),
		content: rowContentSchema.optional(),
		afterRowId: lookupRowIdSchema.nullable().optional(),
	}),
	z.strictObject({
		kind: z.literal("update"),
		rowId: lookupRowIdSchema,
		cells: z.array(existingCellSchema).max(250),
		content: rowContentSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("move"),
		rowId: lookupRowIdSchema,
		afterRowId: lookupRowIdSchema.nullable(),
	}),
	z.strictObject({ kind: z.literal("remove"), rowId: lookupRowIdSchema }),
]);

export const editLookupRowsToolInputSchema = z
	.strictObject({
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
		workerAccess: z.enum(["all", "assigned"]).optional(),
		reviewed: lookupReaderReviewSchema.optional(),
		operations: z.array(rowOperationSchema).max(5000).optional(),
		valueEdit: lookupValueEditRequestSchema.optional(),
	})
	.refine(
		(input) => Boolean(input.operations) !== Boolean(input.valueEdit),
		"Choose row operations or one staged value edit.",
	);

export const editLookupRowsTool = {
	description:
		"Add, edit, move or remove rows. Set workerAccess to assigned to send only rows a worker receives by direct assignment, any group, or their primary place or its ancestors. Review the apps using the table before changing workerAccess. Use assign with the complete desired set of worker, group or place identities. An empty set grants nobody the row. Give scalar cells by column ID. Rich content uses exact text and export names. Preserve repeated values in order. An empty list contains zero values and a list containing empty text contains one. An omitted content object on a row update keeps its rich values. Patch one or more addressed cells, details or zero-based list positions at the read revision to preserve every other value, including unread parts of large rows. To replace a UTF-8 byte span, send valueEdit alone. Begin with a stable operationId, exact base digest, byte bounds and replacement size/digest. Append ordered base64 chunks of up to 32 KiB at the acknowledged offset, then finish or cancel. Retry the same request after an interruption.",
	inputSchema: editLookupRowsToolInputSchema,
	async execute(
		input: z.infer<typeof editLookupRowsToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		if (input.valueEdit) {
			const command = input.valueEdit;
			if (
				command.tableId !== input.tableId ||
				(command.kind === "begin" &&
					command.expectedTableRevision !== input.expectedTableRevision)
			)
				return {
					kind: "read",
					data: {
						code: "invalid_input",
						error: "This edit needs the same table and revision you opened.",
					},
				};
			try {
				return {
					kind: "read",
					data: await editAuthorizedLookupValue(
						lookupAgentScope(ctx),
						command,
						ctx.dataGrant,
					),
				};
			} catch (error) {
				if (error instanceof LookupError)
					return { kind: "read", data: lookupFailure(error) };
				throw error;
			}
		}
		const operations = input.operations ?? [];
		const addedCount = operations.filter(
			(operation) => operation.kind === "add",
		).length;
		const overflow = receiptWouldOverflow(addedCount, {
			ok: true,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_IDENTITY_WIDTH,
			createdRows: Array.from({ length: addedCount }, (_, operationIndex) => ({
				operationIndex,
				rowId: RECEIPT_IDENTITY_WIDTH,
			})),
			revisions: RECEIPT_REVISIONS,
		});
		if (overflow !== null) return { kind: "read", data: overflow };
		const rowOperations = operations.map((operation, operationIndex) => {
			if (
				operation.kind === "move" ||
				operation.kind === "remove" ||
				operation.kind === "assign"
			)
				return operation;
			if (operation.kind === "patch")
				return {
					...operation,
					changes: operation.changes.map((change) =>
						change.kind === "insert"
							? {
									kind: change.kind,
									columnId: change.columnId,
									index: change.index,
									value: {
										text: change.text,
										properties: Object.fromEntries(
											change.properties.map((p) => [p.propertyId, p.text]),
										),
									},
								}
							: change,
					),
				};
			const { content, ...rest } = operation;
			return rest.kind === "add"
				? {
						...rest,
						...contentInput(content),
						key: `operation-${operationIndex}`,
					}
				: { ...rest, ...contentInput(content) };
		});
		const result = await author(ctx, {
			updateTables: [
				{
					tableId: input.tableId,
					expectedTableRevision: input.expectedTableRevision,
					workerAccess: input.workerAccess,
					reviewed: input.reviewed,
					rowOperations,
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				ok: true,
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

export const replaceLookupRowsToolInputSchema = z.strictObject({
	tableId: lookupTableIdSchema,
	expectedTableRevision: lookupRevisionSchema,
	rows: z.array(existingRowSchema).max(5000),
});

export const replaceLookupRowsTool = {
	description:
		"Replace a Project data table's complete row set atomically. A nonempty replacement mints fresh row UUIDs and returns them in input order. An empty list clears the table.",
	inputSchema: replaceLookupRowsToolInputSchema,
	async execute(
		input: z.infer<typeof replaceLookupRowsToolInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const overflow = receiptWouldOverflow(input.rows.length, {
			ok: true,
			projectRevision: RECEIPT_REVISION,
			tableId: RECEIPT_IDENTITY_WIDTH,
			rows: input.rows.map((_row, inputIndex) => ({
				inputIndex,
				rowId: RECEIPT_IDENTITY_WIDTH,
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
						...contentInput(row.content),
					})),
				},
			],
		});
		if ("error" in result) return { kind: "read", data: result };
		const { receipt, table } = resultTable(result);
		return {
			kind: "read",
			data: {
				ok: true,
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

export const removeLookupTableToolInputSchema = z.strictObject({
	tableId: lookupTableIdSchema,
	expectedTableRevision: lookupRevisionSchema,
});

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
				ok: true,
				projectRevision: result.projectRevision,
				tableId: input.tableId,
			},
		};
	},
};
