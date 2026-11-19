// The running list's Sort by as each platform plays it: what it lists, the
// marks it shows, what a pick does to the choice and what lets a pick go, over
// the order plan the production list reads.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseListConfig,
	type Column,
	caseListOrderPlan,
	caseListSingleFieldOrder,
	columnSort,
	dateColumn,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import {
	makeTranslationUnitId,
	type TranslationUnitId,
} from "@/lib/domain/localization";
import { translationUnitsById } from "@/lib/domain/translationUnits";
import {
	caseListSortAfterFilterText,
	caseListSortOptions,
	LIST_ORDER,
	pickCaseListSort,
} from "../caseListSortMenu";
import { previewPlatformRules } from "../platform";
import { projectWorkerModule } from "../workerModule";

const ANDROID = previewPlatformRules("android").sortMenu;
const WEB_APPS = previewPlatformRules("web-apps").sortMenu;

const NAME = testUuid("sort-menu-name");
const VILLAGE = testUuid("sort-menu-village");
const VISITED = testUuid("sort-menu-visited");
const FEELING = testUuid("sort-menu-feeling");
const SCORE = testUuid("sort-menu-score");
const MODULE = testUuid("sort-menu-module");

function config(columns: readonly Column[], tiled = false): CaseListConfig {
	return {
		columns: [...columns],
		searchInputs: [],
		listColumnOrder: columns.map((column) => column.uuid),
		detailColumnOrder: columns.map((column) => column.uuid),
		...(tiled && { tile: {} }),
	};
}

const plan = (list: CaseListConfig) =>
	caseListOrderPlan(list, [{ name: "score", data_type: "int" }], {
		mediaOn: true,
		calculatedType: () => undefined,
		expressionText: () => "",
	});

/** A list like CommCare HQ's health starter's: shown name and village, a
 *  date shown unsorted, and two hidden sorted values, one named in Sort by. */
function starterLike(tiled = false): CaseListConfig {
	const tile = (x: number) =>
		tiled ? { tile: tileCell(x, 0, 1, 1) } : undefined;
	return config(
		[
			plainColumn(NAME, "case_name", "Name", {
				sort: columnSort("asc", 1),
				...tile(0),
			}),
			plainColumn(VILLAGE, "village", "Village", { ...tile(1) }),
			dateColumn(VISITED, "visited", "Visited", "%d/%m/%Y", { ...tile(2) }),
			plainColumn(FEELING, "feeling_sick", "", {
				visibleInList: false,
				sort: columnSort("desc", 0, undefined, "Feeling Sick"),
			}),
			plainColumn(SCORE, "score", "", {
				visibleInList: false,
				sort: columnSort("asc", 2),
			}),
		],
		tiled,
	);
}

const listed = (
	list: CaseListConfig,
	rules: typeof ANDROID,
	choice = LIST_ORDER,
) =>
	caseListSortOptions({
		plan: plan(list),
		columns: list.columns,
		rules,
		tiled: list.tile !== undefined,
		choice,
	}).map((option) => ({
		column: option.column.uuid,
		name: option.name,
		...(option.arrow !== undefined && { arrow: option.arrow }),
		...(option.priority !== undefined && { priority: option.priority }),
	}));

describe("what the list's Sort by lists", () => {
	it("lists every named field on Android, in the list's own field order, numbered by the list's order", () => {
		expect(listed(starterLike(), ANDROID)).toEqual([
			{ column: NAME, name: "Name", arrow: "up", priority: 2 },
			{ column: VILLAGE, name: "Village" },
			{ column: VISITED, name: "Visited" },
			{ column: FEELING, name: "Feeling Sick", arrow: "down", priority: 1 },
		]);
	});

	it("lists the shown sort fields of a list of columns on Web Apps, with no marks before a pick", () => {
		expect(listed(starterLike(), WEB_APPS)).toEqual([
			{ column: NAME, name: "Name" },
		]);
	});

	it("lists every sort field of a case tile list on Web Apps, in the list's order, an unnamed one with no name", () => {
		expect(listed(starterLike(true), WEB_APPS)).toEqual([
			{ column: FEELING, name: "Feeling Sick" },
			{ column: NAME, name: "Name" },
			{ column: SCORE, name: "" },
		]);
	});

	it("lists a named hidden sort field of a case tile list on Android, and no unnamed one", () => {
		expect(
			listed(starterLike(true), ANDROID).map((option) => option.column),
		).toEqual([NAME, VILLAGE, VISITED, FEELING]);
	});

	it("marks the pick alone once there is one", () => {
		const list = starterLike(true);
		const choice = pickCaseListSort(
			LIST_ORDER,
			FEELING,
			plan(list),
			list.columns,
			WEB_APPS,
		);
		expect(listed(list, WEB_APPS, choice).filter((o) => "arrow" in o)).toEqual([
			{ column: FEELING, name: "Feeling Sick", arrow: "down" },
		]);
		const android = pickCaseListSort(
			LIST_ORDER,
			FEELING,
			plan(list),
			list.columns,
			ANDROID,
		);
		// Android marks the direction the list now runs: Feeling Sick's own,
		// descending.
		expect(listed(list, ANDROID, android).filter((o) => "arrow" in o)).toEqual([
			{ column: FEELING, name: "Feeling Sick", arrow: "down" },
		]);
	});
});

