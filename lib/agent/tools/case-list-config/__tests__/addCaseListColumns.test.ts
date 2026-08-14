/**
 * Behavioral tests for `addCaseListColumns` (the plural, list-taking tool —
 * there is no singular column-add tool; one column is a length-1 array).
 *
 * Coverage:
 *
 *   1. Effect on the doc — calling the tool appends the supplied
 *      columns to `caseListConfig.columns` (in order) and mints a fresh
 *      uuid per column.
 *   2. A multi-column call lands all columns in one mutation batch.
 *   3. Surrounding slots survive — `filter` and `searchInputs`
 *      round-trip byte-identically through the patch.
 *   4. Returned uuids are structured AND in the message string so the
 *      SA can target follow-up edits without re-reading.
 *   5. Round-trips every column kind without corruption.
 *   6. Module-not-found surfaces an Elm-style error.
 *   7. Cross-surface parity — chat + MCP contexts produce
 *      structurally identical mutation batches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll, today } from "@/lib/domain/predicate";
import { addCaseListColumnsTool } from "../addCaseListColumns";
import {
	MOD_A,
	makeCaseListDoc,
	makeCaseListFixture,
	makeCaseListMcpFixture,
} from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(async (args) => {
		const { commitApplyBlueprintChangeTestBatch } = await import(
			"@/lib/db/__tests__/applyBlueprintChangeTestWriter"
		);
		return commitApplyBlueprintChangeTestBatch(args);
	}),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("addCaseListColumns", () => {
	it("appends a single column with a freshly minted uuid", async () => {
		const h = makeCaseListFixture();

		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});

		expect(result.kind).toBe("mutate");
		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toHaveLength(2);
		const col = final?.columns.at(-1);
		expect(col?.kind).toBe("plain");
		expect(col?.uuid).toBeTruthy();
		if (col?.kind === "plain") {
			expect(col.field).toBe("case_name");
			expect(col.header).toBe("Patient");
		}
	});

	it("adds multiple columns in one call, in order, in a single mutation", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [
				{ kind: "plain", field: "case_name", header: "Name" },
				{ kind: "phone", field: "phone", header: "Phone" },
				{ kind: "date", field: "dob", header: "DOB", pattern: "%Y-%m-%d" },
			],
		});

		// One granular `addColumn` per column now (keyed by uuid + an append
		// `order`), not a single wholesale `updateModule{caseListConfig}`.
		expect(result.mutations).toHaveLength(3);
		expect(result.mutations.every((m) => m.kind === "addColumn")).toBe(true);
		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.columns.map((c) => c.kind)).toEqual([
			"plain",
			"plain",
			"phone",
			"date",
		]);
		if ("error" in result.result) throw new Error(result.result.error);
		// One uuid per column, aligned with input order + the stored columns.
		expect(result.result.uuids).toEqual(
			final?.columns.slice(-3).map((c) => c.uuid),
		);
	});

	it("surfaces each new uuid in the structured result and the message", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		const newColumn = h
			.currentDoc()
			.modules[MOD_A]?.caseListConfig?.columns.at(-1);
		expect(result.result.uuids[0]).toBe(newColumn?.uuid);
		expect(result.result.message).toContain("Patient");
	});

	it("preserves filter and searchInputs when adding columns", async () => {
		const baseDoc = makeCaseListDoc();
		const seededInput = simpleSearchInputDef(
			testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
			"name_search",
			"Name",
			"text",
			"case_name",
		);
		const seededFilter = matchAll();
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: baseDoc.modules[MOD_A].caseListConfig?.columns ?? [],
						searchInputs: [seededInput],
						filter: seededFilter,
					}),
				},
			},
		};

		const h = makeCaseListFixture(docWithConfig);
		await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});

		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.searchInputs).toEqual([seededInput]);
		expect(final?.filter).toEqual(seededFilter);
	});

	it("appends to an existing columns array without disturbing prior entries", async () => {
		const baseDoc = makeCaseListDoc();
		const existing = plainColumn(
			testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			"existing",
			"Existing",
		);
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: [existing],
						searchInputs: [],
					}),
				},
			},
		};

		const h = makeCaseListFixture(docWithConfig);
		await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "phone", field: "phone", header: "Phone" }],
		});

		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toHaveLength(2);
		expect(final?.columns[0]).toEqual(existing);
		expect(final?.columns[1]?.kind).toBe("phone");
	});

	it("appends after independently arranged Results and Details", async () => {
		const baseDoc = makeCaseListDoc();
		const first = {
			...plainColumn(
				testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
				"first",
				"First",
			),
		};
		const second = {
			...plainColumn(
				testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
				"second",
				"Second",
			),
		};
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: [first, second],
						// The two screens disagree; an append still lands at the end
						// of BOTH.
						listColumnOrder: [second.uuid, first.uuid],
						detailColumnOrder: [first.uuid, second.uuid],
						searchInputs: [],
					}),
				},
			},
		};

		const h = makeCaseListFixture(docWithConfig);
		await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "phone", field: "phone", header: "Phone" }],
		});
		const columns =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns ?? [];
		const added = columns.find(
			(column) => column.uuid !== first.uuid && column.uuid !== second.uuid,
		);

		const config = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(config?.listColumnOrder.at(-1)).toBe(added?.uuid);
		expect(config?.detailColumnOrder.at(-1)).toBe(added?.uuid);
	});

	it("round-trips every Column kind without corruption", async () => {
		const h = makeCaseListFixture();
		const columns = [
			{ kind: "plain" as const, field: "case_name", header: "Patient" },
			{
				kind: "date" as const,
				field: "dob",
				header: "DOB",
				pattern: "%Y-%m-%d",
			},
			{ kind: "phone" as const, field: "phone", header: "Phone" },
			{
				kind: "id-mapping" as const,
				field: "region_code",
				header: "Region",
				mapping: [
					{ value: "N", label: "North" },
					{ value: "S", label: "South" },
				],
			},
			{
				kind: "interval" as const,
				field: "last_visit",
				header: "Days since visit",
				threshold: 7,
				unit: "days" as const,
				display: "always" as const,
				text: "This week",
			},
			{
				kind: "calculated" as const,
				header: "Today",
				expression: today(),
			},
			{
				kind: "image-map" as const,
				field: "status",
				header: "Status",
				mapping: [
					{
						value: "open",
						assetId: testMediaAssetId("asset-active"),
					},
					{
						value: "closed",
						assetId: testMediaAssetId("asset-closed"),
					},
				],
			},
		];

		await h.runTool(addCaseListColumnsTool, { moduleUuid: MOD_A, columns });

		const finalCols =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(finalCols).toHaveLength(columns.length + 1);
		expect(finalCols.slice(-columns.length).map((c) => c.kind)).toEqual(
			columns.map((i) => i.kind),
		);
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: testUuid("unknown-module"),
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});

	it("authors a dormant definition identically through chat and MCP", async () => {
		// `crypto.randomUUID` produces a fresh value per call, so the
		// minted column uuids won't match across the two runs. Strip them
		// before comparing so the test pins the rest of the mutation shape.
		const chat = makeCaseListFixture();
		const mcp = makeCaseListMcpFixture();
		const input = {
			moduleUuid: MOD_A,
			columns: [
				{
					kind: "plain" as const,
					field: "case_name",
					header: "Patient",
					visibleInList: false,
					visibleInDetail: false,
				},
			],
		};

		const r1 = await chat.runTool(addCaseListColumnsTool, input);
		const r2 = await mcp.runTool(addCaseListColumnsTool, input);

		// The minted column uuid differs per run; the granular `order` key is
		// deterministic (same fixture). Strip the uuid before comparing.
		const stripUuid = (mutations: typeof r1.mutations) =>
			mutations.map((m) => {
				if (m.kind !== "addColumn") return m;
				const { uuid: _u, ...col } = m.column;
				return { ...m, column: col };
			});

		expect(stripUuid(r1.mutations)).toEqual(stripUuid(r2.mutations));
		expect(
			chat.currentDoc().modules[MOD_A]?.caseListConfig?.columns.at(-1),
		).toEqual(
			expect.objectContaining({
				visibleInList: false,
				visibleInDetail: false,
			}),
		);
		expect(
			mcp.currentDoc().modules[MOD_A]?.caseListConfig?.columns.at(-1),
		).toEqual(
			expect.objectContaining({
				visibleInList: false,
				visibleInDetail: false,
			}),
		);
	});
});
