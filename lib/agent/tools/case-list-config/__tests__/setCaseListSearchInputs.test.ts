/**
 * Behavioral tests for `setCaseListSearchInputs`.
 *
 * Drives the tool through `GenerationContext`. Six contract checks:
 *
 *   1. Effect on the doc — the supplied search inputs land on the
 *      module's `caseListConfig.searchInputs` slot.
 *   2. Empty array clears the search inputs.
 *   3. Idempotency — two identical calls produce equivalent state.
 *   4. Round-trip — required-only and full-optional shapes survive
 *      without corruption.
 *   5. Module-not-found.
 *   6. Cross-surface parity — chat + MCP contexts produce
 *      structurally identical mutation batches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	exactMode,
	rangeMode,
	type SearchInputDef,
	searchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	literal,
	matchAll,
	relationStep,
	term,
	today,
} from "@/lib/domain/predicate";
import { setCaseListSearchInputsTool } from "../setCaseListSearchInputs";
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

describe("setCaseListSearchInputs", () => {
	it("replaces the search input array wholesale on the module", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const searchInputs: SearchInputDef[] = [
			searchInputDef("name_search", "Name", "text", {
				property: "case_name",
			}),
		];

		const result = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs },
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.searchInputs).toEqual(searchInputs);
	});

	it("preserves columns / sort / filter / calculated when replacing searchInputs", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [
							{ kind: "plain" as const, field: "case_name", header: "Patient" },
						],
						sort: [
							{
								source: { kind: "property" as const, property: "case_name" },
								type: "plain" as const,
								direction: "asc" as const,
							},
						],
						filter: { kind: "match-all" as const },
						calculatedColumns: [
							{
								id: "today_col",
								header: "Today",
								expression: { kind: "today" as const },
							},
						],
						searchInputs: [
							{
								name: "old_search",
								label: "Old",
								type: "text" as const,
							},
						],
					},
				},
			},
		};

		const newSearchInputs = [
			searchInputDef("name_search", "Name", "text", { property: "case_name" }),
		];
		const result = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs: newSearchInputs },
			ctx,
			seededDoc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.searchInputs).toEqual(newSearchInputs);
		expect(finalConfig?.columns).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.columns,
		);
		expect(finalConfig?.sort).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.sort,
		);
		expect(finalConfig?.filter).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.filter,
		);
		expect(finalConfig?.calculatedColumns).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.calculatedColumns,
		);
	});

	it("clears search inputs with an empty array", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							{
								name: "old_search",
								label: "Old",
								type: "text" as const,
							},
						],
					},
				},
			},
		};

		const result = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs: [] },
			ctx,
			seededDoc,
		);

		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs).toEqual(
			[],
		);
	});

	it("is idempotent — two identical calls produce equivalent state", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const searchInputs = [
			searchInputDef("name_search", "Name", "text", { property: "case_name" }),
		];

		const r1 = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs },
			ctx,
			doc,
		);
		const r2 = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs },
			ctx,
			r1.newDoc,
		);

		expect(r2.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs).toEqual(
			r1.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs,
		);
	});

	it("round-trips required-only and full-optional shapes", async () => {
		// Two inputs: one with only the required slots (`name`,
		// `label`, `type`); one with every optional slot supplied
		// (property, via, mode, default, xpath). Tests that the
		// recursive AST cycles (RelationPath, SearchInputMode,
		// ValueExpression, Predicate) all survive without corruption.
		const { doc, ctx } = makeCaseListFixture();
		const searchInputs: SearchInputDef[] = [
			searchInputDef("simple_search", "Simple", "text"),
			searchInputDef("complex_search", "Complex", "select", {
				property: "region",
				via: ancestorPath(relationStep("parent", "household")),
				mode: exactMode(),
				default: term(literal("north")),
				xpath: matchAll(),
			}),
			searchInputDef("date_range", "Date Range", "date-range", {
				property: "visit_date",
				mode: rangeMode(),
				default: today(),
			}),
		];

		// First: the input itself must be a structurally valid
		// SearchInputDef array — the tool's input schema is the gate
		// the SA's structured-output goes through, so any drift here
		// is a wire-format bug at the agent boundary regardless of
		// what the reducer accepts.
		const parseResult = setCaseListSearchInputsTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputs,
		});
		expect(parseResult.success).toBe(true);

		const result = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs },
			ctx,
			doc,
		);

		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs).toEqual(
			searchInputs,
		);
	});

	it("returns an error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 99, searchInputs: [] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({ error: "Module 99 not found" });
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeCaseListFixture();
		const { ctx: mcpCtx } = makeCaseListMcpFixture();
		const searchInputs = [
			searchInputDef("name_search", "Name", "text", { property: "case_name" }),
		];

		const r1 = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs },
			chatCtx,
			doc,
		);
		const r2 = await setCaseListSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputs },
			mcpCtx,
			doc,
		);

		expect(r1.mutations).toEqual(r2.mutations);
	});
});
