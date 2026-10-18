import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { literal, term } from "@/lib/domain/expression/builders";
import { formSchema } from "@/lib/domain/forms";
import type { Uuid } from "@/lib/domain/uuid";

const ROOT = testUuid("alias-root");
const CHILD = testUuid("alias-child");
const SOURCE = testUuid("alias-source");
const TARGET = testUuid("alias-target");
const LINK = testUuid("alias-link");

function linkedDoc(
	assignments: readonly { module: Uuid; value: string }[],
	distinct = false,
) {
	const doc = buildDoc({
		caseTypes: [
			{ name: "patient", properties: [] },
			...(distinct
				? [{ name: "visit", parent_type: "patient", properties: [] }]
				: []),
		],
		modules: [
			{
				uuid: ROOT,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: SOURCE,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
			{
				uuid: CHILD,
				name: "More visits",
				caseType: distinct ? "visit" : "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: TARGET,
						name: "Next visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	doc.modules[CHILD].parentModuleUuid = ROOT;
	if (distinct) doc.modules[CHILD].parentCaseModuleUuid = ROOT;
	doc.forms[SOURCE].formLinks = [
		{
			uuid: LINK,
			target: { type: "form", moduleUuid: CHILD, formUuid: TARGET },
			datums: assignments.map(({ module, value }) => ({
				name: { kind: "selected-case", module },
				xpath: term(literal(value)),
			})),
		},
	];
	return doc;
}

describe("carried values for aligned selections", () => {
	it.each([ROOT, CHILD])(
		"admits either preserved alias by itself: %s",
		(module) => {
			const doc = linkedDoc([{ module, value: "patient-1" }]);
			expect(
				evaluateCommit({
					nextDoc: doc,
					lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
				}),
			).toEqual({ ok: true });
		},
	);
	it.each(["patient-1", "patient-2"])(
		"refuses two values for one target even when the second is %s",
		(second) => {
			const doc = linkedDoc([
				{ module: ROOT, value: "patient-1" },
				{ module: CHILD, value: second },
			]);
			const original = structuredClone(doc.forms[SOURCE].formLinks);
			expect(formSchema.safeParse(doc.forms[SOURCE]).success).toBe(true);
			const verdict = evaluateCommit({
				nextDoc: doc,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			});
			expect(verdict.ok).toBe(false);
			if (verdict.ok)
				throw new Error(
					"The gate admitted two assignments to one selected case.",
				);
			expect(verdict.findings).toMatchObject([
				{
					code: "FORM_LINK_DATUM_TARGET_COLLISION",
					scope: "form",
					location: { formUuid: SOURCE },
					details: { linkUuid: LINK },
				},
			]);
			expect(userFacingError(verdict.findings[0])).toContain(
				"same selected case",
			);
			expect(doc.forms[SOURCE].formLinks).toEqual(original);
		},
	);
	it("admits values for two distinct selections in the target chain", () => {
		const doc = linkedDoc(
			[
				{ module: ROOT, value: "patient-1" },
				{ module: CHILD, value: "visit-1" },
			],
			true,
		);
		expect(
			evaluateCommit({
				nextDoc: doc,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}),
		).toEqual({ ok: true });
	});
});
