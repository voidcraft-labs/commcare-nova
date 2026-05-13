/**
 * Behavioral tests for `updateSearchInput`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — replaces the existing search input in
 *      place; preserves the uuid.
 *   2. Switching kinds (`simple` ↔ `advanced`) is permitted.
 *   3. Surrounding entries stay byte-identical.
 *   4. Module-not-found / search-input-uuid-not-found surface
 *      Elm-style errors.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asUuid, type BlueprintDoc, simpleSearchInputDef } from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { updateSearchInputTool } from "../updateSearchInput";
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

const TARGET_UUID = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const SIBLING_UUID = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithInputs(): BlueprintDoc {
	const { doc } = makeCaseListFixture();
	const target = simpleSearchInputDef(
		TARGET_UUID,
		"name_search",
		"Name",
		"text",
		"case_name",
	);
	const sibling = simpleSearchInputDef(
		SIBLING_UUID,
		"phone_search",
		"Phone",
		"text",
		"phone",
	);
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: {
					columns: [],
					searchInputs: [target, sibling],
				},
			},
		},
	};
}

describe("updateSearchInput", () => {
	it("replaces the search input in place and preserves the uuid", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();

		const result = await updateSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInputUuid: TARGET_UUID,
				searchInput: {
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "select",
					predicate: matchAll(),
				},
			},
			ctx,
			doc,
		);

		const inputs =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(2);
		const updated = inputs[0];
		expect(updated?.uuid).toBe(TARGET_UUID);
		expect(updated?.kind).toBe("advanced");
	});

	it("permits switching kinds (simple → advanced)", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const result = await updateSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInputUuid: TARGET_UUID,
				searchInput: {
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "select",
					predicate: matchAll(),
				},
			},
			ctx,
			doc,
		);

		const updated =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs[0];
		expect(updated?.kind).toBe("advanced");
	});

	it("leaves sibling search inputs untouched", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const sibling = doc.modules[MOD_A]?.caseListConfig?.searchInputs[1];

		const result = await updateSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInputUuid: TARGET_UUID,
				searchInput: {
					kind: "simple",
					name: "renamed",
					label: "Renamed",
					type: "text",
					property: "case_name",
				},
			},
			ctx,
			doc,
		);

		const inputs =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs[1]).toEqual(sibling);
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const result = await updateSearchInputTool.execute(
			{
				moduleIndex: 99,
				searchInputUuid: TARGET_UUID,
				searchInput: {
					kind: "simple",
					name: "renamed",
					label: "Renamed",
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
		expect(result.result.error).toContain("Tried to update");
		expect(result.result.error).toContain("module index 99");
	});

	it("returns an Elm-style error when the search-input uuid is unknown", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const unknown = asUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await updateSearchInputTool.execute(
			{
				moduleIndex: 0,
				searchInputUuid: unknown,
				searchInput: {
					kind: "simple",
					name: "renamed",
					label: "Renamed",
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
		expect(result.result.error).toContain(String(unknown));
		expect(result.result.error).toContain("Found no entry with that uuid");
	});
});
