/**
 * Contract: every header locale id the local suite writes for a case list field is the id
 * CommCare HQ's build gives the column HQ JSON stores (`id_strings.py::detail_column_header_locale`):
 * `case_calculated_property_<position>` for a column stored with `useXpathExpression`, and
 * `case_<field>_<position>` otherwise. The failure it catches: a shown interval, link or
 * option-label column named after its property, whose id a labelled sort carrier over that
 * property (`case_<property>_<order>`) can equal, so the carrier's name in Sort by replaces the
 * column's header in every language of the `.ccz` while HQ's build of the same app keeps both.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { emitLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Column,
	columnSort,
	intervalColumn,
	linkColumn,
	plainColumn,
	proseText,
	tileCell,
} from "@/lib/domain";
import { mergeFieldStrings } from "../columns";

const NAME = testUuid("header-name");
const SHOWN = testUuid("header-shown");
const CARRIED = testUuid("header-carried");
const SHORT_CALCULATED = "m0.case_short.case_calculated_property_2.header";
const LONG_CALCULATED = "m0.case_long.case_calculated_property_2.header";

/**
 * A tile list of visits: the name and `shown` on Results, and a column over `shown`'s property
 * hidden from Results and Details whose rule, the list's only one, carries the name
 * "In Sort by" there. A hidden column is no field of a tile list, and where the shown column is
 * stored as an expression its join text is that expression, so the rule lands on a carrier of
 * order 1.
 */
function visits(shown: Extract<Column, { field: string }>): BlueprintDoc {
	const columns: Column[] = [
		{ ...plainColumn(NAME, "case_name", "Name"), tile: tileCell(0, 0, 4, 1) },
		{ ...shown, tile: tileCell(4, 0, 4, 1) },
		{
			...plainColumn(CARRIED, shown.field, "Carried", {
				visibleInList: false,
				visibleInDetail: false,
				sort: columnSort("desc", 0, undefined, "In Sort by"),
			}),
			tile: tileCell(8, 0, 4, 1),
		},
	];
	return buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "last_visit", label: "Last visit", data_type: "date" },
					{ name: "site", label: "Site" },
					{
						name: "risk",
						label: "Risk",
						data_type: "single_select",
						options: [
							{ value: "high", label: proseText("High") },
							{ value: "low", label: proseText("Low") },
						],
					},
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
							f({
								kind: "date",
								id: "last_visit",
								caseWrite: { caseType: "visit", property: "last_visit" },
							}),
							f({
								kind: "text",
								id: "site",
								caseWrite: { caseType: "visit", property: "site" },
							}),
						],
					},
				],
				caseListConfig: {
					columns,
					listColumnOrder: columns.map((column) => column.uuid),
					detailColumnOrder: columns.map((column) => column.uuid),
					searchInputs: [],
					tile: {},
				},
			},
		],
	});
}

const shapes: [string, Extract<Column, { field: string }>][] = [
	[
		"an interval",
		intervalColumn(
			SHOWN,
			"last_visit",
			"Since visit",
			7,
			"days",
			"flag",
			"Late",
		),
	],
	["a link", linkColumn(SHOWN, "site", "Since visit", "Open")],
];

describe("a shown column HQ JSON stores as an expression, beside a labelled carrier over its property", () => {
	for (const [name, shown] of shapes)
		it(`keeps ${name} column's header under HQ's calculated id and the carrier's name under its own`, () => {
			const doc = visits(shown);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const stored = expandDoc(doc).modules[0]?.case_details.short;
			expect(
				stored?.columns.find(
					(column) =>
						(column.header as Record<string, string>).en === "Since visit",
				)?.useXpathExpression,
			).toBe(true);

			const mod = doc.modules[doc.moduleOrder[0]];
			const short = emitShortDetail({ module: mod, moduleIndex: 0, doc });
			expect(short.strings[SHORT_CALCULATED]).toBe("Since visit");
			const carrierId = `m0.case_short.case_${shown.field}_2.header`;
			expect(short.strings[carrierId]).toBe("In Sort by");
			expect(short.translationUnits[SHORT_CALCULATED]).not.toEqual(
				short.translationUnits[carrierId],
			);

			const long = emitLongDetail({ module: mod, moduleIndex: 0, doc });
			expect(long.strings[LONG_CALCULATED]).toBe("Since visit");
		});

	it("names a plain column that shows its options' labels as HQ's calculated column, and one that does not by its field", () => {
		const labelled = visits(plainColumn(SHOWN, "risk", "Risk"));
		expect(runValidation(labelled, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const mod = labelled.modules[labelled.moduleOrder[0]];
		const short = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: labelled,
		});
		expect(short.strings[SHORT_CALCULATED]).toBe("Risk");
		expect(short.strings["m0.case_short.case_risk_2.header"]).toBe(
			"In Sort by",
		);

		const plain = visits(plainColumn(SHOWN, "last_visit", "Visited"));
		const plainMod = plain.modules[plain.moduleOrder[0]];
		const plainShort = emitShortDetail({
			module: plainMod,
			moduleIndex: 0,
			doc: plain,
		});
		// A plain property column is HQ's stored field: the carrier joins it by
		// that text, so no carrier is written and the column keeps its own id.
		expect(plainShort.strings["m0.case_short.case_last_visit_2.header"]).toBe(
			"Visited",
		);
	});
});

describe("the merge of a detail's field strings", () => {
	it("refuses a locale id another field of the detail already wrote", () => {
		const strings: Record<string, string> = {};
		const units = {};
		mergeFieldStrings(strings, units, {
			strings: { "m0.case_short.case_x_2.header": "One" },
			translationUnits: {},
		});
		expect(() =>
			mergeFieldStrings(strings, units, {
				strings: { "m0.case_short.case_x_2.header": "Two" },
				translationUnits: {},
			}),
		).toThrow(/two fields of one case list detail/);
		expect(strings["m0.case_short.case_x_2.header"]).toBe("One");
	});
});
