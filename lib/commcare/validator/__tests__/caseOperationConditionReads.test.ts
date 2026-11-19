// The commit gate over a case change's condition that reads one answer alone,
// the shape CommCare HQ's Case Management writes as `boolean_true`. The gate
// admits it where the answer is a yes or no CommCare holds, a Hidden Value a
// condition calculates, and refuses it where the answer is text, whose `0`
// or `false` a device reads as true. Plausible failure: the gate refusing
// what a starter app made in CommCare HQ holds, or admitting a text answer.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formField, literal, term } from "@/lib/domain/expression/builders";
import { runValidation } from "../runner";

const FORM = testUuid("condition-reads-form");
const NOTE = testUuid("condition-reads-note");
const FLAG = testUuid("condition-reads-flag");
const TEXT_FLAG = testUuid("condition-reads-text-flag");
const REFERRAL = testUuid("condition-reads-referral");

function doc(conditionField: Uuid): BlueprintDoc {
	const built = buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "referral", properties: [] },
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						uuid: FORM,
						name: "Inspection",
						type: "followup",
						fields: [
							f({ uuid: NOTE, kind: "text", id: "note", label: "Note" }),
							f({
								uuid: FLAG,
								kind: "hidden",
								id: "create_referral",
								calculate: "#form/note != ''",
							}),
							f({
								uuid: TEXT_FLAG,
								kind: "hidden",
								id: "referral_text",
								calculate: "if(#form/note != '', 'yes', '')",
							}),
						],
					},
				],
			},
		],
	});
	const form = built.forms[FORM];
	return {
		...built,
		forms: {
			...built.forms,
			[FORM]: {
				...form,
				caseOperations: [
					...(form.caseOperations ?? []),
					{
						uuid: REFERRAL,
						id: "referral",
						action: "create",
						caseType: "referral",
						target: { kind: "new" },
						name: term(literal("Referral")),
						condition: term(formField(conditionField)),
					},
				],
			},
		},
	};
}

const codes = (field: Uuid) =>
	runValidation(doc(field), LOOKUP_CONTEXT_UNAVAILABLE).map(
		(error) => error.code,
	);

describe("a case change's condition reading one answer alone", () => {
	it("is admitted where a condition calculates the answer", () => {
		expect(codes(FLAG)).not.toContain("CASE_OPERATION_EXPRESSION_TYPE");
	});

	it.each([
		["a text question", NOTE],
		["a Hidden Value calculated as text", TEXT_FLAG],
	])("is refused where it reads %s", (_, field) => {
		expect(codes(field)).toContain("CASE_OPERATION_EXPRESSION_TYPE");
	});
});
