import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { DocumentChanges, FormChange } from "@/lib/doc/documentChanges";
import {
	documentChangeLines,
	madeByLine,
} from "@/lib/publish/documentChangeCopy";

const NONE: DocumentChanges = {
	app: [],
	translations: { text: 0, review: 0 },
	mediaFiles: 0,
	menusReordered: false,
	menus: [],
	forms: [],
	count: 0,
};

const NO_QUESTIONS: FormChange["questions"] = {
	added: [],
	removed: [],
	changed: [],
	moved: [],
};

function form(
	overrides: Partial<FormChange> & Pick<FormChange, "state">,
): FormChange {
	return {
		uuid: testUuid("copy-visit"),
		name: "Visit",
		menuName: "Mothers",
		parts: [],
		questions: NO_QUESTIONS,
		...overrides,
	};
}

const q = (name: string) => ({ uuid: testUuid(`copy-${name}`), name });

/** Both sides' lines of one value. */
function both(changes: Partial<DocumentChanges>) {
	const value = { ...NONE, ...changes };
	return {
		hq: documentChangeLines(value, "hq"),
		nova: documentChangeLines(value, "nova"),
	};
}

describe("documentChangeLines", () => {
	it("says a menu added, removed, its parts and its forms' order", () => {
		const menu = (state: "added" | "removed" | "changed") => ({
			uuid: testUuid("copy-mothers"),
			name: "Mothers",
			state,
			parts: [],
			formsReordered: false,
		});
		expect(
			both({
				menus: [
					{ ...menu("added"), name: "Babies" },
					{ ...menu("removed"), name: "Fathers" },
					{ ...menu("changed"), parts: ["name"] },
					{
						...menu("changed"),
						name: "Visits",
						parts: ["case-list", "case-details", "search", "settings", "note"],
						formsReordered: true,
					},
				],
			}).hq,
		).toEqual([
			"The menu “Babies” was added",
			"The menu “Fathers” was removed",
			"The menu “Mothers”: its name changed",
			"The menu “Visits”: its case list, its case details, its search, its settings and its note changed",
			"The menu “Visits”: its forms are in a new order",
		]);
	});

	it("says a form added and removed alike on both sides", () => {
		const lines = both({
			forms: [
				form({ state: "added" }),
				form({ state: "removed", name: "Old" }),
			],
		});
		expect(lines.hq).toEqual([
			"The form “Visit” in the menu “Mothers” was added",
			"The form “Old” in the menu “Mothers” was removed",
		]);
		expect(lines.nova).toEqual(lines.hq);
	});

	it("counts the questions on CommCare HQ's side and names every one on Nova's", () => {
		const lines = both({
			forms: [
				form({
					state: "changed",
					parts: ["name", "settings", "case-changes", "after-submit", "note"],
					questions: {
						added: [q("phone"), q("household/head_name")],
						removed: [q("age")],
						changed: [q("edd"), q("weight"), q("height")],
						moved: [q("notes")],
					},
				}),
			],
		});
		expect(lines.hq).toEqual([
			"The form “Visit” in the menu “Mothers”: 2 questions added, 1 removed, 3 changed, 1 moved, its name, its settings, what it saves to cases, where it goes after submit, its note",
		]);
		expect(lines.nova).toEqual([
			"The form “Visit” in the menu “Mothers”: questions added: “phone” and “household/head_name”, removed: “age”, changed: “edd”, “weight” and “height”, moved: “notes”, its name, its settings, what it saves to cases, where it goes after submit, its note",
		]);
	});

	it("puts the noun on the first question clause, singular for one", () => {
		const lines = both({
			forms: [
				form({
					state: "changed",
					parts: ["settings"],
					questions: {
						...NO_QUESTIONS,
						changed: [q("edd")],
						moved: [q("a"), q("b")],
					},
				}),
			],
		});
		expect(lines.hq).toEqual([
			"The form “Visit” in the menu “Mothers”: 1 question changed, 2 moved, its settings",
		]);
		expect(lines.nova).toEqual([
			"The form “Visit” in the menu “Mothers”: question changed: “edd”, moved: “a” and “b”, its settings",
		]);
		expect(
			both({
				forms: [
					form({
						state: "changed",
						questions: { ...NO_QUESTIONS, removed: [q("a"), q("b")] },
					}),
				],
			}),
		).toEqual({
			hq: ["The form “Visit” in the menu “Mothers”: 2 questions removed"],
			nova: [
				"The form “Visit” in the menu “Mothers”: questions removed: “a” and “b”",
			],
		});
	});

	it("names a form's questions however many there are", () => {
		const many = Array.from({ length: 40 }, (_, i) => q(`question_${i}`));
		const [line] = both({
			forms: [
				form({
					state: "changed",
					questions: { ...NO_QUESTIONS, changed: many },
				}),
			],
		}).nova;
		for (const question of many) expect(line).toContain(`“${question.name}”`);
	});

	it("says each part of the app on a line of its own", () => {
		expect(
			both({
				app: [
					"name",
					"languages",
					"settings",
					"logo",
					"case-types",
					"worker-properties",
					"roles",
					"personas",
					"organization",
					"automations",
				],
				menusReordered: true,
			}).hq,
		).toEqual([
			"The app's name",
			"The app's languages",
			"The app's settings",
			"The app's logo",
			"The case types",
			"Worker properties",
			"Roles",
			"Personas",
			"The organization",
			"Automations",
			"The menus are in a new order",
		]);
	});

	it("counts translations and pictures or sounds, singular and plural, each side its own review line", () => {
		expect(
			both({ translations: { text: 1, review: 1 }, mediaFiles: 1 }),
		).toEqual({
			hq: [
				"1 translation changed",
				"1 translation to review, because its source text changed in CommCare HQ",
				"1 picture or sound changed",
			],
			nova: [
				"1 translation changed",
				"The review mark on 1 translation",
				"1 picture or sound changed",
			],
		});
		expect(
			both({ translations: { text: 1200, review: 3 }, mediaFiles: 4 }),
		).toEqual({
			hq: [
				"1,200 translations changed",
				"3 translations to review, because their source text changed in CommCare HQ",
				"4 pictures or sounds changed",
			],
			nova: [
				"1,200 translations changed",
				"Review marks on 3 translations",
				"4 pictures or sounds changed",
			],
		});
	});

	it("gives no line for no change", () => {
		expect(both({})).toEqual({ hq: [], nova: [] });
	});
});

