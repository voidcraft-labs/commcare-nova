/**
 * Behavioral tests for `setCaseListColumns`.
 *
 * Drives the tool through both `GenerationContext` and `McpContext`
 * so the typed Column AST round-trips identically across surfaces.
 * Three contract checks:
 *
 *   1. Effect on the doc — calling the tool plants the supplied
 *      columns on the module's `caseListConfig.columns` slot.
 *   2. Idempotency — two consecutive calls with the same input
 *      produce the same final state (the second call's mutation
 *      batch is structurally equivalent to the first's; both lead
 *      to the same `caseListConfig`).
 *   3. Round-trip — typed columns survive without corruption. Plain,
 *      date, phone, id-mapping, late-flag, time-since-until, and
 *      search-only kinds all survive.
 *   4. Module-not-found — out-of-range index returns `{ error }`
 *      with no mutations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type Column,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	lateFlagColumn,
	type Module,
	phoneColumn,
	plainColumn,
	searchOnlyColumn,
	timeSinceUntilColumn,
} from "@/lib/domain";
import { setCaseListColumnsTool } from "../setCaseListColumns";
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

describe("setCaseListColumns", () => {
	it("replaces the case list columns wholesale on the module", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const columns: Column[] = [
			plainColumn("case_name", "Patient"),
			phoneColumn("phone", "Phone"),
		];

		const result = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns },
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		expect(result.mutations).toHaveLength(1);
		const updateMut = result.mutations[0];
		if (updateMut?.kind !== "updateModule") {
			throw new Error(`expected updateModule mutation, got ${updateMut?.kind}`);
		}
		expect(updateMut.uuid).toBe(MOD_A);
		expect(updateMut.patch.caseListConfig?.columns).toEqual(columns);

		const finalMod = result.newDoc.modules[MOD_A];
		expect(finalMod?.caseListConfig?.columns).toEqual(columns);
	});

	it("preserves existing sort / filter / calculated / search slots when replacing columns", async () => {
		// Seed the module with a fully populated caseListConfig — the
		// tool must touch only the `columns` slot. The non-columns slots
		// must round-trip byte-identically through the patch.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const seededMod: Module = {
			...baseMod,
			caseListConfig: {
				columns: [plainColumn("old_col", "Old")],
				sort: [
					{
						source: { kind: "property", property: "case_name" },
						type: "plain",
						direction: "asc",
					},
				],
				filter: { kind: "match-all" },
				calculatedColumns: [
					{
						id: "today_col",
						header: "Today",
						expression: { kind: "today" },
					},
				],
				searchInputs: [
					{
						name: "search_name",
						label: "Name",
						type: "text",
						property: "case_name",
					},
				],
			},
		};
		const doc: BlueprintDoc = {
			...baseDoc,
			modules: { [MOD_A]: seededMod },
		};

		const newColumns = [plainColumn("case_name", "Patient Name")];
		const result = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns: newColumns },
			ctx,
			doc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.columns).toEqual(newColumns);
		expect(finalConfig?.sort).toEqual(seededMod.caseListConfig?.sort);
		expect(finalConfig?.filter).toEqual(seededMod.caseListConfig?.filter);
		expect(finalConfig?.calculatedColumns).toEqual(
			seededMod.caseListConfig?.calculatedColumns,
		);
		expect(finalConfig?.searchInputs).toEqual(
			seededMod.caseListConfig?.searchInputs,
		);
	});

	it("is idempotent — two identical calls produce equivalent final state", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const columns: Column[] = [plainColumn("case_name", "Patient")];

		const r1 = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns },
			ctx,
			doc,
		);
		const r2 = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns },
			ctx,
			r1.newDoc,
		);

		expect(r2.newDoc.modules[MOD_A]?.caseListConfig?.columns).toEqual(
			r1.newDoc.modules[MOD_A]?.caseListConfig?.columns,
		);
	});

	it("round-trips every Column kind without corruption", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const columns: Column[] = [
			plainColumn("case_name", "Patient"),
			dateColumn("dob", "DOB", "%Y-%m-%d"),
			phoneColumn("phone", "Phone"),
			idMappingColumn("region_code", "Region", [
				idMappingEntry("N", "North"),
				idMappingEntry("S", "South"),
			]),
			lateFlagColumn("last_visit", "Overdue", 30, "days", "Overdue"),
			timeSinceUntilColumn(
				"last_visit",
				"Days since visit",
				7,
				"days",
				"This week",
			),
			searchOnlyColumn("hidden_search", "Hidden"),
		];

		// The input must be a structurally valid Column[] under the
		// tool's input schema — the schema is the SA-boundary contract,
		// so any drift between the builders and the schema is a bug
		// at that boundary regardless of what the reducer accepts.
		const parseResult = setCaseListColumnsTool.inputSchema.safeParse({
			moduleIndex: 0,
			columns,
		});
		expect(parseResult.success).toBe(true);

		const result = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns },
			ctx,
			doc,
		);

		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.columns).toEqual(
			columns,
		);
	});

	it("returns an error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await setCaseListColumnsTool.execute(
			{ moduleIndex: 99, columns: [] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({ error: "Module 99 not found" });
	});

	it("initializes the caseListConfig when the module has none", async () => {
		// Module without an existing config — the tool must produce a
		// fully-populated config with the new columns + empty arrays
		// for the unset slots, rather than write `caseListConfig:
		// { columns }` and leave the schema-required arrays absent.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseListConfig: undefined } as Module,
			},
		};

		const columns = [plainColumn("case_name", "Patient")];
		const result = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns },
			ctx,
			docWithoutConfig,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig).toBeDefined();
		expect(finalConfig?.columns).toEqual(columns);
		expect(finalConfig?.sort).toEqual([]);
		expect(finalConfig?.calculatedColumns).toEqual([]);
		expect(finalConfig?.searchInputs).toEqual([]);
		// `filter` + `detailColumns` stay absent — schema-default for
		// the no-filter / mirror-short-detail cases.
		expect(finalConfig?.filter).toBeUndefined();
		expect(finalConfig?.detailColumns).toBeUndefined();
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		// Cross-surface parity — driving the same input through both
		// surfaces' `ToolExecutionContext` implementations should
		// produce structurally identical mutation batches.
		const { doc, ctx: chatCtx } = makeCaseListFixture();
		const { ctx: mcpCtx } = makeCaseListMcpFixture();
		const columns: Column[] = [plainColumn("case_name", "Patient")];

		const r1 = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns },
			chatCtx,
			doc,
		);
		const r2 = await setCaseListColumnsTool.execute(
			{ moduleIndex: 0, columns },
			mcpCtx,
			doc,
		);

		const stripStage = (muts: Mutation[]) => muts.map((m) => ({ ...m }));
		expect(stripStage(r1.mutations)).toEqual(stripStage(r2.mutations));
	});
});
