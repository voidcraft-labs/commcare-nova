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
import { asUuid, type BlueprintDoc, plainColumn } from "@/lib/domain";
import { reorderCaseListColumnsTool } from "../reorderCaseListColumns";
import { MOD_A, makeCaseListFixture } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

const A = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const B = asUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const C = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithThreeColumns(): BlueprintDoc {
	const { doc } = makeCaseListFixture();
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
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const detailsBefore =
			doc.modules[MOD_A]?.caseListConfig?.detailColumnOrder ?? [];

		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, surface: "results", columnUuids: [C, A, B] },
			ctx,
			doc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseListConfig;
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
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const resultsBefore =
			doc.modules[MOD_A]?.caseListConfig?.listColumnOrder ?? [];
		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, surface: "details", columnUuids: [B, C, A] },
			ctx,
			doc,
		);
		const config = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(config?.detailColumnOrder).toEqual([B, C, A]);
		expect(config?.listColumnOrder).toEqual(resultsBefore);
	});

	it("returns the new order in the structured result and the message", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, surface: "results", columnUuids: [C, A, B] },
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.order).toEqual([C, A, B]);
		expect(result.result.surface).toBe("results");
		expect(result.result.message).toContain("3");
	});

	it("returns an Elm-style error on length mismatch", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, surface: "results", columnUuids: [A, B] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("3 entries");
		expect(result.result.error).toContain("supplied 2 uuids");
	});

	it("returns an Elm-style error on duplicate uuid in the request", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, surface: "results", columnUuids: [A, A, B] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("duplicate uuid");
		expect(result.result.error).toContain(String(A));
	});

	it("returns an Elm-style error on unknown uuid in the request", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const unknown = asUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await reorderCaseListColumnsTool.execute(
			{
				moduleIndex: 0,
				surface: "results",
				columnUuids: [A, B, unknown],
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("unknown uuid");
		expect(result.result.error).toContain(String(unknown));
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 99, surface: "results", columnUuids: [A, B, C] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to reorder");
		expect(result.result.error).toContain("module index 99");
	});
});
