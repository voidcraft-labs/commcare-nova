import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { LookupError } from "@/lib/lookup/errors";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
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
const context = {
	appId: "app-1",
	projectId: "project-1",
	userId: "user-1",
	runId: "run-1",
} as ToolInvocationContext;

function hugeCatalog(projectId: string, projectRevision = "7") {
	return {
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
	};
}

describe("lookup shared-tool output bounds", () => {
	beforeEach(() => vi.clearAllMocks());

	it("continues a huge catalog below the model-facing byte budget", async () => {
		mocks.readCatalog.mockResolvedValue(hugeCatalog("project-1"));

		const first = await getLookupTablesTool.execute({}, context);
		expect("error" in first.data).toBe(false);
		if ("error" in first.data) return;
		expect(first.data.complete).toBe(false);
		expect(first.data.nextCursor).toBeTypeOf("string");
		expect(
			Buffer.byteLength(JSON.stringify(first.data), "utf8"),
		).toBeLessThanOrEqual(LOOKUP_CATALOG_PAGE_MAX_BYTES);
		const second = await getLookupTablesTool.execute(
			{ cursor: first.data.nextCursor },
			context,
		);
		expect("error" in second.data).toBe(false);
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
			} as ToolInvocationContext,
		);
		expect(second.data).toMatchObject({
			code: "invalid_input",
			error: expect.stringContaining("different Project"),
		});
	});

	it("continues a catalog with a huge table count below the byte budget", async () => {
		mocks.readCatalog.mockResolvedValue({
			projectId: "project-1",
			projectRevision: "11",
			definitions: Array.from({ length: 1_000 }, (_, index) => ({
				id: columnId(index + 1),
				name: `Table ${index} ${"n".repeat(80)}`,
				tag: `table_${index}_${"t".repeat(70)}`,
				definitionRevision: "11",
				rowsRevision: "11",
				tableRevision: "11",
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

		const first = await getLookupTablesTool.execute({}, context);
		expect("error" in first.data).toBe(false);
		if ("error" in first.data) return;
		expect(first.data.complete).toBe(false);
		expect(first.data.nextCursor).toBeTypeOf("string");
		expect(
			Buffer.byteLength(JSON.stringify(first.data), "utf8"),
		).toBeLessThanOrEqual(LOOKUP_CATALOG_PAGE_MAX_BYTES);
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
			{
				name: "Too large",
				tag: "too_large",
				columns: [
					{ key: "value", wireName: "value", label: "Value", dataType: "text" },
				],
				rows: Array.from(
					{ length: LOOKUP_TOOL_MAX_CREATED_IDENTITIES },
					() => ({ cells: [] }),
				),
			},
			context,
		);
		expect(result.data).toMatchObject({ code: "invalid_input" });
		expect(mocks.applyBatch).not.toHaveBeenCalled();
	});

	it("byte-bounds receipts with long request-local keys before writing", async () => {
		const result = await createLookupTableTool.execute(
			{
				name: "Long keys",
				tag: "long_keys",
				columns: Array.from({ length: 250 }, (_, index) => ({
					key: `k${index}${"😀".repeat(90)}`,
					wireName: `column_${index}`,
					label: `Column ${index}`,
					dataType: "text" as const,
				})),
				rows: [],
			},
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
			{ tableId: TABLE_ID, expectedTableRevision: REVISION },
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
			{
				tableId: TABLE_ID,
				expectedTableRevision: REVISION,
				operations: [
					{
						kind: "retype",
						columnId: columnId(2),
						dataType: "int",
					},
				],
			},
			context,
		);
		expect(blockedRetype.data).toMatchObject({
			code: "incompatible_values",
			incompatibleRowIds: [rowId(50), rowId(51)],
		});
	});
});
