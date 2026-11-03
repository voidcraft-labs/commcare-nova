/**
 * Tests for the case list registration form's refusals
 * (`caseListRegistration.ts` over `Module.caseListRegistrationForm`, the
 * link-target arm in `rules/form.ts`, and the `#search/` leaf check in
 * `validator/index.ts`), each mirroring what the `case_list_form` lowering
 * can and cannot express on the wire. Every finding sits at the module and
 * names the form in `details.formUuid` and `details.formName`.
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
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type Module,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../../runner";

const MODULE = testUuid("00000000-0000-4000-8000-0000000d0001");
const VISIT = testUuid("00000000-0000-4000-8000-0000000d0002");
const REGISTER = testUuid("00000000-0000-4000-8000-0000000d0003");
const OTHER_MODULE = testUuid("00000000-0000-4000-8000-0000000d0004");
const OTHER_FORM = testUuid("00000000-0000-4000-8000-0000000d0005");
const NAME_INPUT = testUuid("00000000-0000-4000-8000-0000000d0010");
const GONE_INPUT = testUuid("00000000-0000-4000-8000-0000000d0011");

function searchList(): NonNullable<Module["caseListConfig"]> {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			NAME_INPUT,
			"patient_name",
			"Name",
			"text",
			"case_name",
		),
	];
	return config;
}

function nameField(searchInputUuid?: Uuid) {
	return f({
		kind: "text",
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType: "patient", property: "case_name" },
		...(searchInputUuid === undefined
			? {}
			: {
					default_value: {
						kind: "term",
						term: { kind: "input", searchInputUuid },
					},
				}),
	});
}

function registerForm(overrides: Partial<FormSpec> = {}): FormSpec {
	return {
		uuid: REGISTER,
		name: "Register patient",
		type: "registration",
		fields: [nameField()],
		...overrides,
	};
}

function docWith(
	moduleOverrides: Partial<ModuleSpec> = {},
	other?: ModuleSpec,
): BlueprintDoc {
	return buildDoc({
		appName: "Registry",
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: searchList(),
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: { formUuid: REGISTER },
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
					registerForm(),
				],
				...(moduleOverrides.forms?.every((form) => form.uuid === REGISTER)
					? { caseListMenuItem: {} }
					: {}),
				...moduleOverrides,
			},
			...(other === undefined ? [] : [other]),
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
}

function codes(doc: BlueprintDoc, code: string): string[] {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(errors.map((error) => error.code)).toEqual(
		Array(errors.length).fill(code),
	);
	return errors.map((error) => error.message);
}

/** Each finding's code, module, named form and message. */
function findings(doc: BlueprintDoc, code: string) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.filter((error) => error.code === code)
		.map((error) => ({
			moduleUuid: error.location.moduleUuid,
			formUuid: error.location.formUuid,
			details: error.details,
			message: error.message,
		}));
}

const visitForm = (): FormSpec => ({
	uuid: VISIT,
	name: "Visit",
	type: "followup",
	fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
});

