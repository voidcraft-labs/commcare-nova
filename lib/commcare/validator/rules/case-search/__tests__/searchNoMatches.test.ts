/**
 * Tests for the no-matches registration form's refusals
 * (`searchNoMatches.ts`, the link-target arm in `rules/form.ts`, and the
 * `#search/` leaf check in `validator/index.ts`), each mirroring what the
 * `case_list_form` lowering can and cannot express on the wire.
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
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Module,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/predicate";
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

function nameField(searchInputUuid?: string) {
	return f({
		kind: "text",
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType: "patient", property: "case_name" },
		...(searchInputUuid === undefined
			? {}
			: {
					default_value: {
						parts: [{ kind: "search-answer-ref", searchInputUuid }],
					},
				}),
	});
}

function registerForm(overrides: Partial<FormSpec> = {}): FormSpec {
	return {
		uuid: REGISTER,
		name: "Register patient",
		type: "registration",
		entry: { kind: "search-no-matches" },
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
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
					registerForm(),
				],
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
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.filter((error) => error.code === code)
		.map((error) => error.message);
}

describe("searchNoMatchesEntry", () => {
	it("admits a registration form with the entry in a search-first module", () => {
		const doc = docWith();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("requires the module to open on Search", () => {
		const doc = docWith({ caseSearchConfig: undefined });
		const messages = codes(
			doc,
			"SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST",
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('"Register patient"');
		expect(messages[0]).toContain("Turn Search first on");
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
		const messages = codes(doc, "SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("it is a followup form");
	});

	it("refuses after-submit links, an after-submit choice, and a display condition", () => {
		const doc = docWith({
			forms: [
				{
					uuid: VISIT,
					name: "Visit",
					type: "followup",
					fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
				},
				registerForm({
					postSubmit: "module",
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
		const messages = codes(doc, "SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("after-submit links");
		expect(messages[0]).toContain("an after-submit destination");
		expect(messages[0]).toContain("a display condition");
	});

	it("needs a menu form on a host that selects a parent case first", () => {
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
		// The menu form's parent datum is what the Register action copies.
		expect(
			codes(
				withParent(docWith({}, households)),
				"SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM",
			),
		).toEqual([]);
		const formless = withParent(
			docWith({ caseListOnly: true, forms: [registerForm()] }, households),
		);
		const messages = codes(
			formless,
			"SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM",
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("has no menu form");
		// Without the parent relationship a formless host is fine.
		expect(
			codes(
				docWith({ caseListOnly: true, forms: [registerForm()] }),
				"SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM",
			),
		).toEqual([]);
	});
});

describe("searchNoMatchesFormUnique", () => {
	it("refuses a second no-matches form on one module", () => {
		const doc = docWith({
			forms: [
				registerForm(),
				registerForm({
					uuid: testUuid("00000000-0000-4000-8000-0000000d0006"),
					name: "Register again",
				}),
			],
		});
		const messages = codes(doc, "SEARCH_NO_MATCHES_DUPLICATE");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('"Register patient", "Register again"');
	});
});

describe("FORM_LINK_TARGET_NO_MATCHES_FORM", () => {
	it("refuses an after-submit link into a no-matches form", () => {
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
		const messages = codes(doc, "FORM_LINK_TARGET_NO_MATCHES_FORM");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('targets "Register patient"');
	});
});

describe("INVALID_SEARCH_REF", () => {
	it("admits #search/<name> inside the no-matches form", () => {
		const doc = docWith({
			forms: [registerForm({ fields: [nameField(NAME_INPUT)] })],
		});
		expect(codes(doc, "INVALID_SEARCH_REF")).toEqual([]);
	});

	it("refuses a search answer read outside a no-matches form", () => {
		const doc = docWith({
			forms: [
				{
					uuid: VISIT,
					name: "Visit",
					type: "followup",
					fields: [
						f({
							kind: "text",
							id: "note",
							label: proseText("Note"),
							default_value: {
								parts: [
									{ kind: "search-answer-ref", searchInputUuid: NAME_INPUT },
								],
							},
						}),
					],
				},
			],
		});
		const messages = codes(doc, "INVALID_SEARCH_REF");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			"only a form that opens after a search finds no matches",
		);
	});

	it("refuses a search answer whose prompt the module no longer has", () => {
		const doc = docWith({
			forms: [registerForm({ fields: [nameField(GONE_INPUT)] })],
		});
		const messages = codes(doc, "INVALID_SEARCH_REF");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("a Search prompt this module no longer has");
	});
});

describe("no-matches registration return cardinality", () => {
	it("requires explicit App home for a multiple-selection host", () => {
		const doc = docWith({
			forms: [
				{
					uuid: VISIT,
					name: "Visit",
					type: "followup",
					fields: [f({ kind: "text", id: "note" })],
				},
				registerForm({}),
			],
		});
		doc.modules[MODULE].caseListConfig = {
			...searchList(),
			selection: { kind: "multiple", maximum: 5 },
		};
		expect(codes(doc, "SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN")).toHaveLength(
			1,
		);
		doc.forms[REGISTER].postSubmit = "app_home";
		expect(codes(doc, "SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN")).toEqual([]);
		expect(codes(doc, "SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION")).toEqual([]);
	});
});
