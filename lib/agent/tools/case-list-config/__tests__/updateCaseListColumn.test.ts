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
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { updateCaseListColumnTool } from "../updateCaseListColumn";
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

const TARGET_UUID = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const SIBLING_UUID = testUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithColumn(): BlueprintDoc {
	const doc = makeCaseListDoc();
	const target = plainColumn(TARGET_UUID, "case_name", "Patient");
	const sibling = plainColumn(SIBLING_UUID, "phone", "Phone");
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: resolveCaseListConfig({
					columns: [target, sibling],
					searchInputs: [],
				}),
			},
		},
	};
}

describe("updateCaseListColumn", () => {
	it("replaces the column body in place and preserves the existing uuid", async () => {
		const h = makeCaseListFixture(fixtureWithColumn());

		await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: TARGET_UUID,
			column: {
				kind: "date",
				field: "dob",
				header: "DOB",
				pattern: "%Y-%m-%d",
			},
		});

		const cols = h.currentDoc().modules[MOD_A]?.caseListConfig?.columns ?? [];
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
		const doc = fixtureWithColumn();
		const sibling = doc.modules[MOD_A]?.caseListConfig?.columns[1];
		const h = makeCaseListFixture(doc);

		await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: TARGET_UUID,
			column: {
				kind: "date",
				field: "dob",
				header: "DOB",
				pattern: "%Y-%m-%d",
			},
		});

		const cols = h.currentDoc().modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(cols[1]).toEqual(sibling);
	});

	it("emits a dedicated visibility delta when the replacement hides a surface", async () => {
		const h = makeCaseListFixture(fixtureWithColumn());

		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: TARGET_UUID,
			column: {
				kind: "plain",
				field: "case_name",
				header: "Patient",
				visibleInList: false,
			},
		});

		expect(result.mutations).toHaveLength(1);
		expect(result.mutations[0]).toEqual(
			expect.objectContaining({
				kind: "updateColumn",
				moduleUuid: MOD_A,
				uuid: TARGET_UUID,
				visibilityPatch: { surface: "list", visible: false },
			}),
		);
		expect(result.mutations[0]).not.toHaveProperty("preserveVisibility");
		expect(
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns[0]?.visibleInList,
		).toBe(false);
	});

	it("restores a surface by clearing its optional false flag", async () => {
		const doc = fixtureWithColumn();
		const target = doc.modules[MOD_A]?.caseListConfig?.columns[0];
		if (!target) throw new Error("fixture target missing");
		target.visibleInList = false;
		const h = makeCaseListFixture(doc);

		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: TARGET_UUID,
			column: {
				kind: "plain",
				field: "case_name",
				header: "Patient",
			},
		});

		expect(result.mutations).toHaveLength(1);
		expect(result.mutations[0]).toEqual(
			expect.objectContaining({
				kind: "updateColumn",
				visibilityPatch: { surface: "list", visible: true },
			}),
		);
		expect(
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns[0]?.visibleInList,
		).toBeUndefined();
	});

	it("surfaces the touched uuid in the structured result and the message", async () => {
		const h = makeCaseListFixture(fixtureWithColumn());
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: TARGET_UUID,
			column: { kind: "phone", field: "phone", header: "Phone" },
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.uuid).toBe(TARGET_UUID);
		expect(result.result.message).toContain(String(TARGET_UUID));
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture(fixtureWithColumn());
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: testUuid("unknown-module"),
			columnUuid: TARGET_UUID,
			column: { kind: "phone", field: "phone", header: "Phone" },
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});

	it("returns an Elm-style error when the column uuid is unknown", async () => {
		const h = makeCaseListFixture(fixtureWithColumn());
		const unknown = testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: unknown,
			column: { kind: "phone", field: "phone", header: "Phone" },
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(String(unknown));
		expect(result.result.error).toContain("Found no entry with that uuid");
	});
});
