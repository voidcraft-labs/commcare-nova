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
						plainColumn(A, "alpha", "Alpha"),
						plainColumn(B, "beta", "Beta"),
						plainColumn(C, "charlie", "Charlie"),
					],
					searchInputs: [],
				},
			},
		},
	};
}

describe("reorderCaseListColumns", () => {
	it("reorders the columns array to match the supplied uuid sequence", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();

		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, columnUuids: [C, A, B] },
			ctx,
			doc,
		);

		const cols = result.newDoc.modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(cols.map((c) => c.uuid)).toEqual([C, A, B]);
	});

	it("returns the new order in the structured result and the message", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, columnUuids: [C, A, B] },
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.order).toEqual([C, A, B]);
		expect(result.result.message).toContain("3");
	});

	it("returns an Elm-style error on length mismatch", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithThreeColumns();
		const result = await reorderCaseListColumnsTool.execute(
			{ moduleIndex: 0, columnUuids: [A, B] },
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
			{ moduleIndex: 0, columnUuids: [A, A, B] },
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
			{ moduleIndex: 0, columnUuids: [A, B, unknown] },
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
			{ moduleIndex: 99, columnUuids: [A, B, C] },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to reorder");
		expect(result.result.error).toContain("module 99");
	});
});
