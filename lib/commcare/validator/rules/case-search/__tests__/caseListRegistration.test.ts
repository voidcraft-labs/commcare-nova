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
	type CaseOperation,
	type Module,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import {
	registrationMintsOwnCaseId,
	rootBasicSubcaseCreates,
} from "@/lib/domain/basicCaseSlots";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import { formField, gt, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { errorWithinScope, runValidation } from "../../../runner";

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

// ── Both arms through one app rule ─────────────────────────────────────

const INTAKE = testUuid("00000000-0000-4000-8000-0000000d0030");
const REG = testUuid("00000000-0000-4000-8000-0000000d0031");
const CLINIC = testUuid("00000000-0000-4000-8000-0000000d0032");
const CHECKUP = testUuid("00000000-0000-4000-8000-0000000d0033");
const HOUSEHOLDS = testUuid("00000000-0000-4000-8000-0000000d0034");
const HOUSE_VISIT = testUuid("00000000-0000-4000-8000-0000000d0035");
const SURVEY = testUuid("00000000-0000-4000-8000-0000000d0036");
const GONE_FORM = testUuid("00000000-0000-4000-8000-0000000d0037");
const NAME_F = testUuid("00000000-0000-4000-8000-0000000d0040");
const AGE_F = testUuid("00000000-0000-4000-8000-0000000d0041");
const KIDS_F = testUuid("00000000-0000-4000-8000-0000000d0042");
const KID_NAME_F = testUuid("00000000-0000-4000-8000-0000000d0043");
const SECOND = testUuid("00000000-0000-4000-8000-0000000d0044");

const checkup = (uuid = CHECKUP, name = "Checkup"): FormSpec => ({
	uuid,
	name,
	type: "followup",
	fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
});

/** The registration form the `always` arm names, in Intake: a name that
 *  saves the patient's name, an age and a repeat of kids. */
function intakeForm(overrides: Partial<FormSpec> = {}): FormSpec {
	return {
		uuid: REG,
		name: "Register patient",
		type: "registration",
		fields: [
			f({
				uuid: NAME_F,
				kind: "text",
				id: "case_name",
				label: proseText("Name"),
				caseWrite: { caseType: "patient", property: "case_name" },
			}),
			f({ uuid: AGE_F, kind: "int", id: "age", label: proseText("Age") }),
			f({
				uuid: KIDS_F,
				kind: "repeat",
				id: "kids",
				label: proseText("Kids"),
				repeat_mode: "user_controlled",
				children: [
					f({
						uuid: KID_NAME_F,
						kind: "text",
						id: "kid_name",
						label: proseText("Kid's name"),
					}),
				],
			}),
		],
		...overrides,
	};
}

interface AlwaysShape {
	readonly afterSubmit?: "case-list" | "new-case";
	readonly formUuid?: Uuid;
	readonly register?: Partial<FormSpec>;
	readonly intake?: Partial<ModuleSpec>;
	readonly clinic?: Partial<ModuleSpec>;
	/** Extra modules, after Clinic. */
	readonly more?: readonly ModuleSpec[];
	readonly caseTypes?: NonNullable<Parameters<typeof buildDoc>[0]>["caseTypes"];
	readonly configure?: (doc: BlueprintDoc) => void;
}

const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);

/** Intake holds "Register patient"; Clinic's case list always offers it. */
function alwaysDoc(shape: AlwaysShape = {}): BlueprintDoc {
	return buildDoc(
		{
			appName: "Clinic",
			caseTypes: shape.caseTypes ?? [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "kid",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: INTAKE,
					name: "Intake",
					caseType: "patient",
					caseListConfig: list(),
					forms: [intakeForm(shape.register)],
					...shape.intake,
				},
				{
					uuid: CLINIC,
					name: "Clinic",
					caseType: "patient",
					caseListConfig: list(),
					forms: [checkup()],
					...shape.clinic,
				},
				...(shape.more ?? []),
			],
		},
		(doc) => {
			doc.modules[CLINIC] = {
				...doc.modules[CLINIC],
				caseListRegistrationForm: {
					kind: "always",
					formUuid: shape.formUuid ?? REG,
					afterSubmit: shape.afterSubmit ?? "case-list",
				},
			};
			shape.configure?.(doc);
		},
	);
}

