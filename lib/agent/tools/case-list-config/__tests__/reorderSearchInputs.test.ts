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
import { bySortKey } from "@/lib/doc/order/compare";
import { asUuid, type BlueprintDoc, simpleSearchInputDef } from "@/lib/domain";
import { reorderSearchInputsTool } from "../reorderSearchInputs";
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

function fixtureWithThreeInputs(): BlueprintDoc {
	const { doc } = makeCaseListFixture();
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: {
					columns: [],
					searchInputs: [
						simpleSearchInputDef(A, "alpha", "Alpha", "text", "alpha"),
						simpleSearchInputDef(B, "beta", "Beta", "text", "beta"),
						simpleSearchInputDef(C, "charlie", "Charlie", "text", "charlie"),
					],
				},
			},
		},
	};
}

describe("reorderSearchInputs", () => {
	it("reorders the search-inputs array to match the supplied uuid sequence", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeInputs();
		const result = await reorderSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputUuids: [C, A, B] },
			ctx,
			doc,
		);

		// A reorder is an order-key change (membership array untouched) — assert
		// the DISPLAY sequence, not raw array position.
		const inputs =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect([...inputs].sort(bySortKey).map((i) => i.uuid)).toEqual([C, A, B]);
		expect(result.mutations.every((m) => m.kind === "moveSearchInput")).toBe(
			true,
		);
	});

	it("returns the new order in the structured result", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeInputs();
		const result = await reorderSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputUuids: [C, A, B] },
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.order).toEqual([C, A, B]);
	});

	it("returns an Elm-style error on length mismatch", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeInputs();
		const result = await reorderSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputUuids: [A, B] },
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
		const doc = fixtureWithThreeInputs();
		const result = await reorderSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputUuids: [A, A, B] },
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
		const doc = fixtureWithThreeInputs();
		const unknown = asUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await reorderSearchInputsTool.execute(
			{ moduleIndex: 0, searchInputUuids: [A, B, unknown] },
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
		const doc = fixtureWithThreeInputs();
		const result = await reorderSearchInputsTool.execute(
			{ moduleIndex: 99, searchInputUuids: [A, B, C] },
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
