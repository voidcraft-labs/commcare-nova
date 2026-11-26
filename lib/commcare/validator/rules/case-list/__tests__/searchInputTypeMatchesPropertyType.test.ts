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
	// The project space's own matching rule matches a field with its matching over any type: a
	// date range over text reads the date its index reads from the stored text.
	it.each([
		["date-range", "text"],
		["date-range", "int"],
		["barcode", "int"],
	] satisfies [SearchInputType, CasePropertyDataType][])(
		"admits %s over %s with the project space's matching, and offers it where Nova's refuses",
		(type, dataType) => {
			const refused = findings(candidate(type, dataType)).filter(
				(error) => error.code === code,
			);
			expect(refused[0]?.details).toMatchObject({
				projectSpaceCanMatch: "true",
			});
			const doc = candidate(type, dataType);
			const module = doc.modules[doc.moduleOrder[0]];
			const config = module.caseListConfig;
			if (config === undefined) throw new Error("The fixture lists cases.");
			const native = {
				...doc,
				modules: {
					...doc.modules,
					[module.uuid]: {
						...module,
						caseListConfig: {
							...config,
							searchInputs: config.searchInputs.map((input) => ({
								...input,
								matching: "project-space" as const,
							})),
						},
					},
				},
			};
			expect(findings(native)).toEqual([]);
		},
	);
	it("offers no project space matching to a field that searches another property", () => {
		const base = admittedCaseListDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "value", label: proseText("Value"), data_type: "text" },
					],
				},
			],
		});
		const errors = findings(
			withSearchInputs(base, [
				simpleSearchInputDef(
					testUuid("prompt"),
					"seen",
					"Seen",
					"barcode",
					"value",
				),
			]),
		).filter((error) => error.code === code);
		expect(errors).toEqual([]);
		const int = admittedCaseListDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "value", label: proseText("Value"), data_type: "int" },
					],
				},
			],
		});
		const refused = findings(
			withSearchInputs(int, [
				simpleSearchInputDef(
					testUuid("prompt"),
					"seen",
					"Seen",
					"barcode",
					"value",
				),
			]),
		).filter((error) => error.code === code);
		expect(refused).toHaveLength(1);
		expect(refused[0]?.details?.projectSpaceCanMatch).toBeUndefined();
	});
	it("admits a date advanced prompt without inventing one target property", () =>
		expect(findings(candidate("date", "int", true))).toEqual([]));
});