describe("madeByLine", () => {
	it("names three at most and counts the rest", () => {
		expect(madeByLine(["Asha"])).toBe("Some of these were made by Asha.");
		expect(madeByLine(["Asha", "Ben"])).toBe(
			"Some of these were made by Asha and Ben.",
		);
		expect(madeByLine(["Asha", "Ben", "Chen"])).toBe(
			"Some of these were made by Asha, Ben and Chen.",
		);
		expect(madeByLine(["Asha", "Ben", "Chen", "Dina"])).toBe(
			"Some of these were made by Asha, Ben, Chen and 1 other.",
		);
		expect(madeByLine(["Asha", "Ben", "Chen", "Dina", "Eli"])).toBe(
			"Some of these were made by Asha, Ben, Chen and 2 others.",
		);
	});
});

describe("the voice", () => {
	it("holds no em dash and no ellipsis", () => {
		const lines = both({
			app: ["name", "worker-properties"],
			menusReordered: true,
			menus: [
				{
					uuid: testUuid("copy-m"),
					name: "M",
					state: "changed",
					parts: ["name", "case-list"],
					formsReordered: true,
				},
			],
			forms: [
				form({
					state: "changed",
					parts: ["note"],
					questions: { ...NO_QUESTIONS, added: [q("a")], moved: [q("b")] },
				}),
			],
			translations: { text: 2, review: 2 },
			mediaFiles: 2,
		});
		for (const line of [
			...lines.hq,
			...lines.nova,
			madeByLine(["a", "b", "c", "d"]),
		]) {
			expect(line).not.toMatch(/—|…|\.\.\./);
		}
	});
});
