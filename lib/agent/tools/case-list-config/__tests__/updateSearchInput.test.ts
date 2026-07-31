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
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { updateSearchInputTool } from "../updateSearchInput";
import { MOD_A, makeCaseListFixture } from "./fixtures";

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

const TARGET_UUID = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const SIBLING_UUID = testUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

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
				caseListConfig: resolveCaseListConfig({
					columns: [
						plainColumn(
							testUuid("search-input-fixture-column"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [target, sibling],
				}),
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
				moduleUuid: MOD_A,
				searchInputUuid: TARGET_UUID,
				searchInput: {
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "text",
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
				moduleUuid: MOD_A,
				searchInputUuid: TARGET_UUID,
				searchInput: {
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "text",
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
				moduleUuid: MOD_A,
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

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const result = await updateSearchInputTool.execute(
			{
				moduleUuid: testUuid("unknown-module"),
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
		expect(result.result.error).toContain("No module with UUID");
	});

	it("returns an Elm-style error when the search-input uuid is unknown", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const unknown = testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await updateSearchInputTool.execute(
			{
				moduleUuid: MOD_A,
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