describe("what a pick does", () => {
	const onlyName = config([
		plainColumn(NAME, "case_name", "Name", { sort: columnSort("asc", 0) }),
		plainColumn(VILLAGE, "village", "Village"),
	]);

	it("turns the list's only sort field around at once on Android, and not on Web Apps", () => {
		const pick = (rules: typeof ANDROID) =>
			pickCaseListSort(
				LIST_ORDER,
				NAME,
				plan(onlyName),
				onlyName.columns,
				rules,
			).picks;
		expect(pick(ANDROID)).toEqual([{ column: NAME, reversed: true }]);
		expect(pick(WEB_APPS)).toEqual([{ column: NAME, reversed: false }]);
	});

	it("turns a pick around when it is picked again, and starts another in its own direction", () => {
		const list = starterLike();
		const step = (
			choice: typeof LIST_ORDER,
			column: string,
			rules: typeof ANDROID,
		) => pickCaseListSort(choice, column, plan(list), list.columns, rules);
		const once = step(LIST_ORDER, NAME, WEB_APPS);
		const twice = step(once, NAME, WEB_APPS);
		const thrice = step(twice, NAME, WEB_APPS);
		expect([once, twice, thrice].map((c) => c.picks)).toEqual([
			[{ column: NAME, reversed: false }],
			[{ column: NAME, reversed: true }],
			[{ column: NAME, reversed: false }],
		]);
		expect(step(twice, VILLAGE, WEB_APPS)).toEqual({
			picks: [{ column: VILLAGE, reversed: false }],
			thenListOrder: false,
		});
	});

	it("keeps the earlier picks on Android to break ties, each column once, newest first", () => {
		const list = starterLike();
		const android = (choice: typeof LIST_ORDER, column: string) =>
			pickCaseListSort(choice, column, plan(list), list.columns, ANDROID);
		// Village again after name is a new pick, in its own direction: only
		// a pick of the field picked last turns around.
		const choice = android(
			android(android(LIST_ORDER, VILLAGE), NAME),
			VILLAGE,
		);
		expect(choice).toEqual({
			picks: [
				{ column: VILLAGE, reversed: false },
				{ column: NAME, reversed: false },
			],
			thenListOrder: true,
		});
		expect(android(choice, VILLAGE).picks[0]).toEqual({
			column: VILLAGE,
			reversed: true,
		});
	});

	it("lets the pick go when the filter's text changes on Web Apps, and keeps it on Android", () => {
		const choice = {
			picks: [{ column: NAME, reversed: true }],
			thenListOrder: false,
		};
		expect(caseListSortAfterFilterText(choice, WEB_APPS)).toBe(LIST_ORDER);
		expect(caseListSortAfterFilterText(choice, ANDROID)).toBe(choice);
	});
});

describe("how the list orders by one field alone", () => {
	const list = starterLike();

	it("orders a sort field in its own direction and blanks, and turns only the direction around", () => {
		expect(caseListSingleFieldOrder(plan(list), FEELING, false)).toEqual({
			key: { kind: "property", property: "feeling_sick" },
			comparator: "text",
			direction: "desc",
			blanks: "last",
		});
		expect(caseListSingleFieldOrder(plan(list), FEELING, true)).toMatchObject({
			direction: "asc",
			blanks: "last",
		});
		expect(caseListSingleFieldOrder(plan(list), SCORE, false)).toMatchObject({
			comparator: "integer",
		});
	});

	it("orders a field with a sort key and no rule ascending with blanks last", () => {
		expect(caseListSingleFieldOrder(plan(list), VISITED, false)).toEqual({
			key: { kind: "property", property: "visited" },
			comparator: "text",
			direction: "asc",
			blanks: "last",
		});
	});

	it("orders a field with no sort key by the text it shows, ascending with blanks first", () => {
		expect(caseListSingleFieldOrder(plan(list), VILLAGE, false)).toEqual({
			key: { kind: "property", property: "village" },
			comparator: "text",
			direction: "asc",
			blanks: "first",
		});
	});

	it("orders by a carrier of a case tile list, and by nothing the plan does not hold", () => {
		const tiled = starterLike(true);
		expect(caseListSingleFieldOrder(plan(tiled), FEELING, false)).toEqual({
			key: { kind: "property", property: "feeling_sick" },
			comparator: "text",
			direction: "desc",
			blanks: "last",
		});
		expect(
			caseListSingleFieldOrder(plan(tiled), testUuid("sort-menu-gone"), false),
		).toBeUndefined();
	});
});

describe("the name in Sort by in the language Preview shows", () => {
	it("reads a hidden field's name from its translation, as the list's headers do", () => {
		const list = starterLike();
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					uuid: MODULE,
					name: "Patients",
					caseType: "patient",
					caseListConfig: list,
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		const units = translationUnitsById(doc);
		const entry = (id: TranslationUnitId, value: string) => {
			const unit = units.get(id);
			if (unit === undefined) throw new Error(`Expected the unit ${id}.`);
			return {
				value,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human" as const,
				review: "reviewed" as const,
				translatedFrom: "eng" as const,
			};
		};
		const sortLabel = makeTranslationUnitId("column", FEELING, "sort-label");
		const header = makeTranslationUnitId("column", NAME, "header");
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: {
				spa: {
					[sortLabel]: entry(sortLabel, "Se siente mal"),
					[header]: entry(header, "Nombre"),
				},
			},
		};
		const projected = projectWorkerModule(doc, "spa", MODULE)?.caseListConfig;
		if (projected === undefined) throw new Error("Expected the list.");
		expect(listed(projected, ANDROID).map((option) => option.name)).toEqual([
			"Nombre",
			"Village",
			"Visited",
			"Se siente mal",
		]);
	});
});
