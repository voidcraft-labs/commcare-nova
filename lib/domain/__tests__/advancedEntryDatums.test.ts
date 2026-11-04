/**
 * What the entry of a form of a menu emitted advanced supplies (part 02
 * §13.2): HQ's advanced entry gives a datum to every open action outside a
 * repeat, so a create a basic form keeps in Save to Case, with no session
 * value, has one there. Catches the checker refusing a read of a case the
 * wire's entry names (`new-child-case`), and the advanced reading leaking
 * into a menu still emitted basic. The wire half of the agreement is
 * `lib/commcare/__tests__/entryDatumAgreement.ts`, over the fuzz corpora.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	advancedEntryActions,
	carriedCreates,
	menuEmittedAdvanced,
} from "@/lib/domain/advancedEntryDatums";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { entryDatumSupplies } from "@/lib/domain/entryDatumSupplies";
import { datumRefKey } from "@/lib/domain/expression/types";
import type { CaseOperation } from "@/lib/domain/forms";

const HOUSEHOLDS = "advanced-entry-households";
const PATIENTS = "advanced-entry-patients";
const REGISTER = "advanced-entry-register";
const VISIT = "advanced-entry-visit";
const NAME = "advanced-entry-name";
const OWN = testUuid("advanced-entry-own");
const PATIENT = testUuid("advanced-entry-patient");

const nameRead = {
	kind: "term",
	term: { kind: "field", uuid: testUuid(NAME) },
} as const;

/** Households register a household and a patient with no link; with
 *  `link`, the registration's one after-submit link opens the patients'
 *  follow-up, which carries the new patient there. */
function householdDoc(link: boolean): BlueprintDoc {
	return buildDoc(
		{
			modules: [
				{
					uuid: HOUSEHOLDS,
					name: "Households",
					caseType: "household",
					forms: [
						{
							uuid: REGISTER,
							name: "Register",
							type: "registration",
							fields: [{ kind: "text", id: "name", uuid: NAME }],
							...(link && {
								formLinks: [
									{
										target: {
											type: "form",
											moduleUuid: testUuid(PATIENTS),
											formUuid: testUuid(VISIT),
										},
									},
								],
							}),
						},
					],
				},
				{
					uuid: PATIENTS,
					name: "Patients",
					caseType: "patient",
					forms: [{ uuid: VISIT, name: "Visit", type: "followup" }],
				},
			],
		},
		(doc) => {
			const operations: CaseOperation[] = [
				{ uuid: OWN, id: "household", action: "own", name: nameRead },
				{
					uuid: PATIENT,
					id: "patient",
					action: "create",
					caseType: "patient",
					target: { kind: "new" },
					name: nameRead,
				},
			];
			doc.forms[testUuid(REGISTER)].caseOperations = operations;
		},
	);
}

function supplied(doc: BlueprintDoc): string[] {
	return entryDatumSupplies(doc, {
		kind: "form",
		module: testUuid(HOUSEHOLDS),
		form: testUuid(REGISTER),
	})
		.refs.map(({ ref }) => datumRefKey(ref))
		.sort();
}

describe("the entry of a registration emitted advanced", () => {
	it("supplies the new case and the child its open action creates", () => {
		const doc = householdDoc(true);
		expect(carriedCreates(doc, testUuid(REGISTER))).toEqual(
			new Map([[PATIENT, expect.any(String)]]),
		);
		expect(menuEmittedAdvanced(doc, testUuid(HOUSEHOLDS))).toBe(true);
		expect(advancedEntryActions(doc, testUuid(REGISTER))).toEqual({
			opens: [
				{
					operationUuid: OWN,
					caseType: "household",
					own: true,
					repeat: undefined,
				},
				{
					operationUuid: PATIENT,
					caseType: "patient",
					own: false,
					repeat: undefined,
				},
			],
			workerLoad: false,
		});
		expect(supplied(doc)).toEqual(
			[
				datumRefKey({ kind: "new-case" }),
				datumRefKey({ kind: "new-child-case", caseType: "patient" }),
			].sort(),
		);
	});

	it("is read as basic without the link, and the unlinked child has no session value", () => {
		const doc = householdDoc(false);
		expect(carriedCreates(doc, testUuid(REGISTER)).size).toBe(0);
		expect(menuEmittedAdvanced(doc, testUuid(HOUSEHOLDS))).toBe(false);
		expect(supplied(doc)).toEqual([datumRefKey({ kind: "new-case" })]);
	});

	it("leaves the follow-up the link opens basic, with its one selection", () => {
		const doc = householdDoc(true);
		expect(menuEmittedAdvanced(doc, testUuid(PATIENTS))).toBe(false);
		expect(
			entryDatumSupplies(doc, {
				kind: "form",
				module: testUuid(PATIENTS),
				form: testUuid(VISIT),
			}).refs.map(({ ref }) => datumRefKey(ref)),
		).toEqual([
			datumRefKey({ kind: "selected-case", module: testUuid(PATIENTS) }),
		]);
	});
});
