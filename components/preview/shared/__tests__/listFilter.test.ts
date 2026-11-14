// The list's filter box over production columns and the list's own order
// plan: which fields fuzzy search reads (a field's sort text, which a field
// with no sort key lacks and a carrier holds as its raw value), the order each
// platform shows the matches in, and what an empty or all-space box does.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type ListFilterOptions,
	rowsMatchingFilterText,
} from "@/components/preview/shared/listFilter";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type CaseListConfig,
	type Column,
	plainColumn,
	proseText,
	tileCell,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { ColumnDisplayContext } from "@/lib/preview/columnDisplay";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { previewCaseListOrderPlan } from "@/lib/preview/engine/caseListOrder";
import { previewPlatformRules } from "@/lib/preview/platform";

const NAME = testUuid("list-filter-name");
const VILLAGE = testUuid("list-filter-village");

const DISPLAY: ColumnDisplayContext = {
	calculatedTemporalTypes: new Map(),
	caseProperties: [],
	today: new Date("2026-05-06T12:00:00Z"),
	projectProse: (template) =>
		projectProseTemplate(template, { fields: {}, forms: {}, fieldOrder: {} })
			.text,
};

const WEB_APPS = previewPlatformRules("web-apps").listFilter;
const ANDROID = previewPlatformRules("android").listFilter;

function client(
	id: string,
	name: string,
	village?: string,
): CaseRowWithCalculated {
	return {
		case_id: id,
		case_type: "client",
		case_name: name,
		app_id: "app",
		owner_id: "worker",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		external_id: null,
		parent_case_id: null,
		properties: village === undefined ? {} : { village },
		calculated: {},
	} as CaseRowWithCalculated;
}

/** The list's shown columns and its order plan, as the running list reads them. */
function listOf(columns: Column[], tile: boolean) {
	const config: CaseListConfig = {
		columns,
		listColumnOrder: columns.map((column) => column.uuid),
		detailColumnOrder: columns.map((column) => column.uuid),
		searchInputs: [],
		...(tile && { tile: {} }),
	};
	const doc = buildDoc({
		appName: "Clients",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Clients",
				caseType: "client",
				caseListMenuItem: {},
				caseListConfig: config,
			},
		],
	});
	const mod = doc.modules[doc.moduleOrder[0]];
	return {
		shown: columns.filter((column) => column.visibleInList !== false),
		plan: previewCaseListOrderPlan(mod, doc, config),
	};
}

/** A list of names, ordered by name, and a shown village with no sort key. */
const namesAndVillages = () =>
	listOf(
		[
			plainColumn(NAME, "case_name", "Name", {
				sort: { direction: "asc", priority: 0 },
			}),
			plainColumn(VILLAGE, "village", "Village"),
		],
		false,
	);

function filtered(
	list: ReturnType<typeof listOf>,
	rows: readonly CaseRowWithCalculated[],
	text: string,
	options: ListFilterOptions,
): string[] {
	return rowsMatchingFilterText(
		list.shown,
		rows,
		text,
		DISPLAY,
		list.plan,
		options,
	).map((row) => row.case_id);
}

describe("the fields fuzzy search reads", () => {
	const amina = client("amina", "Amina", "Riverside");

	it("never matches a near miss on a field that keeps no sort key", () => {
		// The village is shown, holds no rule and keeps no key, so the device
		// has no sort text to read a near miss against.
		expect(
			filtered(namesAndVillages(), [amina], "rivrside", {
				fuzzy: true,
				rules: WEB_APPS,
				edited: true,
			}),
		).toEqual([]);
		// Its shown text still matches the exact term.
		expect(
			filtered(namesAndVillages(), [amina], "riverside", {
				fuzzy: true,
				rules: WEB_APPS,
				edited: true,
			}),
		).toEqual(["amina"]);
	});

	it("matches a near miss on a carrier's raw value", () => {
		// In a tile list an order rule on a column hidden from Results is a
		// carrier, whose raw value is its own sort text.
		const tileList = listOf(
			[
				plainColumn(NAME, "case_name", "Name", { tile: tileCell(0, 0, 12, 1) }),
				plainColumn(VILLAGE, "village", "Village", {
					visibleInList: false,
					sort: { direction: "asc", priority: 0 },
				}),
			],
			true,
		);
		expect(tileList.plan.carriers.map((carrier) => carrier.property)).toEqual([
			"village",
		]);
		expect(
			filtered(tileList, [amina], "rivrside", {
				fuzzy: true,
				rules: WEB_APPS,
				edited: true,
			}),
		).toEqual(["amina"]);
		expect(
			filtered(tileList, [amina], "rivrside", {
				fuzzy: false,
				rules: WEB_APPS,
				edited: true,
			}),
		).toEqual([]);
	});

	it("matches a near miss on a sorted field's words", () => {
		expect(
			filtered(namesAndVillages(), [client("a", "Amina Smyth")], "smith", {
				fuzzy: true,
				rules: WEB_APPS,
				edited: true,
			}),
		).toEqual(["a"]);
	});
});

describe("the order of the matches", () => {
	// The near miss comes first in the list's own order.
	const rows = [client("smyth", "Ann Smyth"), client("smith", "Ann Smith")];

	it("keeps the given order with fuzzy search off", () => {
		expect(
			filtered(namesAndVillages(), rows, "ann", {
				fuzzy: false,
				rules: ANDROID,
				edited: true,
			}),
		).toEqual(["smyth", "smith"]);
	});

	it("puts an exact match first on Android, closest first", () => {
		expect(
			filtered(namesAndVillages(), rows, "smith", {
				fuzzy: true,
				rules: ANDROID,
				edited: true,
			}),
		).toEqual(["smith", "smyth"]);
	});

	it("leaves the list's own order in Web Apps", () => {
		expect(
			filtered(namesAndVillages(), rows, "smith", {
				fuzzy: true,
				rules: WEB_APPS,
				edited: true,
			}),
		).toEqual(["smyth", "smith"]);
	});
});

describe("an empty or all-space box", () => {
	const rows = [client("amina", "Amina", "Riverside"), client("blank", "")];

	it("keeps every row for text of spaces alone, on both platforms", () => {
		for (const rules of [WEB_APPS, ANDROID])
			expect(
				filtered(namesAndVillages(), rows, "   ", {
					fuzzy: false,
					rules,
					edited: true,
				}),
			).toEqual(["amina", "blank"]);
	});

	it("keeps every row for an empty text in Web Apps, edited or not", () => {
		expect(
			filtered(namesAndVillages(), rows, "", {
				fuzzy: false,
				rules: WEB_APPS,
				edited: true,
			}),
		).toEqual(["amina", "blank"]);
	});

	it("keeps every row on Android until the worker has edited the box", () => {
		expect(
			filtered(namesAndVillages(), rows, "", {
				fuzzy: false,
				rules: ANDROID,
				edited: false,
			}),
		).toEqual(["amina", "blank"]);
	});

	it("drops a row whose every field is blank on Android once the box was edited and emptied", () => {
		expect(
			filtered(namesAndVillages(), rows, "", {
				fuzzy: false,
				rules: ANDROID,
				edited: true,
			}),
		).toEqual(["amina"]);
	});
});
