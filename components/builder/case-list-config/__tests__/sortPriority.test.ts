// Default order's Add menu puts a choice's column to the gate's order rules
// (`caseListOrderChoiceRefusal`) and commits the columns the composer builds
// for it (`columnsAfterRuleSequence`, diffed by
// `columnSnapshotBatchMutations`). A field that is off the list is the case
// where the two can part: the menu's answer and the commit must agree in a
// list with no tile and in a tile list.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { columnSnapshotBatchMutations } from "@/lib/doc/caseListColumnMutations";
import {
	caseListOrderChoiceRefusal,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { offeredChoiceRefusal } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	type Column,
	columnSort,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import {
	columnsAfterRuleSequence,
	orderChoiceColumn,
	resolveSortedColumns,
} from "../sortPriority";

const NAME = testUuid("order-choice-name");
const ZONE = testUuid("order-choice-zone");
const VILLAGE = testUuid("order-choice-village");

function docWith(tile: boolean): BlueprintDoc {
	return buildDoc({
		appName: "Villages",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "zone", label: "Zone", data_type: "text" },
					{ name: "village", label: "Village", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(NAME, "case_name", "Name", {
							tile: tileCell(0, 0, 6, 1),
						}),
						plainColumn(ZONE, "zone", "Zone", {
							visibleInList: false,
							sort: { direction: "desc", priority: 0 },
						}),
						plainColumn(VILLAGE, "village", "Village", {
							visibleInList: false,
							notOnList: true,
						}),
					],
					searchInputs: [],
					...(tile && { tile: {} }),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
}

/** What choosing the off-list Village in the Add menu asks and commits. */
function chooseVillage(doc: BlueprintDoc) {
	const moduleUuid = doc.moduleOrder[0];
	const config = doc.modules[moduleUuid].caseListConfig;
	if (config === undefined) throw new Error("Missing case list");
	const stored = config.columns.find((column) => column.uuid === VILLAGE);
	if (stored === undefined) throw new Error("Missing Village");
	const sorted = resolveSortedColumns(config);
	const rule = {
		...orderChoiceColumn(stored, config.tile !== undefined),
		sort: columnSort("asc", sorted.length),
	} as Column;
	const verdict = mutationCommitVerdict(
		doc,
		columnSnapshotBatchMutations(
			moduleUuid,
			config,
			columnsAfterRuleSequence(config.columns, [...sorted, rule]),
		),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return {
		refusal: caseListOrderChoiceRefusal(doc, moduleUuid, rule),
		verdict,
		committed: verdict.nextDoc.modules[moduleUuid].caseListConfig?.columns,
	};
}

describe("a Default order choice over a field that is off the list", () => {
	it("in a tile list is offered, and choosing it puts the field back on the list, hidden, with the rule", () => {
		const { refusal, verdict, committed } = chooseVillage(docWith(true));
		expect(refusal).toBeUndefined();
		expect(verdict.ok).toBe(true);
		const village = committed?.find((column) => column.uuid === VILLAGE);
		expect(village?.visibleInList).toBe(false);
		expect(village?.notOnList).toBeUndefined();
		expect(village?.sort).toEqual({ direction: "asc", priority: 1 });
		expect(committed?.find((column) => column.uuid === ZONE)?.sort).toEqual({
			direction: "desc",
			priority: 0,
		});
	});

	it("in a list with no tile is withheld with the line the commit's refusal gives", () => {
		const { refusal, verdict } = chooseVillage(docWith(false));
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.findings).toEqual([
			expect.objectContaining({
				code: "CASE_LIST_COLUMN_NOT_ON_LIST_INVALID",
				details: expect.objectContaining({ reason: "sorted" }),
			}),
		]);
		expect(refusal).toBe(offeredChoiceRefusal(verdict.findings));
		expect(refusal).toBe(
			"This isn't on the list, so the list can't sort by it. You can turn on List search matches this to sort by it.",
		);
	});
});

describe("columnsAfterRuleSequence", () => {
	it("renumbers the rules by place, keeps each one's direction and leaves a column no rule names unsorted", () => {
		const doc = docWith(false);
		const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
		if (config === undefined) throw new Error("Missing case list");
		const name = config.columns[0];
		const zone = config.columns[1];
		const next = columnsAfterRuleSequence(config.columns, [name]);
		expect(next.map((column) => column.uuid)).toEqual([NAME, ZONE, VILLAGE]);
		expect(next[0]?.sort).toEqual({ direction: "asc", priority: 0 });
		expect(next[1]?.sort).toBeUndefined();
		expect(next[2]).toBe(config.columns[2]);
		expect(
			columnsAfterRuleSequence(config.columns, [name, zone]).map(
				(column) => column.sort,
			),
		).toEqual([
			{ direction: "asc", priority: 0 },
			{ direction: "desc", priority: 1 },
			undefined,
		]);
	});
});
