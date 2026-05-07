/**
 * Behavioral tests for `setCaseListSort`.
 *
 * Drives the tool through `GenerationContext` and `McpContext`.
 * Four contract checks:
 *
 *   1. Effect on the doc — the supplied SortKey array lands on the
 *      module's `caseListConfig.sort` slot wholesale.
 *   2. Empty array clears the sort.
 *   3. Idempotency — two consecutive identical calls produce the
 *      same final state.
 *   4. Round-trip — both property-source and calculated-source sort
 *      keys survive without corruption.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BlueprintDoc,
	calculatedSortSource,
	type Module,
	plainColumn,
	propertySortSource,
	type SortKey,
	sortKey,
} from "@/lib/domain";
import { setCaseListSortTool } from "../setCaseListSort";
import { MOD_A, makeCaseListFixture, makeCaseListMcpFixture } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("setCaseListSort", () => {
	it("replaces the sort key list wholesale on the module", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const sort: SortKey[] = [
			sortKey(propertySortSource("case_name"), "plain", "asc"),
		];

		const result = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort },
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.sort).toEqual(sort);
	});

	it("preserves columns / filter / calculated / search when replacing sort", async () => {
		// Seed every other slot — the tool must touch only `sort`.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [plainColumn("case_name", "Patient")],
						sort: [sortKey(propertySortSource("dob"), "date", "desc")],
						filter: { kind: "match-all" } as const,
						calculatedColumns: [
							{
								id: "today_col",
								header: "Today",
								expression: { kind: "today" } as const,
							},
						],
						searchInputs: [
							{
								name: "search_name",
								label: "Name",
								type: "text" as const,
								property: "case_name",
							},
						],
					},
				},
			},
		};

		const newSort = [sortKey(propertySortSource("case_name"), "plain", "asc")];
		const result = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort: newSort },
			ctx,
			seededDoc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.sort).toEqual(newSort);
		expect(finalConfig?.columns).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.columns,
		);
		expect(finalConfig?.filter).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.filter,
		);
		expect(finalConfig?.calculatedColumns).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.calculatedColumns,
		);
		expect(finalConfig?.searchInputs).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.searchInputs,
		);
	});

	it("clears the sort with an empty array", async () => {
		// Seed an existing sort, then clear via empty array.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [],
						sort: [sortKey(propertySortSource("case_name"), "plain", "asc")],
						calculatedColumns: [],
						searchInputs: [],
					},
				},
			},
		};

		const result = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort: [] },
			ctx,
			seededDoc,
		);

		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.sort).toEqual([]);
	});

	it("is idempotent — two identical calls produce the same final state", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const sort = [sortKey(propertySortSource("case_name"), "plain", "asc")];

		const r1 = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort },
			ctx,
			doc,
		);
		const r2 = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort },
			ctx,
			r1.newDoc,
		);

		expect(r2.newDoc.modules[MOD_A]?.caseListConfig?.sort).toEqual(
			r1.newDoc.modules[MOD_A]?.caseListConfig?.sort,
		);
	});

	it("round-trips both property-source and calculated-source sort keys", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const sort: SortKey[] = [
			sortKey(propertySortSource("case_name"), "plain", "asc"),
			sortKey(calculatedSortSource("days_since"), "integer", "desc"),
		];

		// Input must satisfy the tool's schema before the reducer
		// accepts it — the schema is the SA-boundary contract.
		const parseResult = setCaseListSortTool.inputSchema.safeParse({
			moduleIndex: 0,
			sort,
		});
		expect(parseResult.success).toBe(true);

		const result = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort },
			ctx,
			doc,
		);

		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.sort).toEqual(sort);
	});

	it("returns an error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await setCaseListSortTool.execute(
			{ moduleIndex: 99, sort: [] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({ error: "Module 99 not found" });
	});

	it("initializes the caseListConfig when the module has none", async () => {
		// Module without an existing config — the tool must produce a
		// fully-populated config with the new sort + empty arrays for
		// the unset slots, rather than write `caseListConfig: { sort }`
		// and leave the schema-required arrays absent.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseListConfig: undefined } as Module,
			},
		};

		const sort: SortKey[] = [
			sortKey(propertySortSource("case_name"), "plain", "asc"),
		];
		const result = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort },
			ctx,
			docWithoutConfig,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig).toBeDefined();
		expect(finalConfig?.sort).toEqual(sort);
		expect(finalConfig?.columns).toEqual([]);
		expect(finalConfig?.calculatedColumns).toEqual([]);
		expect(finalConfig?.searchInputs).toEqual([]);
		// `filter` + `detailColumns` stay absent — schema-default for
		// the no-filter / mirror-short-detail cases.
		expect(finalConfig?.filter).toBeUndefined();
		expect(finalConfig?.detailColumns).toBeUndefined();
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		// Cross-surface parity sentinel — driving the same input
		// through both surfaces' `ToolExecutionContext` implementations
		// must produce structurally identical mutation batches. The
		// tool body is ctx-shape-agnostic by construction; this test
		// pins that contract so future ctx-aware logic added to the
		// tool surface gets caught.
		const { doc, ctx: chatCtx } = makeCaseListFixture();
		const { ctx: mcpCtx } = makeCaseListMcpFixture();
		const sort: SortKey[] = [
			sortKey(propertySortSource("case_name"), "plain", "asc"),
		];

		const r1 = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort },
			chatCtx,
			doc,
		);
		const r2 = await setCaseListSortTool.execute(
			{ moduleIndex: 0, sort },
			mcpCtx,
			doc,
		);

		expect(r1.mutations).toEqual(r2.mutations);
	});
});