/** Intake alone, offering its own "Register patient" when a search finds
 *  nothing. */
function afterEmptySearchIntakeDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "kid",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: INTAKE,
				name: "Intake",
				caseType: "patient",
				caseListConfig: searchList(),
				caseSearchConfig: { formsReadSearch: true },
				caseListMenuItem: {},
				caseListRegistrationForm: { formUuid: REG },
				forms: [intakeForm()],
			},
		],
	});
}

/** Every case list registration finding: code, reason and message. */
function registrationFindings(doc: BlueprintDoc) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.filter((error) => error.code.startsWith("CASE_LIST_REGISTRATION_"))
		.map((error) => ({
			code: error.code,
			moduleUuid: error.location.moduleUuid,
			reason: error.details?.reason,
			message: error.message,
		}));
}

/** A create of a second case at the form's root (or in `repeat`), linked
 *  as a child of the form's own new case. */
function addCreate(
	doc: BlueprintDoc,
	formUuid: Uuid,
	caseType: string,
	extra: { readonly repeat?: Uuid; readonly held?: boolean } = {},
): void {
	const form = doc.forms[formUuid];
	const own = form.caseOperations?.[0];
	if (own?.action !== "own") throw new Error("The form has its own case.");
	const create = {
		uuid: SECOND,
		id: "second_case",
		action: "create",
		caseType,
		target: { kind: "new" },
		name: term(formField(extra.repeat === undefined ? NAME_F : KID_NAME_F)),
		links: [
			{
				identifier: "parent",
				targetType: "patient",
				target: { kind: "op", opUuid: own.uuid },
				relationship: "child",
			},
		],
		...(extra.repeat !== undefined && { forEach: { repeat: extra.repeat } }),
		...(extra.held === true && {
			placement: {
				kind: "save-to-case",
				path: ["nova_operations", "second_case"],
			},
		}),
	} as CaseOperation;
	doc.forms[formUuid] = {
		...form,
		caseOperations: [...(form.caseOperations ?? []), create],
	};
}

