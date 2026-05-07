/**
 * Behavioral tests for `setCaseListFilter`.
 *
 * Drives the tool through `GenerationContext`. Five contract checks:
 *
 *   1. Effect on the doc — the supplied `Predicate` lands on the
 *      module's `caseListConfig.filter` slot.
 *   2. `null` clears the filter (key omitted on the persisted doc).
 *   3. Idempotency — two identical set-then-set calls produce
 *      equivalent final state.
 *   4. Round-trip — recursive predicate operators (and / or / not /
 *      between / exists) survive without corruption.
 *   5. Module-not-found — out-of-range index returns `{ error }`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintDoc, Module } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { and, eq, literal, matchAll, prop } from "@/lib/domain/predicate";
import { setCaseListFilterTool } from "../setCaseListFilter";
import { MOD_A, makeCaseListFixture } from "./fixtures";

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

describe("setCaseListFilter", () => {
	it("sets the case list filter to the supplied predicate", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const filter: Predicate = eq(prop("patient", "status"), literal("active"));

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toEqual(filter);
	});

	it("clears the filter when null is passed", async () => {
		// Seed a filter, then null-clear it.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [],
						sort: [],
						filter: matchAll(),
						calculatedColumns: [],
						searchInputs: [],
					},
				},
			},
		};

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter: null },
			ctx,
			seededDoc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toBeUndefined();
		// The schema treats absent as "no filter"; the persisted shape
		// must NOT carry an explicit `filter: undefined` key.
		expect(finalConfig && "filter" in finalConfig).toBe(false);
	});

	it("preserves columns / sort / calculated / search when setting filter", async () => {
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
						calculatedColumns: [
							{
								id: "today",
								header: "Today",
								expression: { kind: "today" as const },
							},
						],
						searchInputs: [
							{
								name: "name_search",
								label: "Name",
								type: "text" as const,
								property: "case_name",
							},
						],
					},
				},
			},
		};

		const filter = matchAll();
		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			seededDoc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toEqual(filter);
		expect(finalConfig?.columns).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.columns,
		);
		expect(finalConfig?.sort).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.sort,
		);
		expect(finalConfig?.calculatedColumns).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.calculatedColumns,
		);
		expect(finalConfig?.searchInputs).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.searchInputs,
		);
	});

	it("is idempotent — two identical calls produce equivalent final state", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const filter = eq(prop("patient", "status"), literal("active"));

		const r1 = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			doc,
		);
		const r2 = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			r1.newDoc,
		);

		expect(r2.newDoc.modules[MOD_A]?.caseListConfig?.filter).toEqual(
			r1.newDoc.modules[MOD_A]?.caseListConfig?.filter,
		);
	});

	it("round-trips a recursive predicate (and/eq/literal/prop)", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const filter = and(
			eq(prop("patient", "status"), literal("active")),
			eq(prop("patient", "region"), literal("north")),
		);

		// Input must satisfy the tool's schema before the reducer
		// accepts it — recursive predicate operators (and / eq /
		// nested-term-lift) need to round-trip through the SA-boundary
		// schema, not just through the reducer.
		const parseResult = setCaseListFilterTool.inputSchema.safeParse({
			moduleIndex: 0,
			filter,
		});
		expect(parseResult.success).toBe(true);

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			doc,
		);

		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.filter).toEqual(
			filter,
		);
	});

	it("returns an error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 99, filter: null },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({ error: "Module 99 not found" });
	});

	it("initializes the caseListConfig when the module has none", async () => {
		// Module without an existing config — the tool must produce a
		// fully-populated config with the new filter + empty arrays
		// for the unset slots, rather than write `caseListConfig:
		// { filter }` and leave the schema-required arrays absent.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseListConfig: undefined } as Module,
			},
		};

		const filter: Predicate = eq(prop("patient", "status"), literal("active"));
		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			docWithoutConfig,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig).toBeDefined();
		expect(finalConfig?.filter).toEqual(filter);
		expect(finalConfig?.columns).toEqual([]);
		expect(finalConfig?.sort).toEqual([]);
		expect(finalConfig?.calculatedColumns).toEqual([]);
		expect(finalConfig?.searchInputs).toEqual([]);
		// `detailColumns` stays absent — schema-default for the
		// mirror-short-detail case.
		expect(finalConfig?.detailColumns).toBeUndefined();
	});
});
