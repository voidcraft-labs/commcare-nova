/**
 * The case list registration readers of `menuForms.ts` over the slot's two
 * arms, on documents built by the production fixture builder. The
 * `after-empty-search` arm's form is on no menu; the `always` arm's form is an
 * ordinary form of its own menu, and where a worker goes after registering
 * from the host's list follows the form's own after-submit while it has one.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "../blueprint";
import {
	afterEmptySearchRegistrationFormOf,
	alwaysOfferedRegistrationOf,
	caseListRegistrationReturnOf,
	caseListsOffering,
	menuFormUuidsOf,
	moduleIsCaseFirst,
	offeredRegistrationFormOf,
} from "../menuForms";
import type { CaseListRegistrationForm } from "../modules";
import { proseText } from "../prose";

const INTAKE = testUuid("menu-forms-intake");
const PATIENTS = testUuid("menu-forms-patients");
const CLINIC = testUuid("menu-forms-clinic");
const REGISTER = testUuid("menu-forms-register");
const VISIT = testUuid("menu-forms-visit");
const CHECKUP = testUuid("menu-forms-checkup");
const GONE = testUuid("menu-forms-gone");

const nameField = () =>
	f({
		kind: "text",
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType: "patient", property: "case_name" },
	});

function followup(uuid: string, name: string): FormSpec {
	return {
		uuid,
		name,
		type: "followup",
		fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
	};
}

/** Intake holds the registration form; Patients and Clinic list patients. */
function registry(register: Partial<FormSpec> = {}): BlueprintDoc {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	return buildDoc({
		appName: "Registry",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: INTAKE,
				name: "Intake",
				caseType: "patient",
				caseListConfig: list(),
				forms: [
					{
						uuid: REGISTER,
						name: "Register patient",
						type: "registration",
						fields: [nameField()],
						...register,
					},
				],
			},
			{
				uuid: PATIENTS,
				name: "Patients",
				caseType: "patient",
				caseListConfig: list(),
				forms: [followup(VISIT, "Visit")],
			},
			{
				uuid: CLINIC,
				name: "Clinic",
				caseType: "patient",
				caseListConfig: list(),
				forms: [followup(CHECKUP, "Checkup")],
			},
		],
	});
}

function offer(
	doc: BlueprintDoc,
	host: string,
	slot: CaseListRegistrationForm,
): void {
	doc.modules[testUuid(host)] = {
		...doc.modules[testUuid(host)],
		caseListRegistrationForm: slot,
	};
}

const always = (
	afterSubmit: "case-list" | "new-case" = "case-list",
	formUuid = REGISTER,
): CaseListRegistrationForm => ({ kind: "always", formUuid, afterSubmit });

describe("the case list registration readers", () => {
	it("read the always arm apart from the form on no menu", () => {
		const doc = registry();
		offer(doc, PATIENTS, always("new-case"));
		expect(afterEmptySearchRegistrationFormOf(doc, PATIENTS)).toBeUndefined();
		expect(alwaysOfferedRegistrationOf(doc, PATIENTS)).toEqual(
			always("new-case"),
		);
		expect(offeredRegistrationFormOf(doc, PATIENTS)).toBe(REGISTER);

		const own = registry();
		offer(own, INTAKE, { kind: "after-empty-search", formUuid: REGISTER });
		expect(afterEmptySearchRegistrationFormOf(own, INTAKE)).toBe(REGISTER);
		expect(alwaysOfferedRegistrationOf(own, INTAKE)).toBeUndefined();
		expect(offeredRegistrationFormOf(own, INTAKE)).toBe(REGISTER);
		expect(offeredRegistrationFormOf(own, PATIENTS)).toBeUndefined();
	});

	it("keep the always arm's form on its own menu, and the host's menu as it was", () => {
		const doc = registry();
		const hostForms = menuFormUuidsOf(doc, PATIENTS);
		const hostCaseFirst = moduleIsCaseFirst(doc, PATIENTS);
		offer(doc, PATIENTS, always());
		expect(menuFormUuidsOf(doc, INTAKE)).toEqual([REGISTER]);
		expect(menuFormUuidsOf(doc, PATIENTS)).toEqual(hostForms);
		expect(moduleIsCaseFirst(doc, PATIENTS)).toBe(hostCaseFirst);

		const own = registry();
		offer(own, INTAKE, { kind: "after-empty-search", formUuid: REGISTER });
		expect(menuFormUuidsOf(own, INTAKE)).toEqual([]);
	});

	it("list every case list offering a form, in module order, and no after-empty-search host", () => {
		const doc = registry();
		offer(doc, CLINIC, always());
		offer(doc, PATIENTS, always("new-case"));
		expect(caseListsOffering(doc, REGISTER)).toEqual([PATIENTS, CLINIC]);
		expect(caseListsOffering(doc, VISIT)).toEqual([]);

		const own = registry();
		offer(own, INTAKE, { kind: "after-empty-search", formUuid: REGISTER });
		expect(caseListsOffering(own, REGISTER)).toEqual([]);
	});

	it("return by the arm while the form goes home after submit", () => {
		for (const afterSubmit of ["case-list", "new-case"] as const) {
			const doc = registry();
			offer(doc, PATIENTS, always(afterSubmit));
			expect(caseListRegistrationReturnOf(doc, PATIENTS)).toEqual({
				kind: afterSubmit,
			});
			const home = registry({ postSubmit: "app_home" });
			offer(home, PATIENTS, always(afterSubmit));
			expect(caseListRegistrationReturnOf(home, PATIENTS)).toEqual({
				kind: afterSubmit,
			});
		}
	});

	it("follow the form's own after-submit where it has a destination or links", () => {
		const elsewhere = registry({ postSubmit: "firstMenu" });
		offer(elsewhere, PATIENTS, always("new-case"));
		expect(caseListRegistrationReturnOf(elsewhere, PATIENTS)).toEqual({
			kind: "own",
		});

		const linked = registry({
			formLinks: [
				{
					uuid: testUuid("menu-forms-link"),
					target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
				},
			],
		});
		offer(linked, PATIENTS, always("case-list"));
		expect(caseListRegistrationReturnOf(linked, PATIENTS)).toEqual({
			kind: "own",
		});
		// The stored value stays as it was.
		expect(alwaysOfferedRegistrationOf(linked, PATIENTS)?.afterSubmit).toBe(
			"case-list",
		);
	});

	it("say nothing for a host with no always arm or a form no longer in the app", () => {
		const doc = registry();
		expect(caseListRegistrationReturnOf(doc, PATIENTS)).toBeUndefined();
		offer(doc, INTAKE, { kind: "after-empty-search", formUuid: REGISTER });
		expect(caseListRegistrationReturnOf(doc, INTAKE)).toBeUndefined();
		offer(doc, PATIENTS, always("case-list", GONE));
		expect(caseListRegistrationReturnOf(doc, PATIENTS)).toBeUndefined();
	});
});
