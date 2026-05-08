/**
 * Behavioral tests for `updateCaseListColumn`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — the existing column is replaced in place;
 *      the column's uuid is preserved.
 *   2. Surrounding columns + the other slots stay byte-identical.
 *   3. Switching kinds across the call is permitted (the input is a
 *      whole-column body, not a partial patch).
 *   4. Module-not-found surfaces an Elm-style error.
 *   5. Column-uuid not found surfaces an Elm-style error naming the
 *      missing uuid.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asUuid, type BlueprintDoc, plainColumn } from "@/lib/domain";
import { updateCaseListColumnTool } from "../updateCaseListColumn";
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

function fixtureWithColumn(): BlueprintDoc {
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

describe("updateCaseListColumn", () => {
	it("replaces the column body in place and preserves the existing uuid", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumn();

		const result = await updateCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				columnUuid: TARGET_UUID,
				column: {
					kind: "date",
					field: "dob",
					header: "DOB",
					pattern: "%Y-%m-%d",
				},
			},
			ctx,
			doc,
		);

		const cols = result.newDoc.modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(cols).toHaveLength(2);
		const updated = cols[0];
		expect(updated?.uuid).toBe(TARGET_UUID);
		expect(updated?.kind).toBe("date");
		if (updated?.kind === "date") {
			expect(updated.field).toBe("dob");
			expect(updated.header).toBe("DOB");
			expect(updated.pattern).toBe("%Y-%m-%d");
		}
	});

	it("leaves sibling columns untouched", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumn();
		const sibling = doc.modules[MOD_A]?.caseListConfig?.columns[1];

		const result = await updateCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				columnUuid: TARGET_UUID,
				column: {
					kind: "date",
					field: "dob",
					header: "DOB",
					pattern: "%Y-%m-%d",
				},
			},
			ctx,
			doc,
		);

		const cols = result.newDoc.modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(cols[1]).toEqual(sibling);
	});

	it("surfaces the touched uuid in the structured result and the message", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumn();
		const result = await updateCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				columnUuid: TARGET_UUID,
				column: { kind: "phone", field: "phone", header: "Phone" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.uuid).toBe(TARGET_UUID);
		expect(result.result.message).toContain(String(TARGET_UUID));
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumn();
		const result = await updateCaseListColumnTool.execute(
			{
				moduleIndex: 99,
				columnUuid: TARGET_UUID,
				column: { kind: "phone", field: "phone", header: "Phone" },
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

	it("returns an Elm-style error when the column uuid is unknown", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithColumn();
		const unknown = asUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await updateCaseListColumnTool.execute(
			{
				moduleIndex: 0,
				columnUuid: unknown,
				column: { kind: "phone", field: "phone", header: "Phone" },
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
