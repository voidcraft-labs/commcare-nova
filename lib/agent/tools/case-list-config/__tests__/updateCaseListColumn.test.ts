/** Schema-admitted shared tool calls through the real workspace and reducer.
 * Controlled host receipts prove local state transitions, not SQL commits. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { updateCaseListColumnTool } from "../updateCaseListColumn";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

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

	it("surfaces the touched uuid in the structured result", async () => {
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

	describe("a column that is not on the list", () => {
		const offTheList = {
			kind: "plain",
			field: "case_name",
			header: "Patient",
			notOnList: true,
		} as const;

		it("writes visibleInList false with notOnList", async () => {
			const h = makeCaseListFixture(fixtureWithColumn());
			const result = await h.runTool(updateCaseListColumnTool, {
				moduleUuid: MOD_A,
				columnUuid: TARGET_UUID,
				column: offTheList,
			});
			expect(result.result).not.toHaveProperty("error");
			expect(result.mutations).toEqual([
				expect.objectContaining({
					kind: "updateColumn",
					uuid: TARGET_UUID,
					visibilityPatch: {
						surface: "list",
						visible: false,
						notOnList: true,
					},
				}),
			]);
			expect(
				h.currentDoc().modules[MOD_A]?.caseListConfig?.columns[0],
			).toMatchObject({ visibleInList: false, notOnList: true });
		});

		it("puts the column back on the list, hidden, when the replacement leaves notOnList out", async () => {
			const h = makeCaseListFixture(fixtureWithColumn());
			await h.runTool(updateCaseListColumnTool, {
				moduleUuid: MOD_A,
				columnUuid: TARGET_UUID,
				column: offTheList,
			});
			await h.runTool(updateCaseListColumnTool, {
				moduleUuid: MOD_A,
				columnUuid: TARGET_UUID,
				column: {
					kind: "plain",
					field: "case_name",
					header: "Patient",
					visibleInList: false,
				},
			});
			const column = h.currentDoc().modules[MOD_A]?.caseListConfig?.columns[0];
			expect(column?.visibleInList).toBe(false);
			expect(column).not.toHaveProperty("notOnList");
		});

		it("refuses notOnList beside visibleInList true, or beside a sort, before staging", async () => {
			const h = makeCaseListFixture(fixtureWithColumn());
			const shown = await h.runTool(updateCaseListColumnTool, {
				moduleUuid: MOD_A,
				columnUuid: TARGET_UUID,
				column: { ...offTheList, visibleInList: true },
			});
			expect(shown.mutations).toEqual([]);
			expect(shown.result).toEqual({
				error:
					"A column can't be shown on Results and off the list at once. Leave out notOnList to show it, or leave out visibleInList to keep it off the list.",
			});
			const sorted = await h.runTool(updateCaseListColumnTool, {
				moduleUuid: MOD_A,
				columnUuid: TARGET_UUID,
				column: { ...offTheList, sort: { direction: "desc", priority: 0 } },
			});
			expect(sorted.mutations).toEqual([]);
			expect(sorted.result).toEqual({
				error: `The "Patient" column isn't on the list, so the list can't sort by it. You can remove its sort rule, or keep the column on the list as a hidden one, which the list's search then matches.`,
			});
		});
	});
});
