/**
 * Behavioral tests for `addSearchInput`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — the supplied search input is appended to
 *      `caseListConfig.searchInputs` with a freshly minted uuid.
 *   2. Surfaces uuid in result.uuid + the message.
 *   3. Both `simple` and `advanced` arms round-trip cleanly.
 *   4. Surrounding columns + filter survive.
 *   5. Module-not-found surfaces an Elm-style error.
 *   6. Initializes the caseListConfig when the module has none.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
	type BlueprintDoc,
	type Module,
	plainColumn,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { addSearchInputTool } from "../addSearchInput";
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

describe("addSearchInput", () => {
	it("appends a simple-arm search input with a freshly minted uuid", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await addSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInput: {
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			},
			ctx,
			doc,
		);

		const inputs =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(1);
		const input = inputs[0];
		expect(input?.kind).toBe("simple");
		expect(input?.uuid).toBeTruthy();
		if (input?.kind === "simple") {
			expect(input.property).toBe("case_name");
		}
	});

	it("appends an advanced-arm search input with a freshly minted uuid", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const predicate = matchAll();
		const result = await addSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInput: {
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "select",
					predicate,
				},
			},
			ctx,
			doc,
		);

		const inputs =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(1);
		const input = inputs[0];
		expect(input?.kind).toBe("advanced");
		if (input?.kind === "advanced") {
			expect(input.predicate).toEqual(predicate);
		}
	});

	it("surfaces the new uuid in the structured result and the message", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await addSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInput: {
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		const newInput =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs[0];
		expect(result.result.uuid).toBe(newInput?.uuid);
		expect(result.result.message).toContain(String(newInput?.uuid));
	});

	it("preserves columns and filter when adding a search input", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededColumn = plainColumn(
			asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			"case_name",
			"Patient",
		);
		const seededFilter = matchAll();
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [seededColumn],
						searchInputs: [],
						filter: seededFilter,
					},
				},
			},
		};

		const result = await addSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInput: {
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			},
			ctx,
			docWithConfig,
		);

		const final = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toEqual([seededColumn]);
		expect(final?.filter).toEqual(seededFilter);
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await addSearchInputTool.execute(
			{
				moduleIndex: 99,
				searchInput: {
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to add");
		expect(result.result.error).toContain("module 99");
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

		const result = await addSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInput: {
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			},
			ctx,
			docWithoutConfig,
		);

		const final = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(final?.searchInputs).toHaveLength(1);
		expect(final?.columns).toEqual([]);
		expect(final?.filter).toBeUndefined();
	});
});
