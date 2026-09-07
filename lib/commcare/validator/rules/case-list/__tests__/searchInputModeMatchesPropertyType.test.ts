import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { f } from "@/lib/__tests__/docHelpers";
import {
	type CasePropertyDataType,
	type SearchInputMode,
	simpleSearchInputDef,
} from "@/lib/domain";
import { ancestorPath, relationStep } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const modeCode = "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH";
function candidate(mode: SearchInputMode, dataType: CasePropertyDataType) {
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
	const prompt =
		mode.kind === "range"
			? simpleSearchInputDef(
					testUuid("prompt"),
					"value",
					"Value",
					"date-range",
					"value",
					{ mode },
				)
			: simpleSearchInputDef(
					testUuid("prompt"),
					"value",
					"Value",
					"text",
					"value",
					{ mode },
				);
	return withSearchInputs(base, [prompt]);
}
describe("search match mode admission", () => {
	it.each([
		{ mode: { kind: "fuzzy" }, type: "text", codes: [] },
		{ mode: { kind: "fuzzy" }, type: "int", codes: [modeCode] },
		{ mode: { kind: "phonetic" }, type: "text", codes: [] },
		{ mode: { kind: "phonetic" }, type: "decimal", codes: [modeCode] },
		{ mode: { kind: "starts-with" }, type: "single_select", codes: [] },
		{ mode: { kind: "starts-with" }, type: "date", codes: [modeCode] },
		{ mode: { kind: "fuzzy-date" }, type: "date", codes: [] },
		{ mode: { kind: "fuzzy-date" }, type: "datetime", codes: [] },
		{ mode: { kind: "fuzzy-date" }, type: "int", codes: [modeCode] },
		{ mode: { kind: "range" }, type: "date", codes: [] },
		{
			mode: { kind: "range" },
			type: "text",
			codes: [modeCode, "CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH"],
		},
		{ mode: { kind: "exact" }, type: "geopoint", codes: [] },
	] satisfies {
		mode: SearchInputMode;
		type: CasePropertyDataType;
		codes: string[];
	}[])("$mode.kind over $type", ({ mode, type, codes }) => {
		const errors = findings(candidate(mode, type));
		expect(errors.map((error) => error.code)).toEqual(codes);
		if (codes.length > 0)
			expect(errors[0].details).toMatchObject({
				inputUuid: testUuid("prompt"),
				mode: mode.kind,
				propertyDataType: type,
			});
	});
	it("uses a writer-derived text property and standard datetime property", () => {
		const base = admittedCaseListDoc({
			fields: [
				f({
					kind: "text",
					id: "nickname",
					label: "Nickname",
					caseWrite: { caseType: "patient", property: "nickname" },
				}),
			],
		});
		for (const input of [
			simpleSearchInputDef(
				testUuid("p"),
				"nickname",
				"Name",
				"text",
				"nickname",
				{ mode: { kind: "fuzzy" } },
			),
			simpleSearchInputDef(
				testUuid("p"),
				"date_opened",
				"Opened",
				"date-range",
				"date_opened",
				{ mode: { kind: "range" } },
			),
		])
			expect(findings(withSearchInputs(base, [input]))).toEqual([]);
	});
	it("resolves the destination property type through a real parent relationship", () => {
		const base = admittedCaseListDoc({
			caseTypes: [
				{ name: "patient", parent_type: "household", properties: [] },
				{
					name: "household",
					properties: [
						{ name: "size", label: proseText("Size"), data_type: "int" },
					],
				},
			],
		});
		const result = findings(
			withSearchInputs(base, [
				simpleSearchInputDef(testUuid("p"), "size", "Size", "text", "size", {
					mode: { kind: "fuzzy" },
					via: ancestorPath(relationStep("parent")),
				}),
			]),
		);
		expect(result.map((error) => error.code)).toEqual([modeCode]);
		expect(result[0].details?.destinationCaseType).toBe("household");
	});
	it.each([undefined, { kind: "exact" } as const, { kind: "fuzzy" } as const])(
		"refuses an unknown property with mode %j",
		(mode) => {
			const result = findings(
				withSearchInputs(admittedCaseListDoc(), [
					simpleSearchInputDef(
						testUuid("p"),
						"ghost",
						"Ghost",
						"text",
						"ghost",
						{ mode },
					),
				]),
			);
			expect(result.map((error) => error.code)).toEqual([
				"CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY",
			]);
		},
	);
});
