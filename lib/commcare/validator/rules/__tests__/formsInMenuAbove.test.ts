/**
 * The rules of a menu that shows its forms in the menu above
 * (`rules/formsInMenuAbove.ts` and the reasons it adds elsewhere), each held
 * at the commit gate (`mutationCommitVerdict`) over the batch that turns the
 * slot on, or that strands what the slot already admitted. Each refusal is
 * checked beside the neighbour it must admit, so a rule that fires too
 * widely fails here as surely as one that never fires.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FormSpec,
	f,
	type ModuleSpec,
} from "@/lib/__tests__/docHelpers";
import {
	firstMenuSharedCase,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	eq,
	literal,
	prop,
	sessionContext,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import type { ValidationError } from "../../errors";
import { runValidation } from "../../runner";

const CLIENTS = testUuid("above-clients");
const PATIENTS = testUuid("above-patients");
const EXTRA = testUuid("above-extra");
const REPORTS = testUuid("above-reports");
const REGISTER = testUuid("above-register");
const VISIT = testUuid("above-visit");
const P_VISIT = testUuid("above-p-visit");
const SUMMARY = testUuid("above-summary");

const nameField = () =>
	f({
		kind: "text",
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType: "patient", property: "case_name" },
	});
const noteField = () =>
	f({ kind: "text", id: "note", label: proseText("Note") });

const registration = (uuid: string, name: string): FormSpec => ({
	uuid,
	name,
	type: "registration",
	fields: [nameField()],
});
const followup = (
	uuid: string,
	name: string,
	extra: Partial<FormSpec> = {},
): FormSpec => ({
	uuid,
	name,
	type: "followup",
	fields: [noteField()],
	...extra,
});

interface Shape {
	/** The forms of the top-level "Clients" menu. */
	readonly clients?: readonly FormSpec[];
	readonly clientsModule?: Partial<ModuleSpec>;
	/** The forms of "Extra", a submenu of the case-first "Patients", or of
	 *  "Clients" where `extraUnderClients` holds. */
	readonly extra?: readonly FormSpec[];
	readonly extraUnderClients?: boolean;
	readonly pVisit?: Partial<FormSpec>;
	readonly summary?: Partial<FormSpec>;
}

/** Clients (top-level), Patients with its submenu Extra, and Reports, a
 *  survey menu: the document every batch below starts from. */
function docOf(shape: Shape = {}): BlueprintDoc {
	const doc = buildDoc(
		{
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: CLIENTS,
					name: "Clients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						...(shape.clients ?? [
							registration(REGISTER, "Register"),
							followup(VISIT, "Visit"),
						]),
					],
					...shape.clientsModule,
				},
				{
					uuid: PATIENTS,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [followup(P_VISIT, "Patient visit", shape.pVisit)],
				},
				...(shape.extra === undefined
					? []
					: [
							{
								uuid: EXTRA,
								name: "Extra",
								caseType: "patient",
								caseListConfig: caseListConfig([
									{ field: "case_name", header: "Name" },
								]),
								forms: [...shape.extra],
							},
						]),
				{
					uuid: REPORTS,
					name: "Reports",
					forms: [
						{
							uuid: SUMMARY,
							name: "Summary",
							type: "survey",
							fields: [noteField()],
							...shape.summary,
						},
					],
				},
			],
		},
		(draft) => {
			if (shape.extra === undefined) return;
			draft.modules[EXTRA].parentModuleUuid = shape.extraUnderClients
				? CLIENTS
				: PATIENTS;
			if (shape.extraUnderClients)
				draft.moduleOrder = [CLIENTS, EXTRA, PATIENTS, REPORTS];
		},
	);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

const above = (moduleUuid: Uuid): Mutation => ({
	kind: "updateModule",
	uuid: moduleUuid,
	patch: { formsInMenuAbove: true },
});

function verdictOf(doc: BlueprintDoc, mutations: Mutation[]) {
	return mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE);
}

function refusals(
	doc: BlueprintDoc,
	mutations: Mutation[],
): readonly ValidationError[] {
	const verdict = verdictOf(doc, mutations);
	return verdict.ok ? [] : verdict.findings;
}