describe("caseListRegistrationApp: the always arm", () => {
	it("admits another menu's registration form, which stays on its menu", () => {
		for (const afterSubmit of ["case-list", "new-case"] as const) {
			const doc = alwaysDoc({ afterSubmit });
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			expect(doc.formOrder[INTAKE]).toEqual([REG]);
		}
	});

	it("admits the form's own links, after-submit, display condition and off-the-menu flag, which the after-empty-search arm refuses", () => {
		const doc = alwaysDoc({
			register: {
				displayCondition: eq(sessionUser("username"), literal("ada")),
				formLinks: [
					{
						uuid: testUuid("00000000-0000-4000-8000-0000000d0045"),
						target: { type: "form", moduleUuid: CLINIC, formUuid: CHECKUP },
					},
				],
			},
		});
		expect(registrationFindings(doc)).toEqual([]);
		const offMenu = alwaysDoc({
			register: { postSubmit: "firstMenu" },
			configure: (draft) => {
				draft.forms[REG].hiddenFromMenu = true;
			},
		});
		expect(registrationFindings(offMenu)).toEqual([]);
	});

	it("asks the host's forms to read no search", () => {
		const doc = alwaysDoc({ clinic: { caseSearchConfig: {} } });
		expect(
			registrationFindings(doc).map((finding) => finding.code),
		).not.toContain("CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH");
	});

	it("refuses a form no longer in the app", () => {
		expect(registrationFindings(alwaysDoc({ formUuid: GONE_FORM }))).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_FORM_NOT_FOUND",
				moduleUuid: CLINIC,
				reason: undefined,
				message: `"Clinic" offers a registration form on its case list, but that form is no longer in the app. You can choose another registration form, or stop offering one (register_from_case_list null).`,
			},
		]);
	});

	it("refuses a form that is not a registration form", () => {
		const doc = alwaysDoc({
			formUuid: SURVEY,
			intake: {
				forms: [
					intakeForm(),
					{
						uuid: SURVEY,
						name: "Intake survey",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		});
		expect(registrationFindings(doc)).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_NOT_REGISTRATION",
				moduleUuid: CLINIC,
				reason: "form-type",
				message: `"Clinic" offers "Intake survey" on its case list, so "Intake survey" needs to register a new "patient" case, and it is a survey form. You can choose a registration form, or stop offering it there.`,
			},
		]);
	});

	it("refuses a registration form of another case type", () => {
		const doc = alwaysDoc({
			intake: { caseType: "kid" },
			register: {
				fields: [
					f({
						uuid: NAME_F,
						kind: "text",
						id: "case_name",
						label: proseText("Name"),
						caseWrite: { caseType: "kid", property: "case_name" },
					}),
				],
			},
		});
		expect(registrationFindings(doc)).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_NOT_REGISTRATION",
				moduleUuid: CLINIC,
				reason: "case-type",
				message: `"Clinic" lists "patient" cases and offers "Register patient" on its case list, but "Register patient" registers a "kid" case in "Intake". You can choose a form that registers a "patient" case, or stop offering it there.`,
			},
		]);
	});

	it("refuses a form whose own case Save to Case holds", () => {
		const doc = alwaysDoc({
			register: { openCondition: gt(term(formField(AGE_F)), literal(18)) },
		});
		expect(registrationMintsOwnCaseId(doc, REG)).toBe(false);
		expect(registrationFindings(doc)).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_NOT_REGISTRATION",
				moduleUuid: CLINIC,
				reason: "own-case-save-to-case",
				message: `"Clinic" offers "Register patient" on its case list, so CommCare HQ needs Case Management to register its new "patient" case, and "Register patient" saves that case through Save to Case. You can change the form's case so Case Management can hold it, or stop offering it there.`,
			},
		]);
	});

	it("refuses a form that also registers a case of the list's type at its root", () => {
		const doc = alwaysDoc();
		addCreate(doc, REG, "patient");
		expect(rootBasicSubcaseCreates(doc, REG)).toEqual([
			{ operationUuid: SECOND, caseType: "patient" },
		]);
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.code === "CASE_LIST_REGISTRATION_NOT_REGISTRATION",
		);
		expect(findings.map((error) => [error.details, error.message])).toEqual([
			[
				{
					formUuid: REG,
					formName: "Register patient",
					kind: "always",
					caseType: "patient",
					reason: "several-registrations",
					operationUuid: SECOND,
				},
				`"Clinic" offers "Register patient" on its case list, but "Register patient" registers more than one "patient" case, and CommCare HQ offers a form from a case list only where it registers one. You can move the other "patient" case into a repeat or to another form, or stop offering "Register patient" there.`,
			],
		]);
	});

	it("counts no child of another type, no child in a repeat and no child Save to Case holds", () => {
		const otherType = alwaysDoc();
		addCreate(otherType, REG, "kid");
		const inRepeat = alwaysDoc();
		addCreate(inRepeat, REG, "patient", { repeat: KIDS_F });
		const held = alwaysDoc();
		addCreate(held, REG, "patient", { held: true });
		for (const doc of [otherType, inRepeat, held]) {
			expect(
				rootBasicSubcaseCreates(doc, REG).filter(
					(create) => create.caseType === "patient",
				),
			).toEqual([]);
			expect(
				registrationFindings(doc).map((finding) => finding.reason),
			).not.toContain("several-registrations");
		}
	});

	it("refuses a form another menu offers after a search finds nothing", () => {
		const doc = alwaysDoc({
			intake: {
				caseListConfig: searchList(),
				caseSearchConfig: { formsReadSearch: true },
				caseListMenuItem: {},
				caseListRegistrationForm: { formUuid: REG },
			},
		});
		expect(
			registrationFindings(doc).filter(
				(finding) => finding.moduleUuid === CLINIC,
			),
		).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_NOT_REGISTRATION",
				moduleUuid: CLINIC,
				reason: "after-empty-search-form",
				message: `"Clinic" offers "Register patient" on its case list, but "Register patient" opens only after a search finds nothing in "Intake", so it is on no menu to offer from. You can choose a registration form that is on a menu, or stop offering it there.`,
			},
		]);
	});

	it("refuses a host with no case type", () => {
		const doc = alwaysDoc({
			clinic: {
				caseType: undefined,
				caseListConfig: undefined,
				forms: [
					{
						uuid: CHECKUP,
						name: "Checkup",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		});
		expect(registrationFindings(doc)).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST",
				moduleUuid: CLINIC,
				reason: "no-case-type",
				message: `"Clinic" offers "Register patient" on its case list, but "Clinic" has no case type, so it has no case list to offer it from. You can set its case type, or stop offering "Register patient" there.`,
			},
		]);
	});

	it("refuses a host with a form that opens without a case", () => {
		const doc = alwaysDoc({
			clinic: {
				forms: [
					checkup(),
					{
						uuid: SURVEY,
						name: "Clinic survey",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		});
		expect(registrationFindings(doc)).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST",
				moduleUuid: CLINIC,
				reason: "form-opens-without-a-case",
				message: `"Clinic" offers "Register patient" on its case list, but "Clinic survey" in "Clinic" opens without a case, and CommCare HQ offers registration from a case list only where every form of the menu opens a case. You can move "Clinic survey" to another menu, or stop offering "Register patient" on the list.`,
			},
		]);
	});

	it("refuses a host that shows its forms in the menu above", () => {
		const doc = alwaysDoc({
			configure: (draft) => {
				draft.modules[CLINIC].formsInMenuAbove = true;
			},
		});
		expect(
			registrationFindings(doc).filter(
				(finding) =>
					finding.code === "CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE",
			),
		).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE",
				moduleUuid: CLINIC,
				reason: "host",
				message: `"Clinic" shows its forms in the menu above, and CommCare offers no Register on the case list of such a menu, so "Register patient" would never be offered. You can give "Clinic" its own screen again (forms_in_menu_above null), or stop offering "Register patient" there.`,
			},
		]);
	});

	/** Households shows its forms on the first menu, each opening a chosen
	 *  patient; Clinic is its submenu with a screen of its own. */
	function underSharedCase(shape: AlwaysShape = {}): BlueprintDoc {
		return buildDoc(
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
						uuid: HOUSEHOLDS,
						name: "Households",
						caseType: "patient",
						caseListConfig: list(),
						forms: [checkup(HOUSE_VISIT, "Household visit")],
					},
					{
						uuid: CLINIC,
						name: "Clinic",
						caseType: "patient",
						caseListConfig: list(),
						forms: [checkup()],
					},
					{
						uuid: INTAKE,
						name: "Intake",
						caseType: "patient",
						caseListConfig: list(),
						forms: [intakeForm(shape.register)],
					},
				],
			},
			(doc) => {
				doc.modules[HOUSEHOLDS].formsInMenuAbove = true;
				doc.modules[CLINIC] = {
					...doc.modules[CLINIC],
					parentModuleUuid: HOUSEHOLDS,
					caseListRegistrationForm: {
						kind: "always",
						formUuid: REG,
						afterSubmit: shape.afterSubmit ?? "case-list",
					},
				};
			},
		);
	}

	it("refuses a return whose frame would open with the first menu's shared case", () => {
		expect(
			registrationFindings(underSharedCase({ afterSubmit: "new-case" })),
		).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE",
				moduleUuid: CLINIC,
				reason: "parent-shares-first-menu-case",
				message: `"Clinic" is under "Households", which shows its forms on the app's first menu, where every form listed that way opens one chosen case. CommCare HQ would put that case ahead of "Clinic" when a worker returns from "Register patient". You can give "Households" its own screen again (forms_in_menu_above null), or stop offering "Register patient" there.`,
			},
		]);
	});

	it("admits a return cut before the shared case, and no return where the form's own after-submit is in force", () => {
		expect(registrationFindings(underSharedCase())).toEqual([]);
		expect(
			registrationFindings(
				underSharedCase({
					afterSubmit: "new-case",
					register: { postSubmit: "firstMenu" },
				}),
			),
		).toEqual([]);
	});

	it("refuses carrying the new case into a selection of several", () => {
		const several = (afterSubmit: "case-list" | "new-case") =>
			alwaysDoc({
				afterSubmit,
				clinic: {
					caseListConfig: {
						...list(),
						selection: { kind: "multiple", maximum: 5 },
					},
				},
			});
		expect(registrationFindings(several("new-case"))).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_MULTIPLE_RETURN",
				moduleUuid: CLINIC,
				reason: undefined,
				message: `"Register patient" registers one case, but "Clinic" selects several cases, and CommCare can't carry that one new case into a selection of several. You can set After registering to Back to this list (after_submit "case-list"), or let "Clinic" select one case.`,
			},
		]);
		expect(registrationFindings(several("case-list"))).toEqual([]);
	});

	it("refuses an advanced host, and a form of an advanced menu", () => {
		const host = alwaysDoc({
			configure: (draft) => {
				draft.modules[CLINIC].heldKind = "advanced";
			},
		});
		expect(registrationFindings(host)).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_ADVANCED_MENU",
				moduleUuid: CLINIC,
				reason: "host",
				message: `"Clinic" is kept in CommCare HQ as an advanced menu, and Nova doesn't offer registration from an advanced menu's case list. You can stop offering "Register patient" there.`,
			},
		]);
		const form = alwaysDoc({
			configure: (draft) => {
				draft.modules[INTAKE].heldKind = "advanced";
			},
		});
		expect(
			registrationFindings(form).filter(
				(finding) => finding.code === "CASE_LIST_REGISTRATION_ADVANCED_MENU",
			),
		).toEqual([
			{
				code: "CASE_LIST_REGISTRATION_ADVANCED_MENU",
				moduleUuid: CLINIC,
				reason: "form",
				message: `"Register patient" is in "Intake", which CommCare HQ keeps as an advanced menu, and Nova doesn't offer a form of an advanced menu from a case list. You can choose a registration form in another menu, or stop offering it there.`,
			},
		]);
	});

	it("is reported by a run scoped to the form's menu, as by the full run", () => {
		const doc = alwaysDoc({
			formUuid: SURVEY,
			intake: {
				forms: [
					intakeForm(),
					{
						uuid: SURVEY,
						name: "Intake survey",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		});
		const scope = {
			moduleUuids: new Set([INTAKE]),
			formUuids: new Set([SURVEY]),
		};
		const full = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { scope });
		expect(scoped).toEqual(
			full.filter((error) => errorWithinScope(error, scope)),
		);
		expect(scoped.map((error) => error.code)).toContain(
			"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
		);
	});
});

