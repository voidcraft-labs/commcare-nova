/**
 * Registration from the case list (`Module.caseListRegistrationForm`, the
 * `always` arm, CommCare HQ's `case_list_form` with a `form_id`): a case
 * list offers another menu's registration form at any time, and its Register
 * action pushes the form with `return_to`, under which HQ's return frames
 * fire (`details.py::get_case_list_form_action`,
 * `workflow.py::CaseListFormWorkflow`).
 *
 * `targeted-register-from-case-list`, both platforms, one registration form
 * per case type:
 *
 * - the health shape: "Register patient" in "Registration", a menu that
 *   shows its forms on the first menu, offered by the case-first "Patients"
 *   under a label and an uploaded icon, back to the list (`case-list`);
 * - a bare case list, "Patient list", offering the same form (two hosts, one
 *   form), going on with the new case (`new-case`), which a host with no
 *   forms lands back on its list for;
 * - "Household patients", which chooses a household first;
 * - "Patient tiles", whose case list is a tile;
 * - "Patient visits", a submenu of "Clinic";
 * - "Searched patients", with an ordinary search, whose action stands on both
 *   short details;
 * - "Intake", whose screen also lists the registration form of its submenu
 *   "Intake registration", which shows its forms there, so the screen lists
 *   forms first;
 * - "Households", which offers "Register household" of "Household
 *   registration", a form with its own after-submit, which it follows from
 *   the list too.
 *
 * `targeted-register-from-case-list-web-apps`, Web Apps alone, the two hosts
 * only Web Apps runs: one whose forms read the search (`forms-read-search`),
 * going on with the new case, and one that selects several cases
 * (`several-cases`), back to the list.
 *
 * D′ of the first sends a worker who registers from "Patients" on with the
 * new case (proof 5). Fixed values: a host's follow-up note holds the text
 * the worker enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { alwaysOfferedRegistrationMutations } from "@/lib/doc/alwaysOfferedRegistration";
import {
	type AlwaysOfferedRegistration,
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	tileCell,
} from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

type Key = (name: string) => ReturnType<typeof targetedUuid>;

function noteField(key: Key, name: string) {
	return f({
		uuid: key(`${name}-note`),
		kind: "text",
		id: "note",
		label: proseText("Note"),
	});
}

function followUp(key: Key, name: string, title: string) {
	return {
		uuid: key(name),
		name: title,
		type: "followup" as const,
		fields: [noteField(key, name)],
	};
}

function registration(
	key: Key,
	name: string,
	title: string,
	caseType: string,
	extra: object = {},
) {
	return {
		uuid: key(name),
		name: title,
		type: "registration" as const,
		...extra,
		fields: [
			f({
				uuid: key(`${name}-name`),
				kind: "text",
				id: "case_name",
				label: proseText("Name"),
				caseWrite: { caseType, property: "case_name" },
			}),
		],
	};
}

function nameList(key: Key, name: string) {
	return caseListOf([plainColumn(key(`${name}-name`), "case_name", "Name")]);
}

function offer(
	doc: BlueprintDoc,
	host: string,
	slot: Omit<AlwaysOfferedRegistration, "kind">,
) {
	doc.modules[host].caseListRegistrationForm = { kind: "always", ...slot };
}

export function registerFromCaseList() {
	const id = "targeted-register-from-case-list";
	const key: Key = (name) => targetedUuid(id, name);
	const doc = buildDoc({
		appId: id,
		appName: "Register from the list",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: key("registration"),
				name: "Registration",
				caseType: "patient",
				caseListConfig: nameList(key, "registration"),
				forms: [
					registration(key, "register-patient", "Register patient", "patient"),
				],
			},
			{
				uuid: key("patients"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: nameList(key, "patients"),
				forms: [followUp(key, "visit-patient", "Visit patient")],
			},
			{
				uuid: key("patient-list"),
				name: "Patient list",
				caseType: "patient",
				caseListMenuItem: {},
				caseListConfig: nameList(key, "patient-list"),
				forms: [],
			},
			{
				uuid: key("households"),
				name: "Households",
				caseType: "household",
				caseListConfig: nameList(key, "households"),
				forms: [followUp(key, "visit-household", "Visit household")],
			},
			{
				uuid: key("household-registration"),
				name: "Household registration",
				caseType: "household",
				caseListConfig: nameList(key, "household-registration"),
				forms: [
					registration(
						key,
						"register-household",
						"Register household",
						"household",
						{ postSubmit: "firstMenu" },
					),
				],
			},
			{
				uuid: key("household-patients"),
				name: "Household patients",
				caseType: "patient",
				caseListConfig: nameList(key, "household-patients"),
				forms: [followUp(key, "check-patient", "Check patient")],
			},
			{
				uuid: key("patient-tiles"),
				name: "Patient tiles",
				caseType: "patient",
				caseListConfig: caseListOf(
					[
						plainColumn(key("patient-tiles-name"), "case_name", "Name", {
							tile: tileCell(0, 0, 12, 1),
						}),
					],
					{ tile: {} },
				),
				forms: [followUp(key, "tile-visit", "Tile visit")],
			},
			{
				uuid: key("clinic"),
				name: "Clinic",
				forms: [
					{
						uuid: key("clinic-survey"),
						name: "Clinic survey",
						type: "survey",
						fields: [
							f({
								uuid: key("clinic-survey-question"),
								kind: "text",
								id: "question",
								label: proseText("Question"),
							}),
						],
					},
				],
			},
			{
				uuid: key("patient-visits"),
				name: "Patient visits",
				caseType: "patient",
				caseListConfig: nameList(key, "patient-visits"),
				forms: [followUp(key, "submenu-visit", "Submenu visit")],
			},
			{
				uuid: key("searched-patients"),
				name: "Searched patients",
				caseType: "patient",
				caseListConfig: caseListOf(
					[plainColumn(key("searched-patients-name"), "case_name", "Name")],
					{
						searchInputs: [
							simpleSearchInputDef(
								key("searched-patients-input"),
								"patient_name",
								"Name",
								"text",
								"case_name",
							),
						],
					},
				),
				caseSearchConfig: {},
				forms: [followUp(key, "searched-visit", "Searched visit")],
			},
			{
				uuid: key("intake"),
				name: "Intake",
				caseType: "patient",
				caseListConfig: nameList(key, "intake"),
				forms: [followUp(key, "intake-visit", "Intake visit")],
			},
			{
				uuid: key("intake-registration"),
				name: "Intake registration",
				caseType: "patient",
				caseListConfig: nameList(key, "intake-registration"),
				forms: [
					registration(key, "intake-register", "Intake register", "patient"),
				],
			},
		],
	});
	doc.modules[key("registration")].formsInMenuAbove = true;
	doc.modules[key("household-patients")].parentCaseModuleUuid =
		key("households");
	doc.modules[key("patient-visits")].parentModuleUuid = key("clinic");
	doc.modules[key("intake-registration")].parentModuleUuid = key("intake");
	doc.modules[key("intake-registration")].formsInMenuAbove = true;
	const register = key("register-patient");
	offer(doc, key("patients"), {
		formUuid: register,
		label: "Register a new patient",
		icon: mediaIds.icon,
		afterSubmit: "case-list",
	});
	offer(doc, key("patient-list"), {
		formUuid: register,
		afterSubmit: "new-case",
	});
	offer(doc, key("household-patients"), {
		formUuid: register,
		afterSubmit: "new-case",
	});
	offer(doc, key("patient-tiles"), {
		formUuid: register,
		afterSubmit: "case-list",
	});
	offer(doc, key("patient-visits"), {
		formUuid: register,
		afterSubmit: "new-case",
	});
	offer(doc, key("searched-patients"), {
		formUuid: register,
		afterSubmit: "case-list",
	});
	offer(doc, key("intake"), {
		formUuid: register,
		afterSubmit: "case-list",
	});
	offer(doc, key("households"), {
		formUuid: key("register-household"),
		afterSubmit: "new-case",
	});
	// D′ sends a worker who registers from "Patients" on with the new case,
	// as the list's After registering choice does.
	const edit = structuredClone(doc);
	const changed: AlwaysOfferedRegistration = {
		kind: "always",
		formUuid: register,
		label: "Register a new patient",
		icon: mediaIds.icon,
		afterSubmit: "new-case",
	};
	edit.modules[key("patients")].caseListRegistrationForm = changed;
	const plan = alwaysOfferedRegistrationMutations(
		doc,
		key("patients"),
		changed,
	);
	if (plan.kind === "blocked") throw new Error(plan.message);
	const media = uploadedMedia(mediaManifest());
	return targetedDocument({
		id,
		rows: [
			"registration from the case list: a registration form of another menu every host shape offers, back to the list or on with the new case",
		],
		doc,
		edit,
		editMutations: plan.mutations,
		...(media !== undefined && { media }),
		expected: {
			intent: [
				answerHeld(
					"visit-patient-note-held",
					key("visit-patient"),
					"/data/note",
					"seen",
					"local",
					{ command: "m1-f0", caseId: "targeted-patient" },
				),
			],
		},
	});
}

export function registerFromCaseListWebApps() {
	const id = "targeted-register-from-case-list-web-apps";
	const key: Key = (name) => targetedUuid(id, name);
	const doc = buildDoc({
		appId: id,
		appName: "Register from the list in Web Apps",
		// Forms that read the search, and choosing several cases, run in Web
		// Apps alone (`forms-read-search`, `several-cases`).
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: key("registration"),
				name: "Registration",
				caseType: "patient",
				caseListConfig: nameList(key, "registration"),
				forms: [
					registration(key, "register-patient", "Register patient", "patient"),
				],
			},
			{
				uuid: key("searched-patients"),
				name: "Searched patients",
				caseType: "patient",
				caseSearchConfig: { formsReadSearch: true },
				caseListConfig: caseListOf(
					[plainColumn(key("searched-patients-name"), "case_name", "Name")],
					{
						searchInputs: [
							simpleSearchInputDef(
								key("searched-patients-input"),
								"patient_name",
								"Name",
								"text",
								"case_name",
							),
						],
					},
				),
				forms: [followUp(key, "searched-visit", "Searched visit")],
			},
			{
				uuid: key("selected-patients"),
				name: "Selected patients",
				caseType: "patient",
				caseListConfig: {
					...nameList(key, "selected-patients"),
					selection: { kind: "multiple", maximum: 10 },
				},
				forms: [followUp(key, "group-visit", "Group visit")],
			},
		],
	});
	offer(doc, key("searched-patients"), {
		formUuid: key("register-patient"),
		afterSubmit: "new-case",
	});
	offer(doc, key("selected-patients"), {
		formUuid: key("register-patient"),
		afterSubmit: "case-list",
	});
	return targetedDocument({
		id,
		rows: [
			"registration from the case list: hosts whose forms read the search and that select several cases, which Web Apps alone runs",
		],
		doc,
		expected: {
			intent: [
				answerHeld(
					"searched-visit-note-held",
					key("searched-visit"),
					"/data/note",
					"seen",
					"A",
					{ command: "m1-f0", caseId: "targeted-patient" },
				),
			],
		},
	});
}