describe("a menu that shows its forms in the menu above", () => {
	it("is admitted with forms, a case list and a registration beside follow-ups", () => {
		const doc = docOf({ clientsModule: { caseListMenuItem: {} } });
		const verdict = verdictOf(doc, [above(CLIENTS)]);
		expect(verdict.ok).toBe(true);
	});

	it("refuses its own entry point and its case list entry point", () => {
		// A case list entry point needs a menu that chooses its case first.
		const doc = docOf({ clients: [followup(VISIT, "Visit")] });
		doc.modules[CLIENTS].entryPoint = {
			uuid: testUuid("above-entry"),
			id: "clients",
		};
		doc.modules[CLIENTS].caseListEntryPoint = {
			uuid: testUuid("above-list-entry"),
			id: "clients-list",
		};
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const found = refusals(doc, [above(CLIENTS)]).filter(
			(finding) => finding.code === "FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION",
		);
		expect(found.map((finding) => finding.details?.arm)).toEqual([
			"entry-point",
			"case-list-entry-point",
		]);
		expect(found[1]?.message).toContain(
			"its case list entry point would open the app's first menu and never the list",
		);
		for (const finding of found)
			expect(userFacingError(finding)).not.toContain("forms_in_menu_above");
	});

	it("refuses a link to the menu itself and admits a link to one of its forms", () => {
		const toMenu = docOf({
			summary: {
				formLinks: [{ target: { type: "module", moduleUuid: CLIENTS } }],
			},
		});
		const found = refusals(toMenu, [above(CLIENTS)]);
		expect(found.map((finding) => finding.code)).toEqual([
			"FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION",
		]);
		expect(found[0]?.details).toMatchObject({
			arm: "link",
			role: "destination",
			targetModuleUuid: CLIENTS,
		});

		const toForm = docOf({
			summary: {
				formLinks: [
					{
						target: {
							type: "form",
							moduleUuid: CLIENTS,
							formUuid: REGISTER,
						},
					},
				],
			},
		});
		expect(verdictOf(toForm, [above(CLIENTS)]).ok).toBe(true);
	});

	it("refuses a search and admits the owner-only availability", () => {
		const searching = docOf({ clientsModule: { caseSearchConfig: {} } });
		const found = refusals(searching, [above(CLIENTS)]);
		expect(
			found.map((finding) => [finding.code, finding.details?.reason]),
		).toEqual([["FORMS_IN_MENU_ABOVE_WITH_SEARCH", "search"]]);

		const ownerOnly = docOf({
			clientsModule: {
				caseSearchConfig: {
					searchActionEnabled: false,
					excludedOwnerIds: term(sessionContext("userid")),
				},
			},
		});
		expect(verdictOf(ownerOnly, [above(CLIENTS)]).ok).toBe(true);
	});

	it("refuses forms that read the search, once", () => {
		const doc = docOf({
			clients: [followup(VISIT, "Visit")],
			clientsModule: { caseSearchConfig: { formsReadSearch: true } },
		});
		const found = refusals(doc, [above(CLIENTS)]).filter(
			(finding) => finding.code === "FORMS_IN_MENU_ABOVE_WITH_SEARCH",
		);
		expect(found.map((finding) => finding.details?.reason)).toEqual([
			"forms-read-search",
		]);
	});

	it("withholds module after submit and previous on the first menu", () => {
		const doc = docOf({
			clients: [
				registration(REGISTER, "Register"),
				followup(VISIT, "Visit", { postSubmit: "module" }),
			],
		});
		doc.modules[CLIENTS].formsInMenuAbove = true;
		const found = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "POST_SUBMIT_NOT_OFFERED",
		);
		expect(found.map((finding) => finding.details?.reason)).toEqual([
			"menu-forms-in-menu-above",
		]);
		expect(found[0]?.message).toContain(
			'"Clients" shows its forms in the menu above, so it has no screen of its own to land on.',
		);
	});
});

describe("a form's display condition on a screen with another menu's forms", () => {
	it("refuses a case read once a submenu's registration form lists beside it", () => {
		const doc = docOf({
			extra: [registration("above-e-register", "Enrol")],
			pVisit: {
				displayCondition: eq(prop("patient", "status"), literal("open")),
			},
		});
		const found = refusals(doc, [above(EXTRA)]).filter(
			(finding) =>
				finding.code === "FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.details).toMatchObject({
			reason: "opens-without-a-case",
			blockingModuleUuid: EXTRA,
			blockingFormUuid: testUuid("above-e-register"),
		});
		expect(found[0]?.message).toContain(
			'Its forms show with "Extra"\'s on one screen, and "Enrol" there opens without a case',
		);
	});

	it("keeps the case read where the submenu's forms open the same case", () => {
		const doc = docOf({
			extra: [followup("above-e-visit", "Check")],
			pVisit: {
				displayCondition: eq(prop("patient", "status"), literal("open")),
			},
		});
		expect(verdictOf(doc, [above(EXTRA)]).ok).toBe(true);
	});
});

