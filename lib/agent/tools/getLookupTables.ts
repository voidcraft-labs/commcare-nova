import { z } from "zod";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { readAuthorizedLookupCatalog } from "@/lib/lookup/agentService";
import { LookupError } from "@/lib/lookup/errors";
import type { LookupAgentWriteScope, LookupDataType } from "@/lib/lookup/types";
import type { ToolInvocationContext } from "../workspace/types";
import { type ReadToolResult, requireInvocationAppId } from "./common";

/** Leaves ample room for the shared MCP result envelope below its 100k cap. */
export const LOOKUP_CATALOG_PAGE_MAX_BYTES = 70_000;
const LOOKUP_CATALOG_CURSOR_RESERVE_BYTES = 1_000;
const catalogCursorSchema = z
	.object({
		v: z.literal(1),
		projectId: z.string().min(1),
		projectRevision: z.string(),
		tableIndex: z.number().int().nonnegative(),
		columnOffset: z.number().int().nonnegative(),
	})
	.strict();

export const getLookupTablesInputSchema = z
	.object({
		cursor: z.string().min(1).max(4096).optional(),
	})
	.strict();
export type GetLookupTablesInput = z.infer<typeof getLookupTablesInputSchema>;

interface CatalogColumn {
	readonly id: LookupColumnId;
	readonly wireName: string;
	readonly label: string;
	readonly dataType: LookupDataType;
}
interface CatalogTableSegment {
	readonly id: LookupTableId;
	readonly name: string;
	readonly tag: string;
	readonly columnCount: number;
	readonly rowCount: number;
	readonly dataBytes: number;
	readonly definitionRevision: string;
	readonly rowsRevision: string;
	readonly tableRevision: string;
	readonly columnOffset?: number;
	readonly columnsComplete: boolean;
	readonly columns: readonly CatalogColumn[];
}
export type GetLookupTablesResult =
	| {
			readonly projectRevision: string;
			readonly tables: readonly CatalogTableSegment[];
			readonly complete: boolean;
			readonly nextCursor?: string;
	  }
	| { readonly error: string; readonly code?: string };

