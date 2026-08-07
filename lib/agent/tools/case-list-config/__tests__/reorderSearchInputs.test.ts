/**
 * Behavioral tests for `reorderSearchInputs`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — search-inputs reordered to match the
 *      supplied uuid sequence.
 *   2. Length mismatch / duplicate uuid / unknown uuid surface
 *      distinct Elm-style errors.
 *   3. Module-not-found surfaces an Elm-style error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { reorderSearchInputsTool } from "../reorderSearchInputs";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

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

const A = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const B = testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const C = testUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithThreeInputs(): BlueprintDoc {
	const doc = makeCaseListDoc();
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: resolveCaseListConfig({
					columns: [
						plainColumn(
							testUuid("reorder-search-input-results-column"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [
						simpleSearchInputDef(A, "alpha", "Alpha", "text", "case_name"),
						simpleSearchInputDef(B, "beta", "Beta", "text", "phone"),
						simpleSearchInputDef(C, "charlie", "Charlie", "text", "region"),
					],
				}),
			},
		},
	};
}

describe("reorderSearchInputs", () => {
	it("reorders the search-inputs array to match the supplied uuid sequence", async () => {
		const h = makeCaseListFixture(fixtureWithThreeInputs());
		const result = await h.runTool(reorderSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputUuids: [C, A, B],
		});

		const inputs =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs.map((i) => i.uuid)).toEqual([C, A, B]);
		expect(result.mutations.every((m) => m.kind === "moveSearchInput")).toBe(
			true,
		);
	});

	it("returns the new order in the structured result", async () => {
		const h = makeCaseListFixture(fixtureWithThreeInputs());
		const result = await h.runTool(reorderSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputUuids: [C, A, B],
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.order).toEqual([C, A, B]);
	});

	it("returns an Elm-style error on length mismatch", async () => {
		const h = makeCaseListFixture(fixtureWithThreeInputs());
		const result = await h.runTool(reorderSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputUuids: [A, B],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("3 entries");
		expect(result.result.error).toContain("supplied 2 uuids");
	});

	it("returns an Elm-style error on duplicate uuid in the request", async () => {
		const h = makeCaseListFixture(fixtureWithThreeInputs());
		const result = await h.runTool(reorderSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputUuids: [A, A, B],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("duplicate uuid");
		expect(result.result.error).toContain(String(A));
	});

	it("returns an Elm-style error on unknown uuid in the request", async () => {
		const h = makeCaseListFixture(fixtureWithThreeInputs());
		const unknown = testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await h.runTool(reorderSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputUuids: [A, B, unknown],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("unknown uuid");
		expect(result.result.error).toContain(String(unknown));
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture(fixtureWithThreeInputs());
		const result = await h.runTool(reorderSearchInputsTool, {
			moduleUuid: testUuid("unknown-module"),
			searchInputUuids: [A, B, C],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});
});
