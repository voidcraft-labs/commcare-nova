/** Schema-admitted shared tool calls through the real workspace and reducer.
 * Controlled host receipts prove local state transitions, not SQL commits. */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Column,
	collectTranslationUnits,
	idMappingColumn,
	plainColumn,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import { generatedWordingId } from "@/lib/domain/generatedWording";
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

const ROW = testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");

/** A label table with one row that has an identity and one saved before rows
 *  carried identities. */
function fixtureWithMapping(): BlueprintDoc {
	const doc = fixtureWithColumn();
	const config = doc.modules[MOD_A]?.caseListConfig;
	if (config === undefined) throw new Error("The fixture has a list.");
	const mapping = idMappingColumn(SIBLING_UUID, "phone", "Phone", [
		{ uuid: ROW, value: "home", label: "Home" },
		{ value: "work", label: "Work" },
	]);
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: {
					...config,
					columns: config.columns.map((column) =>
						column.uuid === SIBLING_UUID ? mapping : column,
					),
				},
			},
		},
	};
}

function mappingOf(doc: BlueprintDoc): Extract<Column, { kind: "id-mapping" }> {
	const column = doc.modules[MOD_A]?.caseListConfig?.columns.find(
		(one) => one.uuid === SIBLING_UUID,
	);
	if (column?.kind !== "id-mapping") throw new Error("Expected a mapping.");
	return column;
}

describe("updateCaseListColumn", () => {
	it("keeps each mapping row's identity, and so its translations, when the update omits it", async () => {
		const before = fixtureWithMapping();
		const units = mappingOf(before).mapping.map((row) =>
			caseMappingTextUnit(SIBLING_UUID, row, "mapping"),
		);
		const h = makeCaseListFixture(before);
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: SIBLING_UUID,
			column: {
				kind: "id-mapping",
				field: "phone",
				header: "Phone",
				mapping: [
					{ value: "home", label: "Home" },
					{ value: "work", label: "Work" },
					{ value: "cell", label: "Cell" },
				],
			},
		});
		if ("error" in result.result) throw new Error(result.result.error);
		const rows = mappingOf(h.currentDoc()).mapping;
		expect(rows[0]?.uuid).toBe(ROW);
		expect(rows[1]?.uuid).toBeUndefined();
		expect(
			rows
				.slice(0, 2)
				.map((row) => caseMappingTextUnit(SIBLING_UUID, row, "mapping")),
		).toEqual(units);
		// A row with a new comparison is a new row with its own identity.
		expect(rows[2]?.uuid).toBeDefined();
		expect(rows[2]?.uuid).not.toBe(ROW);
	});

	it("carries a row's translation and each view's own wording to the unit a new value moves it to", async () => {
		// A row saved before rows carried identities is keyed by its value, so a new value moves
		// its label to another unit; the row is the same row, and so are its words in every
		// language, as the Builder's column editor keeps them (`mappingRowTranslationCarry`).
		const base = produce(fixtureWithMapping(), (draft) => {
			applyMutations(draft, [
				{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
			]);
		});
		const work = mappingOf(base).mapping[1];
		const from = caseMappingTextUnit(SIBLING_UUID, work ?? {}, "mapping");
		const unit = collectTranslationUnits(base).find((one) => one.id === from);
		if (unit === undefined) throw new Error("The row's label has no unit.");
		const entry = (value: string) => ({
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human" as const,
			review: "reviewed" as const,
			translatedFrom: "eng",
		});
		const view = (id: string) =>
			generatedWordingId(SIBLING_UUID, "caseRows", id);
		const doc = produce(base, (draft) => {
			applyMutations(draft, [
				{
					kind: "setTranslation",
					language: "spa",
					unitId: from,
					entry: entry("Trabajo"),
				},
				{
					kind: "setTranslation",
					language: "spa",
					unitId: view(from),
					entry: entry("Oficina"),
				},
			]);
		});
		const h = makeCaseListFixture(doc);
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: SIBLING_UUID,
			column: {
				kind: "id-mapping",
				field: "phone",
				header: "Phone",
				mapping: [
					{ value: "home", label: "Home" },
					{ value: "office", label: "Work" },
				],
			},
		});
		if ("error" in result.result) throw new Error(result.result.error);
		const after = h.currentDoc();
		const moved = mappingOf(after).mapping[1];
		const to = caseMappingTextUnit(SIBLING_UUID, moved ?? {}, "mapping");
		expect(to).not.toBe(from);
		const spanish = after.localization?.translations.spa ?? {};
		expect(spanish[to]?.value).toBe("Trabajo");
		expect(spanish[view(to)]?.value).toBe("Oficina");
		expect(spanish[from]).toBeUndefined();
		expect(spanish[view(from)]).toBeUndefined();
	});

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

	it("stores the comparison a replacement's rule is sent with", async () => {
		const h = makeCaseListFixture(fixtureWithColumn());
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: SIBLING_UUID,
			column: {
				kind: "plain",
				field: "phone",
				header: "Phone",
				sort: { direction: "asc", priority: 0, comparator: "decimal" },
			},
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expect(
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns[1]?.sort,
		).toEqual({ direction: "asc", priority: 0, comparator: "decimal" });
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