describe("caseListRegistrationApp: the after-empty-search arm", () => {
	it("refuses a form that also registers a case of its menu's type at its root", () => {
		const doc = docWith();
		const form = doc.forms[REGISTER];
		const own = form.caseOperations?.[0];
		if (own?.action !== "own") throw new Error("The form has its own case.");
		const nameUuid = (doc.fieldOrder[REGISTER] ?? [])[0];
		doc.forms[REGISTER] = {
			...form,
			caseOperations: [
				...(form.caseOperations ?? []),
				{
					uuid: SECOND,
					id: "second_case",
					action: "create",
					caseType: "patient",
					target: { kind: "new" },
					name: term(formField(nameUuid)),
					links: [
						{
							identifier: "parent",
							targetType: "patient",
							target: { kind: "op", opUuid: own.uuid },
							relationship: "child",
						},
					],
				} as CaseOperation,
			],
		};
		expect(findings(doc, "CASE_LIST_REGISTRATION_NOT_REGISTRATION")).toEqual([
			{
				moduleUuid: MODULE,
				formUuid: undefined,
				details: {
					formUuid: REGISTER,
					formName: "Register patient",
					reason: "several-registrations",
					caseType: "patient",
					operationUuid: SECOND,
				},
				message: `Module "Patients" offers "Register patient" when a search finds nothing, but "Register patient" registers more than one "patient" case, and CommCare HQ offers a form from a case list only where it registers one. You can move the other "patient" case into a repeat or to another form, or stop offering "Register patient" there.`,
			},
		]);
	});

	it("counts no child of another type, no child in a repeat and no child Save to Case holds", () => {
		const sameType = afterEmptySearchIntakeDoc();
		addCreate(sameType, REG, "patient");
		expect(
			registrationFindings(sameType).map((finding) => [
				finding.code,
				finding.moduleUuid,
				finding.reason,
			]),
		).toEqual([
			[
				"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
				INTAKE,
				"several-registrations",
			],
		]);
		const otherType = afterEmptySearchIntakeDoc();
		addCreate(otherType, REG, "kid");
		const inRepeat = afterEmptySearchIntakeDoc();
		addCreate(inRepeat, REG, "patient", { repeat: KIDS_F });
		const held = afterEmptySearchIntakeDoc();
		addCreate(held, REG, "patient", { held: true });
		for (const doc of [otherType, inRepeat, held]) {
			expect(
				rootBasicSubcaseCreates(doc, REG).filter(
					(create) => create.caseType === "patient",
				),
			).toEqual([]);
			expect(
				registrationFindings(doc).map((finding) => finding.reason),
			).not.toContain("several-registrations");
		}
	});

	it("gives no always-arm finding to the form it offers on no menu", () => {
		const doc = docWith();
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).toEqual([]);
	});

	it("is reported by a run scoped away from the module, as by the filtered full run", () => {
		const doc = docWith(
			{
				forms: [
					visitForm(),
					registerForm({
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					}),
				],
			},
			{
				uuid: OTHER_MODULE,
				name: "Intake",
				forms: [
					{
						uuid: OTHER_FORM,
						name: "Intake survey",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		);
		const scope = {
			moduleUuids: new Set([OTHER_MODULE]),
			formUuids: new Set([OTHER_FORM]),
		};
		const full = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { scope });
		expect(full.map((error) => error.code)).toContain(
			"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
		);
		expect(scoped).toEqual(
			full.filter((error) => errorWithinScope(error, scope)),
		);
	});

	it("reports the return of a host that selects several cases to a run scoped away from it, as the filtered full run does", () => {
		const doc = docWith(
			{ forms: [visitForm(), registerForm()] },
			{
				uuid: OTHER_MODULE,
				name: "Intake",
				forms: [
					{
						uuid: OTHER_FORM,
						name: "Intake survey",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		);
		doc.modules[MODULE].caseListConfig = {
			...searchList(),
			selection: { kind: "multiple", maximum: 5 },
		};
		const scope = {
			moduleUuids: new Set([OTHER_MODULE]),
			formUuids: new Set([OTHER_FORM]),
		};
		const full = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { scope });
		expect(full.map((error) => error.code)).toEqual([
			"CASE_LIST_REGISTRATION_MULTIPLE_RETURN",
		]);
		expect(scoped).toEqual(
			full.filter((error) => errorWithinScope(error, scope)),
		);
	});
});
