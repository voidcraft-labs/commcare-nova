/**
 * An ordering on a time of day is never true on a device, so the gate
 * refuses it in form logic under `XPATH_TIME_ORDERING`. Each shape the
 * operand table names is refused beside an accepted neighbour, and the last
 * test holds the gate to a finding at every carrier `authoredXPathCarriers`
 * lists, so a carrier the registry gains later fails here until it is
 * planted.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type DocSpec,
	type FieldSpec,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { authoredXPathCarriers } from "@/lib/commcare/xpath/carriers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { ValidationError } from "../errors";
import { runValidation } from "../runner";
import { findTimeOrderingComparisons } from "../timeOrdering";

const SURVEY_MODULE = testUuid("time-ordering-survey-module");
const CASE_MODULE = testUuid("time-ordering-case-module");
const FOLLOWUP = testUuid("time-ordering-followup");

function surveyDoc(
	fields: FieldSpec[],
	form: Partial<FormSpec> = {},
	spec: Pick<DocSpec, "connectType" | "caseTypes"> = {},
): BlueprintDoc {
	return buildDoc({
		appName: "Time ordering",
		...spec,
		modules: [
			{
				uuid: SURVEY_MODULE,
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", label: proseText("Name") }),
							...fields,
						],
						...form,
					},
				],
			},
			{
				uuid: CASE_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FOLLOWUP,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
		caseTypes: spec.caseTypes ?? [{ name: "patient", properties: [] }],
	});
}

const ROWS: FieldSpec[] = [
	f({ kind: "text", id: "row_note", label: proseText("Row note") }),
];

/** One document per carrier, each holding the root read in that carrier
 * alone, named by the slot `authoredXPathCarriers` gives it. */
const PLANTED: ReadonlyArray<
	readonly [slot: string, build: () => BlueprintDoc]
> = [
	[
		"relevant",
		() =>
			surveyDoc([
				f({
					kind: "text",
					id: "shown",
					label: proseText("Shown"),
					relevant: "'09:00' > 1",
				}),
			]),
	],
	[
		"validate",
		() =>
			surveyDoc([
				f({
					kind: "text",
					id: "checked",
					label: proseText("Checked"),
					validate: "'09:00' > 1",
				}),
			]),
	],
	[
		"calculate",
		() =>
			surveyDoc([
				f({ kind: "hidden", id: "total", calculate: "if('09:00' > 1, 1, 0)" }),
			]),
	],
	[
		"default_value",
		() =>
			surveyDoc([
				f({
					kind: "int",
					id: "seeded",
					label: proseText("Seeded"),
					default_value: "if('09:00' > 1, 1, 0)",
				}),
			]),
	],
	[
		"required",
		() =>
			surveyDoc([
				f({
					kind: "text",
					id: "needed",
					label: proseText("Needed"),
					required: "'09:00' > 1",
				}),
			]),
	],
	[
		"repeat_count",
		() =>
			surveyDoc([
				f({
					kind: "repeat",
					id: "rows",
					label: proseText("Rows"),
					repeat_mode: "count_bound",
					repeat_count: "if('09:00' > 1, 1, 0)",
					children: ROWS,
				}),
			]),
	],
	[
		"ids_query",
		() =>
			surveyDoc([
				f({
					kind: "repeat",
					id: "items",
					label: proseText("Items"),
					repeat_mode: "query_bound",
					data_source: { ids_query: "if('09:00' > 1, 'a', 'b')" },
					children: ROWS,
				}),
			]),
	],
	[
		"assessment_user_score",
		() =>
			surveyDoc(
				[],
				{
					connect: {
						assessment: { id: "quiz", user_score: "if('09:00' > 1, 1, 0)" },
					} as never,
				},
				{ connectType: "learn" },
			),
	],
	[
		"deliver_entity_id",
		() =>
			surveyDoc(
				[],
				{
					connect: {
						deliver_unit: {
							id: "home_visit",
							name: "Home visit",
							entity_id: "if('09:00' > 1, 'a', 'b')",
						},
					} as never,
				},
				{ connectType: "deliver" },
			),
	],
	[
		"deliver_entity_name",
		() =>
			surveyDoc(
				[],
				{
					connect: {
						deliver_unit: {
							id: "home_visit",
							name: "Home visit",
							entity_name: "if('09:00' > 1, 'a', 'b')",
						},
					} as never,
				},
				{ connectType: "deliver" },
			),
	],
	[
		"form_link_condition",
		() =>
			surveyDoc([], {
				postSubmit: "app_home",
				formLinks: [
					{
						condition: "'09:00' > 1",
						target: { type: "module", moduleUuid: CASE_MODULE },
					},
				],
			}),
	],
	[
		"form_link_datum_xpath",
		() =>
			surveyDoc([], {
				formLinks: [
					{
						target: {
							type: "form",
							moduleUuid: CASE_MODULE,
							formUuid: FOLLOWUP,
						},
						datums: [{ name: "case_id", xpath: "if('09:00' > 1, 'a', 'b')" }],
					},
				],
			}),
	],
	[
		"case_property_required",
		() =>
			surveyDoc(
				[],
				{},
				{
					caseTypes: [
						{
							name: "patient",
							properties: [
								{
									name: "age",
									label: proseText("Age"),
									required: "'09:00' > 1",
								},
							],
						},
					],
				},
			),
	],
	[
		"case_property_validation",
		() =>
			surveyDoc(
				[],
				{},
				{
					caseTypes: [
						{
							name: "patient",
							properties: [
								{
									name: "age",
									label: proseText("Age"),
									validation: "'09:00' > 1",
								},
							],
						},
					],
				},
			),
	],
];

