/**
 * A read of the form's root alone (`/data`) is refused in every authored
 * XPath carrier.
 *
 * The root names the whole form, never a question, a number of rows or a
 * list of ids, and HQ's form builder reports it as an unknown question
 * (`#form`). The validator's path phase holds it to the rule every path
 * below it meets: in a field's slots and the Connect expressions under
 * `INVALID_REF` with `ref` `/data`, in a form link's slots as a read of the
 * closed form, and in a catalog property's `required` and `validation` under
 * `CASE_PROPERTY_REFERENCE_INVALID`. The last test holds the gate to a
 * finding at every carrier `authoredXPathCarriers` lists, and a carrier the registry gains later fails it until it is
 * planted here.
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
import { formRootReadPositions } from "@/lib/preview/xpath/dependencies";
import type { ValidationError } from "../errors";
import { runValidation } from "../runner";
import { SESSION_FORM_READ_MESSAGE } from "../xpathValidator";

const SURVEY_MODULE = testUuid("root-read-survey-module");
const CASE_MODULE = testUuid("root-read-case-module");
const FOLLOWUP = testUuid("root-read-followup");

function surveyDoc(
	fields: FieldSpec[],
	form: Partial<FormSpec> = {},
	spec: Pick<DocSpec, "connectType" | "caseTypes"> = {},
): BlueprintDoc {
	return buildDoc({
		appName: "Root read",
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
					relevant: "count(/data) > 0",
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
					validate: "count(/data) > 0",
				}),
			]),
	],
	[
		"calculate",
		() =>
			surveyDoc([
				f({ kind: "hidden", id: "total", calculate: "count(/data)" }),
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
					default_value: "count(/data)",
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
					required: "count(/data) > 0",
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
					repeat_count: "count(/data)",
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
					data_source: { ids_query: "/data" },
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
						assessment: { id: "quiz", user_score: "count(/data)" },
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
							entity_id: "string(/data)",
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
							entity_name: "string(/data)",
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
						condition: "count(/data) > 0",
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
						datums: [{ name: "case_id", xpath: "string(/data)" }],
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
									required: "count(/data) > 0",
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
									validation: "count(/data) > 0",
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

/** A finding that refuses the root read, in whichever voice its slot has. */
function refusesRootRead(error: ValidationError): boolean {
	if (error.code === "INVALID_REF") {
		return (
			error.details?.ref === "/data" ||
			error.message.includes(SESSION_FORM_READ_MESSAGE)
		);
	}
	return (
		error.code === "CASE_PROPERTY_REFERENCE_INVALID" &&
		error.message.includes("Catalog defaults cannot read a form answer")
	);
}

describe("a read of the form's root", () => {
	it("leaves the base document admitted", () => {
		expect(findings(surveyDoc([]))).toEqual([]);
	});

	it("refuses count(/data) in a calculate, with ref /data, beside count(/data/rows)", () => {
		const refused = findings(
			surveyDoc([
				f({ kind: "hidden", id: "total", calculate: "count(/data)" }),
			]),
		);
		expect(refused.map((error) => error.code)).toEqual(["INVALID_REF"]);
		expect(refused[0]?.details).toEqual({ ref: "/data" });
		expect(refused[0]?.location.fieldId).toBe("total");
		expect(refused[0]?.message).toBe(
			`Field "total" in "Intake" (calculated value) reads the whole form (/data), not a question. CommCare HQ's form builder shows it as an unknown question. You can read a question, a group or a repeat of this form instead.`,
		);
		expect(userFacingError(refused[0] as ValidationError)).toBe(
			`A formula on "total" in "Intake" reads the whole form, not a question. You can point it at a question, a group or a repeat instead.`,
		);

		const accepted = surveyDoc([
			f({
				kind: "repeat",
				id: "rows",
				label: proseText("Rows"),
				children: ROWS,
			}),
			f({ kind: "hidden", id: "total", calculate: "count(/data/rows)" }),
		]);
		expect(findings(accepted)).toEqual([]);
	});

	it("refuses it in a form link's condition as a read of the closed form", () => {
		const refused = findings(
			(
				PLANTED.find(([slot]) => slot === "form_link_condition")?.[1] ??
				(() => surveyDoc([]))
			)(),
		).filter(refusesRootRead);
		expect(refused).toHaveLength(1);
		expect(refused[0]?.message).toContain(SESSION_FORM_READ_MESSAGE);
		expect(refused[0]?.message).not.toContain("reads the whole form");
	});

	it.each(["required", "validation"])(
		"refuses it in a catalog property's %s under CASE_PROPERTY_REFERENCE_INVALID",
		(slot) => {
			const refused = findings(
				(
					PLANTED.find(([name]) => name === `case_property_${slot}`)?.[1] ??
					(() => surveyDoc([]))
				)(),
			);
			expect(refused.map((error) => error.code)).toEqual([
				"CASE_PROPERTY_REFERENCE_INVALID",
			]);
			expect(refused[0]?.details).toEqual({
				caseType: "patient",
				property: "age",
				slot,
			});
		},
	);

	it("is refused at every carrier the scan reads", () => {
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

		for (const [slot, build] of PLANTED) {
			const doc = build();
			const carriers = authoredXPathCarriers(doc).filter(
				(carrier) => formRootReadPositions(carrier.source).length > 0,
			);
			expect(
				carriers.map((carrier) => carrier.slot),
				slot,
			).toEqual([slot]);
			expect(findings(doc).some(refusesRootRead), slot).toBe(true);
		}
	});
});
