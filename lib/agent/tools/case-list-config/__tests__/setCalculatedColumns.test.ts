/**
 * Behavioral tests for `setCalculatedColumns`.
 *
 * Drives the tool through `GenerationContext`. Five contract checks:
 *
 *   1. Effect on the doc — the supplied calculated columns land on
 *      the module's `caseListConfig.calculatedColumns` slot.
 *   2. Empty array clears the calculated columns.
 *   3. Idempotency — two identical calls produce equivalent state.
 *   4. Round-trip — both bare-expression columns and columns with
 *      per-column sort config survive without corruption.
 *   5. Module-not-found.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BlueprintDoc,
	type CalculatedColumn,
	calculatedColumn,
	type Module,
} from "@/lib/domain";
import { concat, literal, prop, term, today } from "@/lib/domain/predicate";
import { setCalculatedColumnsTool } from "../setCalculatedColumns";
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

describe("setCalculatedColumns", () => {
	it("replaces the calculated column array wholesale on the module", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const calculatedColumns: CalculatedColumn[] = [
			calculatedColumn("today_str", "Today", today()),
		];

		const result = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 0, calculatedColumns },
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.calculatedColumns).toEqual(calculatedColumns);
	});

	it("preserves columns / sort / filter / search when replacing calculatedColumns", async () => {
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
								id: "old_calc",
								header: "Old",
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

		const newCalc = [calculatedColumn("today_str", "Today", today())];
		const result = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 0, calculatedColumns: newCalc },
			ctx,
			seededDoc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.calculatedColumns).toEqual(newCalc);
		expect(finalConfig?.columns).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.columns,
		);
		expect(finalConfig?.sort).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.sort,
		);
		expect(finalConfig?.filter).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.filter,
		);
		expect(finalConfig?.searchInputs).toEqual(
			seededDoc.modules[MOD_A]?.caseListConfig?.searchInputs,
		);
	});

	it("clears calculated columns with an empty array", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [],
						sort: [],
						calculatedColumns: [
							{
								id: "old_calc",
								header: "Old",
								expression: { kind: "today" as const },
							},
						],
						searchInputs: [],
					},
				},
			},
		};

		const result = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 0, calculatedColumns: [] },
			ctx,
			seededDoc,
		);

		expect(
			result.newDoc.modules[MOD_A]?.caseListConfig?.calculatedColumns,
		).toEqual([]);
	});

	it("is idempotent — two identical calls produce equivalent state", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const calc = [calculatedColumn("today_str", "Today", today())];

		const r1 = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 0, calculatedColumns: calc },
			ctx,
			doc,
		);
		const r2 = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 0, calculatedColumns: calc },
			ctx,
			r1.newDoc,
		);

		expect(r2.newDoc.modules[MOD_A]?.caseListConfig?.calculatedColumns).toEqual(
			r1.newDoc.modules[MOD_A]?.caseListConfig?.calculatedColumns,
		);
	});

	it("round-trips bare and sort-bearing calculated columns", async () => {
		// Two columns: one with the optional `sort` slot present, one
		// without. The `calculatedColumn` builder omits the absent
		// `sort` slot from the output object so the round-trip
		// equality assertion stays tight.
		const { doc, ctx } = makeCaseListFixture();
		const calc: CalculatedColumn[] = [
			calculatedColumn("today_str", "Today", today()),
			calculatedColumn(
				"full_name",
				"Full Name",
				concat(
					term(prop("patient", "first_name")),
					term(literal(" ")),
					term(prop("patient", "last_name")),
				),
				{ type: "plain", direction: "asc" },
			),
		];

		// Input must satisfy the tool's schema before the reducer
		// accepts it — recursive ValueExpression cycles (concat / term
		// lift) need to round-trip through the SA-boundary schema.
		const parseResult = setCalculatedColumnsTool.inputSchema.safeParse({
			moduleIndex: 0,
			calculatedColumns: calc,
		});
		expect(parseResult.success).toBe(true);

		const result = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 0, calculatedColumns: calc },
			ctx,
			doc,
		);

		expect(
			result.newDoc.modules[MOD_A]?.caseListConfig?.calculatedColumns,
		).toEqual(calc);
	});

	it("returns an error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 99, calculatedColumns: [] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({ error: "Module 99 not found" });
	});

	it("initializes the caseListConfig when the module has none", async () => {
		// Module without an existing config — the tool must produce a
		// fully-populated config with the new calculated columns +
		// empty arrays for the unset slots, rather than write
		// `caseListConfig: { calculatedColumns }` and leave the
		// schema-required arrays absent.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseListConfig: undefined } as Module,
			},
		};

		const calc: CalculatedColumn[] = [
			calculatedColumn("today_str", "Today", today()),
		];
		const result = await setCalculatedColumnsTool.execute(
			{ moduleIndex: 0, calculatedColumns: calc },
			ctx,
			docWithoutConfig,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig).toBeDefined();
		expect(finalConfig?.calculatedColumns).toEqual(calc);
		expect(finalConfig?.columns).toEqual([]);
		expect(finalConfig?.sort).toEqual([]);
		expect(finalConfig?.searchInputs).toEqual([]);
		// `filter` + `detailColumns` stay absent — schema-default for
		// the no-filter / mirror-short-detail cases.
		expect(finalConfig?.filter).toBeUndefined();
		expect(finalConfig?.detailColumns).toBeUndefined();
	});
});
