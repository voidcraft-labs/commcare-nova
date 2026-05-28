/**
 * Behavioral tests for `addCaseListColumn`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — calling the tool appends the supplied
 *      column to `caseListConfig.columns` and mints a fresh uuid.
 *   2. Surrounding slots survive — `filter` and `searchInputs`
 *      round-trip byte-identically through the patch.
 *   3. Returned uuid is structured AND in the message string so the
 *      SA can target follow-up edits without re-reading.
 *   4. Round-trips every column kind without corruption.
 *   5. Module-not-found surfaces an Elm-style error.
 *   6. Cross-surface parity — chat + MCP contexts produce
 *      structurally identical mutation batches.
 *   7. Initializes the caseListConfig when the module has none.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
	type BlueprintDoc,
	type Module,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll, today } from "@/lib/domain/predicate";
import { addCaseListColumnTool } from "../addCaseListColumn";
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

describe("addCaseListColumn", () => {
	it("appends the column to caseListConfig.columns with a freshly minted uuid", async () => {
		const { doc, ctx } = makeCaseListFixture();

		const result = await addCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				column: { kind: "plain", field: "case_name", header: "Patient" },
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const final = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toHaveLength(1);
		const col = final?.columns[0];
		expect(col?.kind).toBe("plain");
		expect(col?.uuid).toBeTruthy();
		expect(col?.uuid.length).toBeGreaterThan(0);
		if (col?.kind === "plain") {
			expect(col.field).toBe("case_name");
			expect(col.header).toBe("Patient");
		}
	});

	it("surfaces the new uuid in the structured result and the message", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await addCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				column: { kind: "plain", field: "case_name", header: "Patient" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		const newColumn = result.newDoc.modules[MOD_A]?.caseListConfig?.columns[0];
		expect(result.result.uuid).toBe(newColumn?.uuid);
		expect(result.result.message).toContain(String(newColumn?.uuid));
	});

	it("preserves filter and searchInputs when adding a column", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededInput = simpleSearchInputDef(
			asUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
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
					caseListConfig: {
						columns: [],
						searchInputs: [seededInput],
						filter: seededFilter,
					},
				},
			},
		};

		const result = await addCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				column: { kind: "plain", field: "case_name", header: "Patient" },
			},
			ctx,
			docWithConfig,
		);

		const final = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(final?.searchInputs).toEqual([seededInput]);
		expect(final?.filter).toEqual(seededFilter);
	});

	it("appends to an existing columns array without disturbing prior entries", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const existing = plainColumn(
			asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			"existing",
			"Existing",
		);
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: { columns: [existing], searchInputs: [] },
				},
			},
		};

		const result = await addCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				column: { kind: "phone", field: "phone", header: "Phone" },
			},
			ctx,
			docWithConfig,
		);

		const final = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toHaveLength(2);
		expect(final?.columns[0]).toEqual(existing);
		expect(final?.columns[1]?.kind).toBe("phone");
	});

	it("round-trips every Column kind without corruption", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const inputs = [
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
					{ value: "active", assetId: "asset-active" },
					{ value: "closed", assetId: "asset-closed" },
				],
			},
		];

		let runningDoc = doc;
		for (const input of inputs) {
			const r = await addCaseListColumnTool.execute(
				{ moduleIndex: 0, column: input },
				ctx,
				runningDoc,
			);
			runningDoc = r.newDoc;
		}

		const finalCols = runningDoc.modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(finalCols).toHaveLength(inputs.length);
		expect(finalCols.map((c) => c.kind)).toEqual(inputs.map((i) => i.kind));
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await addCaseListColumnTool.execute(
			{
				moduleIndex: 99,
				column: { kind: "plain", field: "case_name", header: "Patient" },
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to add");
		expect(result.result.error).toContain("module index 99");
		expect(result.result.error).toContain("Found no module");
	});

	it("initializes the caseListConfig when the module has none", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseListConfig: undefined } as Module,
			},
		};

		const result = await addCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				column: { kind: "plain", field: "case_name", header: "Patient" },
			},
			ctx,
			docWithoutConfig,
		);

		const final = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toHaveLength(1);
		expect(final?.searchInputs).toEqual([]);
		expect(final?.filter).toBeUndefined();
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		// `crypto.randomUUID` produces a fresh value per call, so the
		// minted column uuid won't match across the two runs. Strip it
		// before comparing so the test pins the rest of the mutation
		// shape.
		const { doc, ctx: chatCtx } = makeCaseListFixture();
		const { ctx: mcpCtx } = makeCaseListMcpFixture();
		const input = {
			moduleIndex: 0,
			column: {
				kind: "plain" as const,
				field: "case_name",
				header: "Patient",
			},
		};

		const r1 = await addCaseListColumnTool.execute(input, chatCtx, doc);
		const r2 = await addCaseListColumnTool.execute(input, mcpCtx, doc);

		const stripUuid = (mutations: typeof r1.mutations) =>
			mutations.map((m) => {
				if (m.kind !== "updateModule") return m;
				const cols = m.patch.caseListConfig?.columns ?? [];
				return {
					...m,
					patch: {
						...m.patch,
						caseListConfig: m.patch.caseListConfig
							? {
									...m.patch.caseListConfig,
									columns: cols.map(({ uuid: _u, ...rest }) => rest),
								}
							: m.patch.caseListConfig,
					},
				};
			});

		expect(stripUuid(r1.mutations)).toEqual(stripUuid(r2.mutations));
	});
});
