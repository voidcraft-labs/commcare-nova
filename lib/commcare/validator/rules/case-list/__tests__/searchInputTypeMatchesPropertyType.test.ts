import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	advancedSearchInputDef,
	type CasePropertyDataType,
	type SearchInputDef,
	type SearchInputType,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const scalarTypes: CasePropertyDataType[] = [
	"text",
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
	"geopoint",
	"single_select",
	"multi_select",
];
const code = "CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH";
function candidate(
	type: SearchInputType,
	dataType: CasePropertyDataType,
	advanced = false,
) {
	const base = admittedCaseListDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "value", label: proseText("Value"), data_type: dataType },
				],
			},
		],
	});
	const input: SearchInputDef = advanced
		? advancedSearchInputDef(
				testUuid("prompt"),
				"value",
				"Value",
				type,
				matchAll(),
			)
		: simpleSearchInputDef(testUuid("prompt"), "value", "Value", type, "value");
	const doc = withSearchInputs(base, [input]);
	// A single-date or multiple-choice Search field runs in Web Apps alone.
	return type === "date" || type === "multi-select"
		? {
				...doc,
				appSettings: { ...doc.appSettings, runsOnlyOn: "web-apps" as const },
			}
		: doc;
}
describe("search widget admission", () => {
	it.each(scalarTypes)("accepts text exact search over %s", (dataType) =>
		expect(findings(candidate("text", dataType))).toEqual([]),
	);
	it.each([
		{ type: "date", dataType: "date", codes: [] },
		{ type: "date", dataType: "datetime", codes: [] },
		{ type: "date", dataType: "time", codes: [code] },
		{ type: "date", dataType: "text", codes: [code] },
		{ type: "date-range", dataType: "date", codes: [] },
		{ type: "date-range", dataType: "datetime", codes: [] },
		{ type: "date-range", dataType: "int", codes: [code] },
		{ type: "barcode", dataType: "text", codes: [] },
		{ type: "barcode", dataType: "int", codes: [code] },
	] satisfies {
		type: SearchInputType;
		dataType: CasePropertyDataType;
		codes: string[];
	}[])("$type over $dataType", ({ type, dataType, codes }) => {
		const errors = findings(candidate(type, dataType));
		expect(errors.map((error) => error.code)).toEqual(codes);
		if (codes.length)
			expect(errors[0].details).toMatchObject({
				inputUuid: testUuid("prompt"),
				inputType: type,
				dataType,
				destinationCaseType: "patient",
			});
	});
	it("admits a date advanced prompt without inventing one target property", () =>
		expect(findings(candidate("date", "int", true))).toEqual([]));
});
