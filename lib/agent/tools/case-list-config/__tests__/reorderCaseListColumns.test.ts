/**
 * Behavioral tests for `reorderCaseListColumns`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — the columns array is reordered to match
 *      the supplied uuid sequence; the entries themselves carry
 *      through unchanged.
 *   2. Length mismatch surfaces an Elm-style error naming both
 *      counts.
 *   3. Duplicate uuid in the request surfaces an Elm-style error
 *      naming the duplicate.
 *   4. Unknown uuid in the request surfaces an Elm-style error
 *      naming the unknown uuid.
 *   5. Module-not-found surfaces an Elm-style error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { reorderCaseListColumnsTool } from "../reorderCaseListColumns";
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

function fixtureWithThreeColumns(): BlueprintDoc {
	const doc = makeCaseListDoc();
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: {
					columns: [
						plainColumn(A, "alpha", "Alpha", {}),
						plainColumn(B, "beta", "Beta", {}),
						plainColumn(C, "charlie", "Charlie", {}),
					],
					listColumnOrder: [A, B, C],
					detailColumnOrder: [A, B, C],
					searchInputs: [],
				},
			},
		},
	};
}

describe("reorderCaseListColumns", () => {
	it("reorders Results without changing Details or generic order", async () => {
		const doc = fixtureWithThreeColumns();
		const detailsBefore =
			doc.modules[MOD_A]?.caseListConfig?.detailColumnOrder ?? [];
		const h = makeCaseListFixture(doc);

		const result = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid: MOD_A,
			surface: "results",
			columnUuids: [C, A, B],
		});

		const config = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(config?.listColumnOrder).toEqual([C, A, B]);
		expect(config?.detailColumnOrder).toEqual(detailsBefore);
		// The plan is the moves the new arrangement actually needs, not one per
		// row: [A, B, C] becomes [C, A, B] by moving C alone.
		expect(result.mutations).toHaveLength(1);
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual([
			"moveColumn",
		]);
		expect(result.mutations).toEqual(
			expect.arrayContaining([expect.objectContaining({ surface: "list" })]),
		);
	});

	it("reorders Details without changing Results", async () => {
		const doc = fixtureWithThreeColumns();
		const resultsBefore =
			doc.modules[MOD_A]?.caseListConfig?.listColumnOrder ?? [];
		const h = makeCaseListFixture(doc);
		await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid: MOD_A,
			surface: "details",
			columnUuids: [B, C, A],
		});
		const config = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(config?.detailColumnOrder).toEqual([B, C, A]);
		expect(config?.listColumnOrder).toEqual(resultsBefore);
	});

	it("returns the new order in the structured result and the message", async () => {
		const h = makeCaseListFixture(fixtureWithThreeColumns());
		const result = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid: MOD_A,
			surface: "results",
			columnUuids: [C, A, B],
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.order).toEqual([C, A, B]);
		expect(result.result.surface).toBe("results");
		expect(result.result.message).toContain("3");
	});

	it("returns an Elm-style error on length mismatch", async () => {
		const h = makeCaseListFixture(fixtureWithThreeColumns());
		const result = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid: MOD_A,
			surface: "results",
			columnUuids: [A, B],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("3 entries");
		expect(result.result.error).toContain("supplied 2 uuids");
	});

	it("returns an Elm-style error on duplicate uuid in the request", async () => {
		const h = makeCaseListFixture(fixtureWithThreeColumns());
		const result = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid: MOD_A,
			surface: "results",
			columnUuids: [A, A, B],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("duplicate uuid");
		expect(result.result.error).toContain(String(A));
	});

	it("returns an Elm-style error on unknown uuid in the request", async () => {
		const h = makeCaseListFixture(fixtureWithThreeColumns());
		const unknown = testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid: MOD_A,
			surface: "results",
			columnUuids: [A, B, unknown],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("unknown uuid");
		expect(result.result.error).toContain(String(unknown));
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture(fixtureWithThreeColumns());
		const result = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid: testUuid("unknown-module"),
			surface: "results",
			columnUuids: [A, B, C],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});
});
