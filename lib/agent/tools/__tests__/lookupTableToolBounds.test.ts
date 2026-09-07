/** Pagination and pre-service receipt budgets over schema-admitted lookup
 * definitions. The service is a controlled boundary; no SQL/tenancy claim. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { LookupError } from "@/lib/lookup/errors";
import {
	createLookupTableInputSchema,
	lookupRevisionSchema,
} from "@/lib/lookup/schema";
import type {
	LookupAuthoringBatchReceipt,
	LookupDefinitionsSnapshot,
} from "@/lib/lookup/types";
import { surveyFixture } from "../../__tests__/admittedFixture";
import type { ToolInvocationContext } from "../../workspace/types";

const mocks = vi.hoisted(() => ({
	readCatalog: vi.fn(),
	applyBatch: vi.fn(),
}));

vi.mock("@/lib/lookup/agentService", () => ({
	readAuthorizedLookupCatalog: mocks.readCatalog,
	readAuthorizedLookupRowsPage: vi.fn(),
	applyAuthorizedLookupAuthoringBatch: mocks.applyBatch,
}));

import {
	getLookupTablesTool,
	LOOKUP_CATALOG_PAGE_MAX_BYTES,
} from "../getLookupTables";
import {
	createLookupTableTool,
	editLookupColumnsTool,
	LOOKUP_TOOL_MAX_CREATED_IDENTITIES,
	LOOKUP_TOOL_RESULT_MAX_BYTES,
	removeLookupTableTool,
} from "../lookupTables";

const TABLE_ID = lookupTableIdSchema.parse(
	"01890f45-0000-7000-8000-000000000001",
);
const REVISION = lookupRevisionSchema.parse("7");
function rawId(index: number): string {
	return `01890f45-0000-7000-8000-${index.toString().padStart(12, "0")}`;
}
function columnId(index: number) {
	return lookupColumnIdSchema.parse(rawId(index));
}
function rowId(index: number) {
	return lookupRowIdSchema.parse(rawId(index));
}
const context: ToolInvocationContext = {
	appId: "app-1",
	projectId: "project-1",
	userId: "user-1",
	runId: "run-1",
	snapshot: {
		doc: surveyFixture(),
		revision: 0,
		canonicalSeq: null,
		projectId: "project-1",
	},
	invocation: {
		requestId: "lookup-projection",
		invocationOrdinal: 0,
		toolName: "lookup-projection",
	},
	async conversionImpact() {
		throw new Error("projection must not read case rows");
	},
	async applyBatch() {
		throw new Error("projection must not mutate Blueprint");
	},
	async applyStages() {
		throw new Error("projection must not mutate Blueprint");
	},
	adoptAuthoritativeSnapshot() {
		throw new Error("projection must not adopt Blueprint");
	},
};

function admitCatalog(
	catalog: LookupDefinitionsSnapshot,
): LookupDefinitionsSnapshot {
	for (const table of catalog.definitions) {
		createLookupTableInputSchema.parse({
			name: table.name,
			tag: table.tag,
			columns: table.columns.map(({ id: _id, ...column }) => column),
		});
	}
	return catalog;
}
async function readAllSegments() {
	const segments: Extract<
		Awaited<ReturnType<typeof getLookupTablesTool.execute>>["data"],
		{ tables: unknown }
	>["tables"][number][] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 100; page++) {
		const result = await getLookupTablesTool.execute(
			getLookupTablesTool.inputSchema.parse(cursor ? { cursor } : {}),
			context,
		);
		if ("error" in result.data) throw new Error(result.data.error);
		expect(
			Buffer.byteLength(JSON.stringify(result.data), "utf8"),
		).toBeLessThanOrEqual(LOOKUP_CATALOG_PAGE_MAX_BYTES);
		segments.push(...result.data.tables);
		if (result.data.complete) {
			expect(result.data.nextCursor).toBeUndefined();
			return { segments, pages: page + 1 };
		}
		cursor = result.data.nextCursor;
		if (!cursor) throw new Error("incomplete page omitted continuation");
		expect(cursors.has(cursor)).toBe(false);
		cursors.add(cursor);
	}
	throw new Error("catalog pagination did not terminate");
}
function hugeCatalog(
	projectId: string,
	revision = "7",
): LookupDefinitionsSnapshot {
	const projectRevision = lookupRevisionSchema.parse(revision);
	return admitCatalog({
		projectId,
		projectRevision,
		definitions: [
			{
				id: TABLE_ID,
				name: "Large",
				tag: "large",
				definitionRevision: projectRevision,
				rowsRevision: projectRevision,
				tableRevision: projectRevision,
				columnCount: 250,
				rowCount: 0,
				dataBytes: 0,
				columns: Array.from({ length: 250 }, (_, index) => ({
					id: columnId(index + 1),
					wireName: `column_${index}_${"w".repeat(220)}`,
					label: `Column ${index} ${"l".repeat(100)}`,
					dataType: "text" as const,
				})),
			},
		],
	});
}

describe("lookup shared-tool output bounds", () => {
	beforeEach(() => vi.clearAllMocks());

	it("continues a huge catalog below the model-facing byte budget", async () => {
		mocks.readCatalog.mockResolvedValue(hugeCatalog("project-1"));

		const { segments, pages } = await readAllSegments();
		expect(pages).toBeGreaterThan(1);
		expect(
			segments.flatMap((segment) => segment.columns.map((column) => column.id)),
		).toEqual(
			hugeCatalog("project-1").definitions[0].columns.map(
				(column) => column.id,
			),
		);
		let offset = 0;
		for (const segment of segments) {
			expect(segment.columnOffset ?? 0).toBe(offset);
			offset += segment.columns.length;
			expect(segment.columnsComplete).toBe(offset === 250);
		}
	});

	it("rejects a catalog cursor reused by another Project at the same revision", async () => {
		mocks.readCatalog
			.mockResolvedValueOnce(hugeCatalog("project-1"))
			.mockResolvedValueOnce(hugeCatalog("project-2"));
		const first = await getLookupTablesTool.execute({}, context);
		if ("error" in first.data || first.data.nextCursor === undefined) {
			throw new Error("Expected the first Project catalog to continue.");
		}

		const second = await getLookupTablesTool.execute(
			{ cursor: first.data.nextCursor },
			{
				...context,
				appId: "app-2",
				projectId: "project-2",
			},
		);
		expect(second.data).toMatchObject({
			code: "invalid_input",
			error: expect.stringContaining("different Project"),
		});
	});

	it("continues a catalog with a huge table count below the byte budget", async () => {
		const catalog = admitCatalog({
			projectId: "project-1",
			projectRevision: lookupRevisionSchema.parse("11"),
			definitions: Array.from({ length: 1_000 }, (_, index) => ({
				id: lookupTableIdSchema.parse(rawId(index + 1)),
				name: `Table ${index} ${"n".repeat(80)}`,
				tag: `table_${index}`,
				definitionRevision: lookupRevisionSchema.parse("11"),
				rowsRevision: lookupRevisionSchema.parse("11"),
				tableRevision: lookupRevisionSchema.parse("11"),
				columnCount: 1,
				rowCount: 0,
				dataBytes: 0,
				columns: [
					{
						id: columnId(index + 1_001),
						wireName: "value",
						label: "Value",
						dataType: "text",
					},
				],
			})),
		});

		mocks.readCatalog.mockResolvedValue(catalog);
		const { segments, pages } = await readAllSegments();
		expect(pages).toBeGreaterThan(1);
		expect(segments.map((segment) => segment.id)).toEqual(
			catalog.definitions.map((table) => table.id),
		);
		expect(
			segments.flatMap((segment) => segment.columns.map((column) => column.id)),
		).toEqual(
			catalog.definitions.flatMap((table) =>
				table.columns.map((column) => column.id),
			),
		);
	});

	it("lets a materialization-root executor read the Project catalog before app birth", async () => {
		const lookupCatalog = vi.fn(async () => ({
			projectId: "project-1",
			projectRevision: REVISION,
			definitions: [],
		}));
		const result = await getLookupTablesTool.execute(
			{},
			{
				...context,
				appId: null,
				lookupCatalog,
			},
		);

		expect(result).toEqual({
			kind: "read",
			data: { projectRevision: REVISION, tables: [], complete: true },
		});
		expect(lookupCatalog).toHaveBeenCalledOnce();
		expect(mocks.readCatalog).not.toHaveBeenCalled();
	});

	it("refuses an identity receipt that cannot fit before writing", async () => {
		const result = await createLookupTableTool.execute(
			createLookupTableTool.inputSchema.parse({
				name: "Too large",
				tag: "too_large",
				columns: [
					{ key: "value", wireName: "value", label: "Value", dataType: "text" },
				],
				rows: Array.from(
					{ length: LOOKUP_TOOL_MAX_CREATED_IDENTITIES },
					() => ({ cells: [] }),
				),
			}),
			context,
		);
		expect(result.data).toMatchObject({ code: "invalid_input" });
		expect(mocks.applyBatch).not.toHaveBeenCalled();
	});

	it("returns every identity at the accepted creation limit", async () => {
		const count = LOOKUP_TOOL_MAX_CREATED_IDENTITIES - 2;
		const input = createLookupTableTool.inputSchema.parse({
			name: "At limit",
			tag: "at_limit",
			columns: [
				{ key: "value", wireName: "value", label: "Value", dataType: "text" },
			],
			rows: Array.from({ length: count }, () => ({ cells: [] })),
		});
		const rows = Array.from({ length: count }, (_, index) => ({
			key: `row-${index}`,
			id: rowId(index + 1000),
		}));
		mocks.applyBatch.mockResolvedValueOnce({
			projectRevision: REVISION,
			tables: [
				{
					tableId: TABLE_ID,
					deleted: false,
					columnIds: [{ key: "value", id: columnId(1) }],
					rowIds: rows,
					revisions: {
						definitionRevision: REVISION,
						rowsRevision: REVISION,
						tableRevision: REVISION,
					},
				},
			],
		} satisfies LookupAuthoringBatchReceipt);
		const result = await createLookupTableTool.execute(input, context);
		expect(result.data).toMatchObject({
			tableId: TABLE_ID,
			columns: [{ key: "value", columnId: columnId(1) }],
			rows: rows.map(({ id }, index) => ({ index, rowId: id })),
		});
		expect(
			Buffer.byteLength(JSON.stringify(result), "utf8"),
		).toBeLessThanOrEqual(LOOKUP_TOOL_RESULT_MAX_BYTES);
		expect(mocks.applyBatch).toHaveBeenCalledOnce();
	});

	it("byte-bounds receipts with long request-local keys before writing", async () => {
		const result = await createLookupTableTool.execute(
			createLookupTableTool.inputSchema.parse({
				name: "Long keys",
				tag: "long_keys",
				columns: Array.from({ length: 250 }, (_, index) => ({
					key: `k${index}${"😀".repeat(90)}`,
					wireName: `column_${index}`,
					label: `Column ${index}`,
					dataType: "text" as const,
				})),
				rows: [],
			}),
			context,
		);
		expect(result.data).toMatchObject({ code: "invalid_input" });
		expect(JSON.stringify(result.data)).toContain(
			`${LOOKUP_TOOL_RESULT_MAX_BYTES}-byte`,
		);
		expect(mocks.applyBatch).not.toHaveBeenCalled();
	});

	it("preserves bounded destructive blocker identities", async () => {
		mocks.applyBatch.mockRejectedValueOnce(
			new LookupError("referenced", "Still referenced.", {
				blockingApps: [
					{ appId: "app-2", appName: "Clinic intake", deleted: true },
				],
			}),
		);
		const blockedDelete = await removeLookupTableTool.execute(
			removeLookupTableTool.inputSchema.parse({
				tableId: TABLE_ID,
				expectedTableRevision: REVISION,
			}),
			context,
		);
		expect(blockedDelete.data).toMatchObject({
			code: "referenced",
			blockingApps: [
				{ appId: "app-2", appName: "Clinic intake", deleted: true },
			],
		});

		mocks.applyBatch.mockRejectedValueOnce(
			new LookupError("incompatible_values", "Two rows are incompatible.", {
				incompatibleRowIds: [rowId(50), rowId(51)],
			}),
		);
		const blockedRetype = await editLookupColumnsTool.execute(
			editLookupColumnsTool.inputSchema.parse({
				tableId: TABLE_ID,
				expectedTableRevision: REVISION,
				operations: [
					{
						kind: "retype",
						columnId: columnId(2),
						dataType: "int",
					},
				],
			}),
			context,
		);
		expect(blockedRetype.data).toMatchObject({
			code: "incompatible_values",
			incompatibleRowIds: [rowId(50), rowId(51)],
		});
	});
});
