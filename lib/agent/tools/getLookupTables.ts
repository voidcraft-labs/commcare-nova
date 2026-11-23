import { z } from "zod";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { readAuthorizedLookupCatalog } from "@/lib/lookup/agentService";
import { LookupError } from "@/lib/lookup/errors";
import { requiresLookupProjection } from "@/lib/lookup/source";
import type {
	LookupColumn,
	LookupDataType,
	LookupHqOrigin,
	LookupMember,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import type { ToolInvocationContext } from "../workspace/types";
import type { ReadToolResult } from "./common";
import { lookupAgentScope } from "./shared/lookupScope";

/** Leaves ample room for the shared MCP result envelope below its 100k cap. */
export const LOOKUP_CATALOG_PAGE_MAX_BYTES = 70_000;
const LOOKUP_CATALOG_CURSOR_RESERVE_BYTES = 1_000;
const catalogCursorSchema = z.strictObject({
	v: z.literal(1),
	projectId: z.string().min(1),
	projectRevision: z.string(),
	tableIndex: z.number().int().nonnegative(),
	columnOffset: z.number().int().nonnegative(),
	detailOffset: z.number().int().nonnegative().optional(),
});

export const getLookupTablesInputSchema = z.strictObject({
	cursor: z.string().min(1).max(4096).optional(),
});
export type GetLookupTablesInput = z.infer<typeof getLookupTablesInputSchema>;

interface CatalogColumn {
	readonly id: LookupColumnId;
	readonly wireName: string;
	readonly label: string;
	readonly dataType: LookupDataType;
	readonly repeated?: true;
	readonly index?: LookupColumn["index"];
}
interface CatalogTableSegment {
	readonly id: LookupTableId;
	readonly name: string;
	readonly tag: string;
	readonly columnCount: number;
	readonly rowCount?: number;
	readonly dataBytes?: number;
	readonly rowsRequireSourceAccess?: true;
	readonly definitionRevision: string;
	readonly rowsRevision: string;
	readonly tableRevision: string;
	/** Present while CommCare HQ manages the table: Nova holds a copy, and
	 * every change to it is refused. */
	readonly managed_in_commcare_hq?: ManagedInCommCareHq;
	readonly columnOffset?: number;
	readonly columnsComplete: boolean;
	/** Entries without a column ID describe the whole row. */
	readonly details?: readonly CatalogDetail[];
	readonly columns: readonly CatalogColumn[];
}
interface CatalogDetail extends LookupMember {
	readonly columnId?: LookupColumnId;
}
function* catalogDetails(
	table: LookupTableDefinition,
): Generator<CatalogDetail> {
	for (const member of table.attributes ?? []) yield member;
	for (const column of table.columns)
		for (const member of column.properties ?? [])
			yield { ...member, columnId: column.id };
}
interface ManagedInCommCareHq {
	/** The project space that manages the table. */
	readonly project_space: string;
	readonly inventory?: "complete" | "unavailable";
	readonly distribution?: "global" | "assigned";
	/** When Nova's copy was last refreshed from it. */
	readonly refreshed_at: string;
}
export type GetLookupTablesResult =
	| {
			readonly projectRevision: string;
			readonly tables: readonly CatalogTableSegment[];
			readonly complete: boolean;
			readonly nextCursor?: string;
	  }
	| { readonly error: string; readonly code?: string };

async function readCatalog(ctx: ToolInvocationContext) {
	if (
		ctx.appId !== null ||
		ctx.authoringSessionId !== undefined ||
		ctx.ordinaryAuthoring !== undefined
	) {
		return readAuthorizedLookupCatalog(lookupAgentScope(ctx));
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
/** The managed fact a result carries: present only while CommCare HQ
 * manages the table, never for a table handed to Nova. */
function managedInCommCareHq(hq: LookupHqOrigin | undefined): {
	readonly managed_in_commcare_hq?: ManagedInCommCareHq;
} {
	if (hq?.managedBy !== "commcare-hq") return {};
	return {
		managed_in_commcare_hq: {
			project_space: hq.domain,
			refreshed_at: hq.refreshedAt,
			...(hq.source && {
				inventory: hq.source.inventory,
				distribution: hq.source.distribution,
			}),
		},
	};
}
function projectColumn(column: CatalogColumn): CatalogColumn {
	return {
		id: column.id,
		wireName: column.wireName,
		label: column.label,
		dataType: column.dataType,
		...(column.repeated && { repeated: true }),
		...(column.index && { index: column.index }),
	};
}

/** Rows-free Project data catalog. A large catalog continues by table/column
 * segment without ever crossing the model-facing result ceiling. */
export const getLookupTablesTool = {
	description:
		"Read the Project’s table names, IDs, details and revisions. Continue with nextCursor until complete. Tables managed in CommCare HQ are read-only here. When rowsRequireSourceAccess is true, a connected Project editor can inspect the source inventory in Project data. Each worker sees their own verified data.",
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
			let detailOffset = cursor?.detailOffset ?? 0;
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
				if (
					columnOffset > table.columns.length ||
					(detailOffset > 0 && columnOffset !== table.columns.length)
				) {
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
					...(requiresLookupProjection(table.hq)
						? { rowsRequireSourceAccess: true as const }
						: {
								rowCount: table.rowCount ?? 0,
								dataBytes: table.dataBytes ?? 0,
							}),
					definitionRevision: table.definitionRevision,
					rowsRevision: table.rowsRevision ?? table.definitionRevision,
					tableRevision: table.tableRevision ?? table.definitionRevision,
					...managedInCommCareHq(table.hq),
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
				const segment: CatalogTableSegment = {
					...base,
					...(columnOffset === 0 ? {} : { columnOffset }),
					columnsComplete,
					columns,
				};
				const details: CatalogDetail[] = [];
				if (columnsComplete) {
					let seen = 0;
					for (const detail of catalogDetails(table)) {
						if (seen++ < detailOffset) continue;
						if (
							jsonBytes({
								tables: [
									...tables,
									{ ...segment, details: [...details, detail] },
								],
							}) >
							LOOKUP_CATALOG_PAGE_MAX_BYTES -
								LOOKUP_CATALOG_CURSOR_RESERVE_BYTES
						) {
							if (columns.length || details.length)
								tables.push({ ...segment, ...(details.length && { details }) });
							nextCursor = encodeCursor({
								v: 1,
								projectId: catalog.projectId,
								projectRevision: catalog.projectRevision,
								tableIndex,
								columnOffset: table.columns.length,
								detailOffset: seen - 1,
							});
							break catalogPage;
						}
						details.push(detail);
					}
					if (detailOffset > seen)
						throw new LookupError(
							"invalid_input",
							"The catalog cursor is outside this table's details. Start again without a cursor.",
						);
				}
				tables.push({ ...segment, ...(details.length > 0 && { details }) });
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
				detailOffset = 0;
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