describe("caseListRegistrationForm", () => {
	it("admits a registration form the case list offers in a menu whose forms read the search", () => {
		const doc = docWith();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("admits it under results first as under search first", () => {
		const doc = docWith({
			caseSearchConfig: { workflow: "skipToResults", formsReadSearch: true },
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("requires the menu's forms to read the search", () => {
		const doc = docWith({ caseSearchConfig: {} });
		expect(
			codes(doc, "CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH"),
		).toHaveLength(1);
		expect(
			findings(doc, "CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH"),
		).toEqual([
			{
				moduleUuid: MODULE,
				formUuid: undefined,
				details: { formUuid: REGISTER, formName: "Register patient" },
				message: `Module "Patients" offers "Register patient" when a search finds nothing, but its forms don't read the search, so no search runs before its list. You can turn on Forms read the search for the menu (formsReadSearch true), or stop offering the form (case_list_registration null on update_form).`,
			},
		]);
	});

	it("requires a registration form", () => {
		const doc = docWith({
			forms: [
				registerForm({
					type: "followup",
					fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
				}),
			],
		});
		expect(codes(doc, "CASE_LIST_REGISTRATION_NOT_REGISTRATION")).toEqual([
			`Module "Patients" offers "Register patient" when a search finds nothing, so "Register patient" needs to register a new "patient" case, and it is a followup form. You can make it a registration form, or stop offering it there.`,
		]);
		expect(
			findings(doc, "CASE_LIST_REGISTRATION_NOT_REGISTRATION")[0],
		).toMatchObject({
			moduleUuid: MODULE,
			formUuid: undefined,
			details: { formUuid: REGISTER },
		});
	});

	it("refuses after-submit links and a display condition", () => {
		const doc = docWith({
			forms: [
				visitForm(),
				registerForm({
					displayCondition: eq(sessionUser("username"), literal("ada")),
					formLinks: [
						{
							uuid: testUuid("00000000-0000-4000-8000-0000000d0020"),
							target: { type: "module", moduleUuid: MODULE },
						},
					],
				}),
			],
		});
		expect(codes(doc, "CASE_LIST_REGISTRATION_HAS_NAVIGATION")).toEqual([
			`"Register patient" is offered when a search finds nothing in "Patients", so after submit it returns to the search or to First menu, and it's on no menu; it can't carry after-submit links, a display condition. You can remove them, or stop offering the form there.`,
		]);
	});

	it("refuses an after-submit destination other than First menu and a display condition", () => {
		const doc = docWith({
			forms: [
				visitForm(),
				registerForm({
					postSubmit: "module",
					displayCondition: eq(sessionUser("username"), literal("ada")),
				}),
			],
		});
		expect(codes(doc, "CASE_LIST_REGISTRATION_HAS_NAVIGATION")).toEqual([
			`"Register patient" is offered when a search finds nothing in "Patients", so after submit it returns to the search or to First menu, and it's on no menu; it can't carry an after-submit destination other than First menu, a display condition. You can remove them, or stop offering the form there.`,
		]);
	});

	it("refuses taking the form off the menu, where an ordinary form may be", () => {
		const doc = docWith();
		doc.forms[VISIT].hiddenFromMenu = true;
		doc.forms[REGISTER].hiddenFromMenu = true;
		blueprintDocSchema.parse(toPersistableDoc(doc));
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.map((error) => [
				error.code,
				error.location.moduleUuid,
				error.details?.formUuid,
			]),
		).toEqual([["CASE_LIST_REGISTRATION_HAS_NAVIGATION", MODULE, REGISTER]]);
		expect(errors[0]?.message).toContain("hiddenFromMenu");
	});

	it("names App home as a destination it can't take", () => {
		const doc = docWith({
			forms: [visitForm(), registerForm({ postSubmit: "app_home" })],
		});
		const messages = codes(doc, "CASE_LIST_REGISTRATION_HAS_NAVIGATION");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			"an after-submit destination other than First menu",
		);
	});

	it("admits registration without a menu form when its case type has a parent", () => {
		const households: ModuleSpec = {
			uuid: OTHER_MODULE,
			name: "Households",
			caseType: "household",
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					uuid: OTHER_FORM,
					name: "Visit household",
					type: "followup",
					fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
				},
			],
		};
		const withParent = (doc: BlueprintDoc): BlueprintDoc => ({
			...doc,
			caseTypes: [
				...(doc.caseTypes ?? []).map((caseType) =>
					caseType.name === "patient"
						? { ...caseType, parent_type: "household" }
						: caseType,
				),
				{
					name: "household",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		});
		// A parent type does not make registration select an existing parent.
		// Native explicit-child routing is covered by the no-matches corpus.
		const formless = withParent(
			docWith({ caseListMenuItem: {}, forms: [registerForm()] }, households),
		);
		for (const doc of [
			withParent(docWith({}, households)),
			formless,
			docWith({ caseListMenuItem: {}, forms: [registerForm()] }),
		]) {
			blueprintDocSchema.parse(toPersistableDoc(doc));
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		}
	});
});

describe("caseListRegistrationFormInModule", () => {
	const CODE = "CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE";
	const intake = (): ModuleSpec => ({
		uuid: OTHER_MODULE,
		name: "Intake",
		caseType: "patient",
		caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		forms: [
			{
				uuid: OTHER_FORM,
				name: "Register elsewhere",
				type: "registration",
				fields: [nameField()],
			},
		],
	});

	it("refuses a slot naming another module's form", () => {
		const doc = docWith(
			{
				forms: [visitForm()],
				caseListRegistrationForm: { formUuid: OTHER_FORM },
			},
			intake(),
		);
		expect(findings(doc, CODE)).toEqual([
			{
				moduleUuid: MODULE,
				formUuid: undefined,
				details: { formUuid: OTHER_FORM },
				message: `Module "Patients" offers a registration form when a search finds nothing, but that form isn't one of "Patients"'s forms. You can choose one of its own registration forms, or stop offering one (caseListRegistrationForm null).`,
			},
		]);
	});

	it("is reported by a run scoped away from the module, since a move elsewhere can strand it", () => {
		const doc = docWith(
			{
				forms: [visitForm()],
				caseListRegistrationForm: { formUuid: OTHER_FORM },
			},
			intake(),
		);
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			scope: {
				moduleUuids: new Set([OTHER_MODULE]),
				formUuids: new Set([OTHER_FORM]),
			},
		});
		expect(scoped.map((error) => error.code)).toContain(CODE);
	});
});

describe("FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM", () => {
	it("refuses an after-submit link into a case list registration form", () => {
		const doc = docWith(
			{},
			{
				uuid: OTHER_MODULE,
				name: "Intake",
				forms: [
					{
						uuid: OTHER_FORM,
						name: "Intake survey",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
						formLinks: [
							{
								uuid: testUuid("00000000-0000-4000-8000-0000000d0021"),
								target: {
									type: "form",
									moduleUuid: MODULE,
									formUuid: REGISTER,
								},
							},
						],
					},
				],
			},
		);
		const messages = codes(doc, "FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			'targets "Register patient" in "Patients", which opens only when a search finds nothing and is on no menu. You can target the menu instead, so the worker searches, or another form.',
		);
	});
});

describe("INVALID_SEARCH_REF", () => {
	it("admits #search/<name> inside the case list registration form", () => {
		const doc = docWith({
			forms: [registerForm({ fields: [nameField(NAME_INPUT)] })],
		});
		expect(codes(doc, "INVALID_SEARCH_REF")).toEqual([]);
	});

	const visitReading = (): FormSpec => ({
		uuid: VISIT,
		name: "Visit",
		type: "followup",
		fields: [
			f({
				kind: "text",
				id: "note",
				label: proseText("Note"),
				default_value: {
					kind: "term",
					term: { kind: "input", searchInputUuid: NAME_INPUT },
				},
			}),
		],
	});

	it("admits a search answer read in a form of a menu whose forms read the search", () => {
		const doc = docWith({ forms: [visitReading(), registerForm()] });
		expect(codes(doc, "INVALID_SEARCH_REF")).toEqual([]);
	});

	it("refuses a search answer read in a form of a menu whose forms don't read the search", () => {
		const doc = docWith({
			caseSearchConfig: {},
			caseListRegistrationForm: undefined,
			forms: [visitReading()],
		});
		const messages = codes(doc, "INVALID_SEARCH_REF");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			"only in the forms of a menu whose forms read the search",
		);
	});

	it("refuses a search answer whose prompt the module no longer has", () => {
		const doc = docWith({
			forms: [registerForm({ fields: [nameField(GONE_INPUT)] })],
		});
		const messages = codes(doc, "INVALID_SEARCH_REF");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			"a Search field that is no longer on this case list",
		);
	});
});

describe("case list registration return cardinality", () => {
	it("requires explicit firstMenu for a multiple-selection host", () => {
		const doc = docWith({ forms: [visitForm(), registerForm({})] });
		doc.modules[MODULE].caseListConfig = {
			...searchList(),
			selection: { kind: "multiple", maximum: 5 },
		};
		expect(codes(doc, "CASE_LIST_REGISTRATION_MULTIPLE_RETURN")).toEqual([
			`"Register patient" registers one case, but "Patients" selects several cases, and CommCare can't carry that new case back into the search. You can set the form's after-submit destination to First menu, or let "Patients" select one case.`,
		]);
		const returningHome = structuredClone(doc);
		returningHome.forms[REGISTER].postSubmit = "firstMenu";
		expect(
			codes(returningHome, "CASE_LIST_REGISTRATION_MULTIPLE_RETURN"),
		).toEqual([]);
		expect(
			codes(returningHome, "CASE_LIST_REGISTRATION_HAS_NAVIGATION"),
		).toEqual([]);
	});
});
