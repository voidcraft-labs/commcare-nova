/**
 * The otherwise link is a link to every reader that addresses one: its
 * uuid is an authored identity in the links' namespace, its carried values
 * are `form_link_datum_xpath` slots addressed by its uuid, and the checker
 * reads them against its resolved target. It has no condition. The
 * plausible failure is a reader that walks `formLinks` alone, which would
 * leave the otherwise's carried values unchecked, unindexed and unprinted.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	authoredBlueprintIdentities,
	type BlueprintDoc,
	expressionSlotValues,
} from "@/lib/domain";
import { literal, slotContext, term } from "@/lib/domain/expression";
import { formStructure } from "@/lib/domain/expression/formStructure";

const PATIENTS = testUuid("otherwise-patients");
const VISIT = testUuid("otherwise-visit");
const LINK = testUuid("otherwise-destination");
const OTHERWISE = testUuid("otherwise-link");
const datumName = { kind: "selected-case" as const, module: PATIENTS };
const carriedValue = term(literal("patient-id"));

function otherwiseDoc(): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: PATIENTS,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([]),
					forms: [{ uuid: VISIT, name: "Visit", type: "followup" }],
				},
			],
		},
		(doc) => {
			doc.forms[VISIT].formLinks = [
				{
					uuid: LINK,
					condition: term(literal("true")),
					target: { type: "module", moduleUuid: PATIENTS },
				},
			];
			doc.forms[VISIT].otherwise = {
				kind: "link",
				uuid: OTHERWISE,
				target: { type: "this-form" },
				datums: [{ name: datumName, xpath: carriedValue }],
			};
		},
	);
}

const datumSlot = {
	entity: "form" as const,
	uuid: VISIT,
	slot: "form_link_datum_xpath" as const,
	member: { linkUuid: OTHERWISE, datum: datumName },
};

describe("the otherwise link's slots", () => {
	it("registers its uuid as a form link identity of its form", () => {
		expect(authoredBlueprintIdentities(otherwiseDoc())).toContainEqual({
			uuid: OTHERWISE,
			kind: "formLink",
			ownerUuid: VISIT,
		});
	});

	it("yields its carried values under the link datum slot, addressed by its uuid", () => {
		const values = expressionSlotValues(otherwiseDoc(), {
			entity: "form",
			uuid: VISIT,
		});
		expect(values).toContainEqual({
			ref: datumSlot,
			expression: carriedValue,
			path: ["otherwise", "datums", 0, "xpath"],
		});
	});

	it("is a link of the form's structure, marked as the otherwise", () => {
		const structure = formStructure(otherwiseDoc(), VISIT);
		expect(structure?.links.get(OTHERWISE)).toEqual({
			target: { type: "this-form" },
			datums: [datumName],
			role: "otherwise",
		});
		expect(structure?.links.get(LINK)?.role).toBeUndefined();
	});

	it("checks a carried value against this form's own selection", () => {
		const ctx = slotContext(otherwiseDoc(), datumSlot, new Map());
		expect(ctx?.targetSupplies?.refs).toEqual([
			{ ref: datumName, scalar: true },
		]);
	});

	it("has no condition slot", () => {
		expect(
			slotContext(
				otherwiseDoc(),
				{
					entity: "form",
					uuid: VISIT,
					slot: "form_link_condition",
					member: { linkUuid: OTHERWISE },
				},
				new Map(),
			),
		).toBeUndefined();
	});
});
