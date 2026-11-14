// The quick filter matches what a device's search matches, read from the
// list's order plan. A column that is not on the list is no field of it, so
// the filter matches nothing by its value; hidden and still on the list, it
// is a field again and the filter finds the case by it.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { rowMatchesFilterText } from "@/components/preview/shared/listFilter";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type CaseListConfig,
	type Column,
	type ColumnCommonSlots,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { ColumnDisplayContext } from "@/lib/preview/columnDisplay";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { previewCaseListOrderPlan } from "@/lib/preview/engine/caseListOrder";

const NAME = testUuid("filter-off-list-name");
const VILLAGE = testUuid("filter-off-list-village");

const DISPLAY: ColumnDisplayContext = {
	calculatedTemporalTypes: new Map(),
	caseProperties: [],
	today: new Date("2026-05-06T12:00:00Z"),
	projectProse: (template) =>
		projectProseTemplate(template, { fields: {}, forms: {}, fieldOrder: {} })
			.text,
};

const amina = {
	case_id: "11111111-1111-4111-8111-111111111111",
	case_type: "client",
	case_name: "Amina",
	app_id: "app",
	owner_id: "worker",
	status: "open",
	opened_on: null,
	modified_on: null,
	closed_on: null,
	external_id: null,
	parent_case_id: null,
	properties: { village: "Riverside" },
	calculated: {},
} as CaseRowWithCalculated;

/** Whether filtering the list for "Riverside" keeps Amina, with the village
 *  column in the given list state. */
function filterFindsVillage(slots: ColumnCommonSlots): boolean {
	const columns: Column[] = [
		plainColumn(NAME, "case_name", "Name"),
		plainColumn(VILLAGE, "village", "Village", slots),
	];
	const config: CaseListConfig = {
		columns,
		listColumnOrder: [NAME, VILLAGE],
		detailColumnOrder: [NAME, VILLAGE],
		searchInputs: [],
	};
	const doc = buildDoc({
		appName: "Villages",
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
	const shown = columns.filter((column) => column.visibleInList !== false);
	return rowMatchesFilterText(
		shown,
		amina,
		"Riverside",
		DISPLAY,
		previewCaseListOrderPlan(mod, doc, config),
	);
}

describe("the quick filter over a column that is not on the list", () => {
	it("matches no case by the column's value", () => {
		expect(filterFindsVillage({ visibleInList: false, notOnList: true })).toBe(
			false,
		);
	});

	it("matches the case once the column is hidden and on the list", () => {
		expect(filterFindsVillage({ visibleInList: false })).toBe(true);
	});
});