function readScope(ctx: ToolInvocationContext): LookupAgentWriteScope {
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

async function readCatalog(ctx: ToolInvocationContext) {
	if (ctx.appId !== null) {
		return readAuthorizedLookupCatalog(readScope(ctx));
	}
	if (ctx.lookupCatalog === undefined) {
		throw new Error(
			"The pre-genesis lookup catalog reader is unavailable in this workspace.",
		);
	}
	return ctx.lookupCatalog();
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function decodeCursor(value: string | undefined) {
	if (value === undefined) return undefined;
	try {
		return catalogCursorSchema.parse(
			JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
		);
	} catch {
		throw new LookupError(
			"invalid_input",
			"The lookup catalog cursor is invalid. Start again without a cursor.",
		);
	}
}
function encodeCursor(value: z.infer<typeof catalogCursorSchema>): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function projectColumn(column: CatalogColumn): CatalogColumn {
	return {
		id: column.id,
		wireName: column.wireName,
		label: column.label,
		dataType: column.dataType,
	};
}

/** Rows-free Project data catalog. A large catalog continues by table/column
 * segment without ever crossing the model-facing result ceiling. */
export const getLookupTablesTool = {
	description:
		"List this app Project's data tables and columns in bounded snapshot pages. Copy table and column uuids into lookup-backed fields and expressions. Continue only with nextCursor until complete is true.",
	inputSchema: getLookupTablesInputSchema,
	async execute(
		input: GetLookupTablesInput,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<GetLookupTablesResult>> {
		try {
			const cursor = decodeCursor(input.cursor);
			const catalog = await readCatalog(ctx);
			if (cursor !== undefined && cursor.projectId !== catalog.projectId) {
				throw new LookupError(
					"invalid_input",
					"The lookup catalog cursor belongs to a different Project. Start again without a cursor.",
				);
			}
			if (
				cursor !== undefined &&
				cursor.projectRevision !== catalog.projectRevision
			) {
				throw new LookupError(
					"conflict",
					"Project data changed while its catalog was being read. Start again without a cursor.",
				);
			}
			let tableIndex = cursor?.tableIndex ?? 0;
			let columnOffset = cursor?.columnOffset ?? 0;
			if (tableIndex > catalog.definitions.length) {
				throw new LookupError(
					"invalid_input",
					"The lookup catalog cursor is outside this catalog. Start again without a cursor.",
				);
			}
			const tables: CatalogTableSegment[] = [];
			let nextCursor: string | undefined;
			catalogPage: while (tableIndex < catalog.definitions.length) {
				const table = catalog.definitions[tableIndex];
				if (columnOffset > table.columns.length) {
					throw new LookupError(
						"invalid_input",
						"The lookup catalog cursor is outside this table. Start again without a cursor.",
					);
				}
				const base = {
					id: table.id,
					name: table.name,
					tag: table.tag,
					columnCount: table.columnCount ?? table.columns.length,
					rowCount: table.rowCount ?? 0,
					dataBytes: table.dataBytes ?? 0,
					definitionRevision: table.definitionRevision,
					rowsRevision: table.rowsRevision ?? table.definitionRevision,
					tableRevision: table.tableRevision ?? table.definitionRevision,
				};
				const columns: CatalogColumn[] = [];
				for (let index = columnOffset; index < table.columns.length; index++) {
					const projected = projectColumn(table.columns[index]);
					const candidate: CatalogTableSegment = {
						...base,
						...(columnOffset === 0 ? {} : { columnOffset }),
						columnsComplete: index + 1 === table.columns.length,
						columns: [...columns, projected],
					};
					if (
						jsonBytes({
							projectRevision: catalog.projectRevision,
							complete: false,
							tables: [...tables, candidate],
						}) >
						LOOKUP_CATALOG_PAGE_MAX_BYTES - LOOKUP_CATALOG_CURSOR_RESERVE_BYTES
					) {
						if (columns.length === 0 && tables.length > 0) {
							nextCursor = encodeCursor({
								v: 1,
								projectId: catalog.projectId,
								projectRevision: catalog.projectRevision,
								tableIndex,
								columnOffset,
							});
							break catalogPage;
						}
						if (columns.length === 0)
							throw new LookupError(
								"invalid_input",
								"One lookup column cannot fit safely in a tool result.",
							);
						break;
					}
					columns.push(projected);
				}
				const columnsComplete =
					columnOffset + columns.length >= table.columns.length;
				tables.push({
					...base,
					...(columnOffset === 0 ? {} : { columnOffset }),
					columnsComplete,
					columns,
				});
				if (!columnsComplete) {
					nextCursor = encodeCursor({
						v: 1,
						projectId: catalog.projectId,
						projectRevision: catalog.projectRevision,
						tableIndex,
						columnOffset: columnOffset + columns.length,
					});
					break;
				}
				tableIndex++;
				columnOffset = 0;
				if (
					tableIndex < catalog.definitions.length &&
					jsonBytes({
						projectRevision: catalog.projectRevision,
						complete: false,
						tables,
					}) >
						LOOKUP_CATALOG_PAGE_MAX_BYTES - 2_000
				) {
					nextCursor = encodeCursor({
						v: 1,
						projectId: catalog.projectId,
						projectRevision: catalog.projectRevision,
						tableIndex,
						columnOffset: 0,
					});
					break;
				}
			}
			return {
				kind: "read",
				data: {
					projectRevision: catalog.projectRevision,
					tables,
					complete: nextCursor === undefined,
					...(nextCursor === undefined ? {} : { nextCursor }),
				},
			};
		} catch (error) {
			if (error instanceof LookupError)
				return {
					kind: "read",
					data: { error: error.message, code: error.code },
				};
			throw error;
		}
	},
};