describe("no chosen case ahead of a command", () => {
	// "Follow" shows its forms on the first menu and every form listed there
	// opens one chosen case, so HQ builds each frame through the first menu
	// with that case ahead of its first command.
	const sharedCaseDoc = (
		patientVisit: Partial<FormSpec>,
		clients: readonly FormSpec[] = [followup(VISIT, "Visit")],
	) => docOf({ clients, pVisit: patientVisit });

	it("reads a shared case only where every form listed above opens one case", () => {
		const shared = (clients: readonly FormSpec[]) => {
			const placed = verdictOf(sharedCaseDoc({}, clients), [above(CLIENTS)]);
			if (!placed.ok) throw new Error("The menu should show its forms above.");
			return firstMenuSharedCase(
				placed.nextDoc,
				formLinkProjectionContext(placed.nextDoc),
			);
		};
		expect(shared([followup(VISIT, "Visit")])).toMatchObject({
			requiresSelection: true,
			caseType: "patient",
		});
		expect(
			shared([registration(REGISTER, "Register"), followup(VISIT, "Visit")]),
		).toBeUndefined();
		expect(shared([registration(REGISTER, "Register")])).toBeUndefined();
	});

	it("refuses a link into a form listed there", () => {
		const doc = sharedCaseDoc({
			formLinks: [
				{ target: { type: "form", moduleUuid: CLIENTS, formUuid: VISIT } },
			],
		});
		const found = refusals(doc, [above(CLIENTS)]);
		expect(found.map((finding) => finding.code)).toEqual([
			"FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE",
		]);
		expect(found[0]?.details).toMatchObject({
			role: "destination",
			aboveModuleUuid: CLIENTS,
			aboveModuleName: "Clients",
		});
	});

	it("refuses an entry point on a form listed there", () => {
		const doc = sharedCaseDoc({});
		doc.forms[VISIT].entryPoint = {
			uuid: testUuid("above-visit-entry"),
			id: "visit",
		};
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const found = refusals(doc, [above(CLIENTS)]);
		expect(
			found.map((finding) => [finding.code, finding.details?.reason]),
		).toEqual([["ENTRY_POINT_INVALID", "first-menu-shared-case"]]);
	});

	it("admits the link in the starter shape and the registration-only shape", () => {
		const starter = sharedCaseDoc(
			{
				formLinks: [
					{ target: { type: "form", moduleUuid: CLIENTS, formUuid: VISIT } },
				],
			},
			[registration(REGISTER, "Register"), followup(VISIT, "Visit")],
		);
		expect(verdictOf(starter, [above(CLIENTS)]).ok).toBe(true);

		const registrationOnly = sharedCaseDoc(
			{
				formLinks: [
					{
						target: { type: "form", moduleUuid: CLIENTS, formUuid: REGISTER },
					},
				],
			},
			[registration(REGISTER, "Register")],
		);
		expect(verdictOf(registrationOnly, [above(CLIENTS)]).ok).toBe(true);
	});

	it("refuses a built-in module destination in a submenu that keeps its screen there", () => {
		const doc = docOf({
			clients: [followup(VISIT, "Visit")],
			extra: [followup("above-e-visit", "Check", { postSubmit: "module" })],
			extraUnderClients: true,
		});
		const found = refusals(doc, [above(CLIENTS)]);
		expect(found.map((finding) => finding.code)).toEqual([
			"FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE",
		]);
		expect(found[0]?.details).toMatchObject({
			slot: "post-submit",
			destination: "module",
			aboveModuleUuid: CLIENTS,
		});
	});

	it("refuses taking the last registration form off the first menu while a link into a form there stands", () => {
		const doc = sharedCaseDoc(
			{
				formLinks: [
					{ target: { type: "form", moduleUuid: CLIENTS, formUuid: VISIT } },
				],
			},
			[registration(REGISTER, "Register"), followup(VISIT, "Visit")],
		);
		const placed = verdictOf(doc, [above(CLIENTS)]);
		expect(placed.ok).toBe(true);
		if (!placed.ok) return;
		const found = refusals(placed.nextDoc, [
			{ kind: "removeForm", uuid: REGISTER },
		]);
		expect(found.map((finding) => finding.code)).toEqual([
			"FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE",
		]);
	});
});
