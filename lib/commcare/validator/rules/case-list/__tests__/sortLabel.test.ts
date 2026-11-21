// A sort rule's name in Sort by stands only where a worker reads it: on a
// column hidden from Results whose rule lands on a hidden field or a carrier.
// The gate refuses a name CommCare HQ reads as blank, one on a shown column,
// and one whose rule lands on an earlier shown column over the same value,
// each with its reason; a name of characters a device trims away is the
// schema's to refuse, and a name a device shows otherwise the app string
// rule's.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type Column,
	columnSort,
	columnSortSchema,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

const NAME = testUuid("sort-label-name");
const AGE = testUuid("sort-label-age");
const SHOWN_AGE = testUuid("sort-label-shown-age");
const named = (text: string) => columnSort("desc", 0, undefined, text);

function docWith(columns: readonly Column[], tile = false): BlueprintDoc {
	const doc = buildDoc({
		appName: "Ages",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [...columns],
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
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}

const findingsFor = (columns: readonly Column[], tile = false) =>
	runValidation(docWith(columns, tile), LOOKUP_CONTEXT_UNAVAILABLE);

const nameColumn = plainColumn(NAME, "case_name", "Name", {
	tile: tileCell(0, 0, 12, 1),
});

describe("CASE_LIST_SORT_LABEL_NOT_SHOWN", () => {
	it("admits a name on a column hidden from Results, in a list and in a tile list", () => {
		expect(
			findingsFor([
				nameColumn,
				plainColumn(AGE, "age", "Age", {
					visibleInList: false,
					sort: named("Oldest first"),
				}),
			]),
		).toEqual([]);
		expect(
			findingsFor(
				[
					nameColumn,
					plainColumn(AGE, "age", "Age", {
						visibleInList: false,
						visibleInDetail: false,
						sort: named("Oldest first"),
					}),
				],
				true,
			),
		).toEqual([]);
	});

	it("refuses a name on a column shown on Results", () => {
		const result = findingsFor([
			nameColumn,
			plainColumn(AGE, "age", "Age", { sort: named("Oldest first") }),
		]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			code: "CASE_LIST_SORT_LABEL_NOT_SHOWN",
			details: {
				slot: "caseListConfig.columns[1].sort.label",
				columnUuid: AGE,
				reason: "shown",
			},
		});
		expect(result[0].message).toBe(
			`The "Age" column shows on Results, so workers already find it under its header in Sort by and its name there is never shown. You can remove the name, or hide the column on Results.`,
		);
	});

	it("refuses a name whose rule lands on an earlier shown column over the same value", () => {
		const result = findingsFor([
			nameColumn,
			plainColumn(SHOWN_AGE, "age", "Age"),
			plainColumn(AGE, "age", "Age again", {
				visibleInList: false,
				sort: named("Oldest first"),
			}),
		]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			code: "CASE_LIST_SORT_LABEL_NOT_SHOWN",
			details: {
				columnUuid: AGE,
				reason: "lands-on-shown",
				landingColumnUuid: SHOWN_AGE,
			},
		});
		expect(result[0].message).toBe(
			`The "Age again" column's sort rule lands on the "Age" column, which shows on Results, so Sort by lists it under that column's header and its name there is never shown. You can remove the name, or hide that column on Results.`,
		);
	});

	it("refuses a name CommCare HQ reads as blank, which its build lists under no name", () => {
		const result = findingsFor([
			nameColumn,
			plainColumn(AGE, "age", "Age", {
				visibleInList: false,
				sort: named("\u2003"),
			}),
		]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			code: "CASE_LIST_SORT_LABEL_NOT_SHOWN",
			details: { columnUuid: AGE, reason: "blank" },
		});
		expect(result[0].message).toBe(
			`The "Age" column's name in Sort by holds only spaces, so CommCare HQ lists it under no name. You can type a name, or remove it.`,
		);
	});

	it("refuses a name a device would show otherwise, by the app string rule", () => {
		const result = findingsFor([
			nameColumn,
			plainColumn(AGE, "age", "Age", {
				visibleInList: false,
				sort: named("Oldest first "),
			}),
		]);
		expect(result.map((finding) => finding.code)).toEqual([
			"APP_STRING_VALUE_UNREPRESENTABLE",
		]);
	});
});

describe("columnSortSchema's label", () => {
	it("admits a name with text and refuses one a device trims to nothing", () => {
		expect(
			columnSortSchema.safeParse({
				direction: "asc",
				priority: 0,
				label: "Age",
			}).success,
		).toBe(true);
		expect(
			columnSortSchema.safeParse({
				direction: "asc",
				priority: 0,
				label: " \t",
			}).success,
		).toBe(false);
	});
});
