/**
 * Behavioral tests for `removeCaseListColumn`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — the targeted column is removed; sibling
 *      columns survive.
 *   2. Returns the removed uuid and the remaining count.
 *   3. Module-not-found surfaces an Elm-style error.
 *   4. Column-uuid not found surfaces an Elm-style error naming the
 *      missing uuid.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asUuid, type BlueprintDoc, plainColumn } from "@/lib/domain";
import { removeCaseListColumnTool } from "../removeCaseListColumn";
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

const TARGET_UUID = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const SIBLING_UUID = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithColumns(): BlueprintDoc {
	const { doc } = makeCaseListFixture();
	const target = plainColumn(TARGET_UUID, "case_name", "Patient");
	const sibling = plainColumn(SIBLING_UUID, "phone", "Phone");
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: {
					columns: [target, sibling],
					searchInputs: [],
				},
			},
		},
	};
}

describe("removeCaseListColumn", () => {
	it("removes the targeted column and leaves siblings intact", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumns();

		const result = await removeCaseListColumnTool.execute(
			{ moduleIndex: 0, columnUuid: TARGET_UUID },
			ctx,
			doc,
		);

		const cols = result.newDoc.modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(cols).toHaveLength(1);
		expect(cols[0]?.uuid).toBe(SIBLING_UUID);
	});

	it("returns the removed uuid and remaining count", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumns();
		const result = await removeCaseListColumnTool.execute(
			{ moduleIndex: 0, columnUuid: TARGET_UUID },
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.uuid).toBe(TARGET_UUID);
		expect(result.result.remaining).toBe(1);
		expect(result.result.message).toContain(String(TARGET_UUID));
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumns();
		const result = await removeCaseListColumnTool.execute(
			{ moduleIndex: 99, columnUuid: TARGET_UUID },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to remove");
		expect(result.result.error).toContain("module index 99");
	});

	it("returns an Elm-style error when the column uuid is unknown", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumns();
		const unknown = asUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await removeCaseListColumnTool.execute(
			{ moduleIndex: 0, columnUuid: unknown },
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
