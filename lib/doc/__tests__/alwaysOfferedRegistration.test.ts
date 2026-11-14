/**
 * A case list that always offers another menu's registration form, through
 * its planner and the commit gate, a serialization round trip and the
 * reducers: setting and clearing the slot whole
 * (`alwaysOfferedRegistration.ts`), the forms a list may offer, the refusal
 * to remove a form a list offers (`caseListRegistrationDependents.ts`), and
 * what a committed removal or a move does to another menu's slot.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	alwaysOfferedRegistrationChoices,
	alwaysOfferedRegistrationMutations,
} from "@/lib/doc/alwaysOfferedRegistration";
import { planCaseListRegistrationDependentsOnRemove } from "@/lib/doc/caseListRegistrationDependents";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { referencingCarrierUuids } from "@/lib/doc/referenceIndex";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type AlwaysOfferedRegistration,
	alwaysOfferedRegistrationOf,
	type BlueprintDoc,
	caseListsOffering,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { entityTargetKey } from "@/lib/domain/referenceIndex";
import { assertAdmittedDoc } from "./admittedDoc";

const PATIENTS = testUuid("patients");
const VISITS = testUuid("visits");
const REGISTER_MENU = testUuid("register-menu");
const OTHER_MENU = testUuid("other-menu");
const REGISTER = testUuid("register");
const SECOND_REGISTER = testUuid("second-register");

const registration = (uuid: string, name: string) => ({
	uuid,
	name,
	type: "registration" as const,
	fields: [
		f({
			kind: "text",
			id: "case_name",
			label: proseText("Name"),
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
	],
});
const followup = (uuid: string, name: string) => ({
	uuid,
	name,
	type: "followup" as const,
	fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
});
const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);

/** Two follow-up menus of patients, a menu holding two registration forms of
 *  patients, and a menu of another case type. */
function patientsDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Patients",
		caseTypes: [
			{ name: "patient", properties: [] },
			{ name: "household", properties: [] },
		],
		modules: [
			{
				uuid: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: list(),
				forms: [followup("patients-visit", "Visit")],
			},
			{
				uuid: "visits",
				name: "Visits",
				caseType: "patient",
				caseListConfig: list(),
				forms: [followup("visits-visit", "Check in")],
			},
			{
				uuid: "register-menu",
				name: "Registration",
				caseType: "patient",
				caseListConfig: list(),
				forms: [
					registration("register", "Register patient"),
					registration("second-register", "Register newborn"),
				],
			},
			{
				uuid: "other-menu",
				name: "Households",
				caseType: "household",
				caseListConfig: list(),
				forms: [
					{
						...registration("household-register", "Register household"),
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "household", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

/** The reducers alone, as a replay applies them. */
function reduced(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

function committed(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

function planned(
	doc: BlueprintDoc,
	host: typeof PATIENTS,
	slot: AlwaysOfferedRegistration | null,
): Mutation[] {
	const plan = alwaysOfferedRegistrationMutations(doc, host, slot);
	if (plan.kind !== "planned") throw new Error(plan.message);
	return plan.mutations.map((mutation) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
	);
}

const OFFER: AlwaysOfferedRegistration = {
	kind: "always",
	formUuid: REGISTER,
	afterSubmit: "new-case",
};

function offeredOnBoth(): BlueprintDoc {
	const doc = committed(patientsDoc(), planned(patientsDoc(), PATIENTS, OFFER));
	return committed(doc, planned(doc, VISITS, OFFER));
}

describe("alwaysOfferedRegistrationMutations", () => {
	it("sets the slot whole and clears it with a null the wire keeps", () => {
		const doc = committed(
			patientsDoc(),
			planned(patientsDoc(), PATIENTS, OFFER),
		);
		expect(alwaysOfferedRegistrationOf(doc, PATIENTS)).toEqual(OFFER);
		const cleared = committed(doc, planned(doc, PATIENTS, null));
		expect(
			Object.hasOwn(cleared.modules[PATIENTS], "caseListRegistrationForm"),
		).toBe(false);
	});

	it("plans nothing to clear a host that offers no form", () => {
		expect(planned(patientsDoc(), PATIENTS, null)).toEqual([]);
	});

	it("never replaces a form the host offers after an empty search", () => {
		const doc = patientsDoc();
		doc.modules[PATIENTS].caseListRegistrationForm = {
			kind: "after-empty-search",
			formUuid: testUuid("patients-visit"),
		};
		const plan = alwaysOfferedRegistrationMutations(doc, PATIENTS, OFFER);
		expect(plan).toMatchObject({
			kind: "blocked",
			message: expect.stringContaining(
				"case_list_registration null on update_form",
			),
			userMessage: `"Patients" already offers "Visit" after a search finds nothing. You can stop offering that, and then offer a form on the list.`,
		});
		expect(alwaysOfferedRegistrationChoices(doc, PATIENTS)).toEqual([]);
	});
});

describe("alwaysOfferedRegistrationChoices", () => {
	it("lists every registration form of the host's case type outside it, in order", () => {
		const choices = alwaysOfferedRegistrationChoices(patientsDoc(), PATIENTS);
		expect(
			choices.map((choice) => [choice.formName, choice.moduleName]),
		).toEqual([
			["Register patient", "Registration"],
			["Register newborn", "Registration"],
		]);
	});

	it("carries the stored label, media and return into every choice's batch", () => {
		const doc = committed(
			patientsDoc(),
			planned(patientsDoc(), PATIENTS, { ...OFFER, label: "New patient" }),
		);
		const [, second] = alwaysOfferedRegistrationChoices(doc, PATIENTS);
		expect(second?.mutations).toEqual([
			{
				kind: "updateModule",
				uuid: PATIENTS,
				patch: {
					caseListRegistrationForm: {
						kind: "always",
						formUuid: SECOND_REGISTER,
						label: "New patient",
						afterSubmit: "new-case",
					},
				},
			},
		]);
	});

	it("offers each choice through a batch the gate admits", () => {
		const doc = patientsDoc();
		for (const choice of alwaysOfferedRegistrationChoices(doc, PATIENTS))
			committed(doc, [...choice.mutations]);
	});
});

describe("the reducers keep no slot naming a form that is gone", () => {
	it("deletes another menu's offer when the form is removed", () => {
		const next = reduced(offeredOnBoth(), [
			{ kind: "removeForm", uuid: REGISTER },
		]);
		expect(caseListsOffering(next, REGISTER)).toEqual([]);
		expect(next.modules[PATIENTS].caseListRegistrationForm).toBeUndefined();
		expect(next.modules[VISITS].caseListRegistrationForm).toBeUndefined();
		// The reference index forgets both hosts in the same step.
		expect(referencingCarrierUuids(next, entityTargetKey(REGISTER))).toEqual(
			[],
		);
	});

	it("deletes the offer when the module holding the form is removed", () => {
		const doc = offeredOnBoth();
		const emptied = reduced(doc, [
			{ kind: "removeForm", uuid: SECOND_REGISTER },
		]);
		const next = reduced(emptied, [
			{ kind: "removeModule", uuid: REGISTER_MENU },
		]);
		expect(caseListsOffering(next, REGISTER)).toEqual([]);
	});

	it("keeps the offer on a form moved to another menu, by identity", () => {
		const next = reduced(offeredOnBoth(), [
			{ kind: "moveForm", uuid: REGISTER, toModuleUuid: VISITS, after: null },
		]);
		expect(caseListsOffering(next, REGISTER)).toEqual([PATIENTS, VISITS]);
	});

	it("replays a serialized removal to the same document", () => {
		const removal: Mutation = mutationSchema.parse(
			JSON.parse(JSON.stringify({ kind: "removeForm", uuid: REGISTER })),
		);
		const once = reduced(offeredOnBoth(), [removal]);
		const twice = reduced(once, [removal]);
		expect(twice.modules).toEqual(once.modules);
	});
});

describe("planCaseListRegistrationDependentsOnRemove", () => {
	it("refuses removing a form a case list offers, naming each list", () => {
		const plan = planCaseListRegistrationDependentsOnRemove(offeredOnBoth(), {
			kind: "form",
			formUuid: REGISTER,
		});
		expect(plan).toEqual({
			kind: "blocked",
			dependents: [
				{
					hostModuleUuid: PATIENTS,
					hostModuleName: "Patients",
					formUuid: REGISTER,
					formName: "Register patient",
				},
				{
					hostModuleUuid: VISITS,
					hostModuleName: "Visits",
					formUuid: REGISTER,
					formName: "Register patient",
				},
			],
			message: `Form "Register patient" is the registration "Patients" and "Visits" offer from their case lists (register_from_case_list on update_module). You can set that to null on each menu that offers it, and then remove the form.`,
			userMessage:
				"Register patient is offered on the case lists of Patients and Visits. You can stop offering it on each, and then remove it.",
		});
	});

	it("names one list in the person's words", () => {
		const doc = committed(
			patientsDoc(),
			planned(patientsDoc(), PATIENTS, OFFER),
		);
		const plan = planCaseListRegistrationDependentsOnRemove(doc, {
			kind: "module",
			moduleUuid: REGISTER_MENU,
		});
		expect(plan).toMatchObject({
			kind: "blocked",
			userMessage:
				"Register patient is offered on Patients's case list. You can stop offering it there, and then remove it.",
		});
	});

	it("has nothing to say when no list offers the form or the list leaves too", () => {
		expect(
			planCaseListRegistrationDependentsOnRemove(patientsDoc(), {
				kind: "form",
				formUuid: REGISTER,
			}),
		).toEqual({ kind: "none" });
		const doc = committed(
			patientsDoc(),
			planned(patientsDoc(), PATIENTS, OFFER),
		);
		expect(
			planCaseListRegistrationDependentsOnRemove(doc, {
				kind: "module",
				moduleUuid: OTHER_MENU,
			}),
		).toEqual({ kind: "none" });
	});

	it("is the refusal the clearing batch answers, after which the removal commits", () => {
		const doc = offeredOnBoth();
		const cleared = committed(doc, [
			...planned(doc, PATIENTS, null),
			...planned(doc, VISITS, null),
		]);
		expect(
			planCaseListRegistrationDependentsOnRemove(cleared, {
				kind: "form",
				formUuid: REGISTER,
			}),
		).toEqual({ kind: "none" });
		committed(cleared, [{ kind: "removeForm", uuid: REGISTER }]);
	});
});