function findings(doc: BlueprintDoc): ValidationError[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}

const CHECKED = testUuid("time-ordering-checked");

/** A follow-up form over a case type with a time and a date property,
 * holding two time questions, a date, a number and two hidden values, and a
 * label whose display condition is the expression under test. */
function shapes(relevant: string): BlueprintDoc {
	return buildDoc({
		appName: "Time ordering",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "visit_time",
						label: proseText("Visit time"),
						data_type: "time",
					},
					{ name: "dob", label: proseText("Birth date"), data_type: "date" },
				],
			},
		],
		modules: [
			{
				uuid: CASE_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FOLLOWUP,
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "time", id: "start", label: proseText("Start") }),
							f({ kind: "time", id: "end", label: proseText("End") }),
							f({ kind: "date", id: "day", label: proseText("Day") }),
							f({ kind: "int", id: "count", label: proseText("Count") }),
							f({ kind: "hidden", id: "start_copy", calculate: "#form/start" }),
							f({
								kind: "hidden",
								id: "doubled",
								calculate: "#form/count * 2",
							}),
							f({
								uuid: CHECKED,
								kind: "label",
								id: "checked",
								label: proseText("Checked"),
								relevant,
							}),
						],
					},
				],
			},
		],
	});
}

function ordersTime(relevant: string): boolean {
	const doc = shapes(relevant);
	const field = doc.fields[CHECKED];
	const expression = field && "relevant" in field ? field.relevant : undefined;
	if (expression === undefined) throw new Error("No display condition.");
	return (
		findTimeOrderingComparisons(expression, {
			doc,
			formUuid: FOLLOWUP,
		}).length > 0
	);
}

describe("an ordering on a time of day", () => {
	it.each([
		["a time question", "#form/start < #form/end"],
		["a time question on the right", "3 >= #form/start"],
		["a time question by its path", "/data/start <= 3"],
		["a hidden value whose calculate is a time", "#form/start_copy > 3"],
		["a time case property", "#patient/visit_time > 3"],
		["text holding a colon", "#form/count < '09:00'"],
		["a date and time written as text", "#form/day > '2026-01-01T10:00:00'"],
		["a branch of if()", "if(#form/count > 1, #form/start, '') < 3"],
		["an argument of coalesce()", "coalesce(#form/count, #form/end) < 3"],
		["a parenthesized time", "(#form/start) > 3"],
	])("refuses %s", (_name, relevant) => {
		expect(ordersTime(relevant)).toBe(true);
	});

	it.each([
		["a time compared with =", "#form/start = #form/end"],
		["a date ordered", "#form/day > today()"],
		["a date property ordered", "#patient/dob < today()"],
		["a hidden value whose calculate is a number", "#form/doubled > 3"],
		["text with no colon", "#form/count < '9'"],
		["a time inside the condition of if()", "if(#form/start = '', 1, 2) > 0"],
	])("accepts %s", (_name, relevant) => {
		expect(ordersTime(relevant)).toBe(false);
	});

	it("is refused at the field's slot with its own code and sentence", () => {
		const refused = findings(shapes("#form/start < #form/end")).filter(
			(error) => error.code === "XPATH_TIME_ORDERING",
		);
		expect(refused).toHaveLength(1);
		expect(refused[0]?.location.fieldId).toBe("checked");
		expect(userFacingError(refused[0] as ValidationError)).toBe(
			`A formula on "checked" in "Visit" compares a time of day with before or after. CommCare compares these as numbers and a time is not one, so it would never be true. Compare a date instead, or check a time with equals.`,
		);
	});

	it("is refused in a catalog property's condition at app scope", () => {
		const refused = findings(
			(
				PLANTED.find(([slot]) => slot === "case_property_validation")?.[1] ??
				(() => surveyDoc([]))
			)(),
		).filter((error) => error.code === "XPATH_TIME_ORDERING");
		expect(refused.map((error) => [error.scope, error.details])).toEqual([
			["app", { caseType: "patient", property: "age", slot: "validation" }],
		]);
		expect(userFacingError(refused[0] as ValidationError)).toBe(
			`The validation rule of "age" compares a time of day with before or after. CommCare compares these as numbers and a time is not one, so it would never be true. Compare a date instead, or check a time with equals.`,
		);
	});

	it("is refused at every registered expression carrier", () => {
		const registered = new Set([
			...FIELD_REFERENCE_SLOTS.filter((slot) => slot.kind === "xpath-ast").map(
				(slot) => slot.slot,
			),
			...FORM_REFERENCE_SLOTS.filter((slot) => slot.kind === "xpath-ast").map(
				(slot) => slot.slot,
			),
			"case_property_required",
			"case_property_validation",
		]);
		expect(new Set(PLANTED.map(([slot]) => slot))).toEqual(registered);
		expect(findings(surveyDoc([]))).toEqual([]);

		for (const [slot, build] of PLANTED) {
			const doc = build();
			expect(
				authoredXPathCarriers(doc)
					.filter((carrier) => carrier.source.includes("'09:00'"))
					.map((carrier) => carrier.slot),
				slot,
			).toEqual([slot]);
			expect(
				findings(doc).some((error) => error.code === "XPATH_TIME_ORDERING"),
				slot,
			).toBe(true);
		}
	});
});
