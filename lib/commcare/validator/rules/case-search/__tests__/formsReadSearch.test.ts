/**
 * Tests for the refusals in `formsReadSearch.ts`, each enforcing Nova entry
 * shape plus actual HQ instance-name refusals over the inline flag
 * (`caseSearchConfig.formsReadSearch`), never the workflow. A form's
 * "previous" in a menu whose forms read the search is
 * `POST_SUBMIT_NOT_OFFERED`'s (`rules/form.ts`). Selected native HQ methods
 * run in proof/native/test_search_validation.py.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type DocSpec,
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
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../../runner";

const FOLLOWUP = testUuid("00000000-0000-4000-8000-0000000b0001");
const FOLLOWUP_FORM = testUuid("00000000-0000-4000-8000-0000000b0002");
const OTHER = testUuid("00000000-0000-4000-8000-0000000b0003");

function searchList(): NonNullable<Module["caseListConfig"]> {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-0000000b0010"),
			"case_name",
			"Name",
			"text",
			"case_name",
		),
	];
	return config;
}

const question = () =>
	f({ kind: "text", id: "question1", label: proseText("Question 1") });

function docWith(
	readingModule: Partial<ModuleSpec>,
	other?: ModuleSpec,
	caseTypes?: DocSpec["caseTypes"],
): BlueprintDoc {
	return buildDoc({
		appName: "T",
		modules: [
			{
				uuid: FOLLOWUP,
				name: "Followup",
				caseType: "patient",
				caseListConfig: searchList(),
				caseSearchConfig: { formsReadSearch: true },
				forms: [
					{
						uuid: FOLLOWUP_FORM,
						name: "Visit",
						type: "followup",
						fields: [question()],
					},
				],
				...readingModule,
			},
			...(other === undefined ? [] : [other]),
		],
		caseTypes: caseTypes ?? [
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

const registrationForm = () => ({
	name: "Register",
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

const visitForm = () => ({
	uuid: FOLLOWUP_FORM,
	name: "Visit",
	type: "followup" as const,
	fields: [question()],
});

const childModule = (): ModuleSpec => ({
	uuid: OTHER,
	name: "Child",
	caseType: "patient",
	caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
	forms: [{ name: "Note", type: "followup", fields: [question()] }],
});

const buttonCondition = () => eq(sessionUser("username"), literal("alice"));

describe("formsReadSearchRequiresCaseFirstModule", () => {
	const CODE = "FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE";

	it("admits a case-first menu and a bare case list", () => {
		expect(codes(docWith({}), CODE)).toEqual([]);
		expect(
			codes(docWith({ caseListMenuItem: {}, forms: undefined }), CODE),
		).toEqual([]);
	});

	it("refuses a menu with a registration form", () => {
		const doc = docWith({ forms: [visitForm(), registrationForm()] });
		expect(codes(doc, CODE)).toEqual([
			`Module "Followup" has its forms read the search, which runs the search as each case form opens, so the menu's first screen has to choose a case, and it doesn't: the menu needs a case type and only forms that work on an existing case, or no forms at all. You can move its registration or survey forms to another menu, or turn off Forms read the search (formsReadSearch null), so the menu searches first and each form reads the case it opens.`,
		]);
	});

	it("refuses a bare case list with no case type", () => {
		const doc = docWith({
			caseType: undefined,
			caseListMenuItem: {},
			forms: undefined,
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => error.code),
		).toEqual([
			"CASE_LIST_MENU_ITEM_NO_CASE_TYPE",
			"CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE",
			CODE,
		]);
	});

	it("is silent when the menu searches first without its forms reading it", () => {
		const doc = docWith({
			caseSearchConfig: {},
			forms: [visitForm(), registrationForm()],
		});
		expect(codes(doc, CODE)).toEqual([]);
	});
});

describe("formsReadSearchNoButtonDisplayCondition", () => {
	const CODE = "FORMS_READ_SEARCH_NO_BUTTON_DISPLAY_CONDITION";

	it("refuses a Search button condition where the forms read the search", () => {
		const doc = docWith({
			caseSearchConfig: {
				formsReadSearch: true,
				searchButtonDisplayCondition: buttonCondition(),
			},
		});
		expect(codes(doc, CODE)).toEqual([
			`Module "Followup" has its forms read the search, so it has no Search button for its button condition to show or hide. You can clear the condition, or turn off Forms read the search (formsReadSearch null) to bring the Search button back.`,
		]);
	});

	it("admits the same condition on a menu that searches first", () => {
		const doc = docWith({
			caseSearchConfig: { searchButtonDisplayCondition: buttonCondition() },
		});
		expect(codes(doc, CODE)).toEqual([]);
	});
});

describe("formsReadSearchUniqueInstance", () => {
	const CODE = "FORMS_READ_SEARCH_UNIQUE_INSTANCE";

	it("refuses a submenu under a menu whose forms read the search, on both menus", () => {
		const doc = docWith({}, childModule());
		doc.modules[OTHER].parentModuleUuid = FOLLOWUP;
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.code === CODE,
		);
		expect(hits.map((hit) => [hit.location.moduleUuid, hit.message])).toEqual([
			[
				FOLLOWUP,
				`Module "Followup" has its forms read the search and has submenus. CommCare gives a submenu the same search results as its parent and can't tell them apart. You can move the submenus to the top level, or turn off Forms read the search.`,
			],
			[
				OTHER,
				`Module "Child" is a submenu under "Followup", whose forms read the search. CommCare gives both menus the same search results and can't tell them apart. You can move "Child" to the top level, or turn off Forms read the search on "Followup".`,
			],
		]);
	});

	it("refuses a module that chooses its parent from a menu whose forms read the search", () => {
		const doc = docWith(
			{},
			{ ...childModule(), name: "Children", caseType: "child" },
			[
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "child",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		);
		doc.modules[OTHER].parentCaseModuleUuid = FOLLOWUP;
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.code === CODE,
		);
		expect(hits.map((hit) => [hit.location.moduleUuid, hit.message])).toEqual([
			[
				OTHER,
				`Module "Children" chooses a parent case from "Followup" first, and "Followup"'s forms read the search. CommCare gives both choices the same search results and can't tell them apart. You can turn off Forms read the search on "Followup", or choose the parent case from another menu or a flat list.`,
			],
		]);
	});

	it("admits a menu whose forms read the search choosing ITS parent from an ordinary menu", () => {
		const doc = docWith(
			{ caseType: "child" },
			{ ...childModule(), name: "Parents" },
			[
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "child",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		);
		doc.modules[FOLLOWUP].parentCaseModuleUuid = OTHER;
		expect(codes(doc, CODE)).toEqual([]);
	});

	it("is silent for ordinary nesting", () => {
		const doc = docWith({ caseSearchConfig: undefined }, childModule());
		doc.modules[OTHER].parentModuleUuid = FOLLOWUP;
		expect(codes(doc, CODE)).toEqual([]);
	});
});

describe("formsReadSearchWithListFirst", () => {
	const CODE = "FORMS_READ_SEARCH_WITH_LIST_FIRST";

	/** The stored schema refuses this pair, so only a batch's candidate
	 *  reaches it; the rule is what refuses that batch. */
	it("refuses list first beside Forms read the search", () => {
		const doc = docWith({});
		doc.modules[FOLLOWUP].caseSearchConfig = {
			workflow: "listFirst",
			formsReadSearch: true,
		};
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.code === CODE,
		);
		expect(hits.map((hit) => [hit.location.moduleUuid, hit.message])).toEqual([
			[
				FOLLOWUP,
				`Module "Followup" opens on its case list first, so its forms can't read the search, which runs only when the menu opens on Search first or on its results. You can choose Search first or Results first (searchWorkflow), or turn off Forms read the search (formsReadSearch null).`,
			],
		]);
	});

	it("admits each workflow without Forms read the search, and Forms read the search on the other two", () => {
		for (const caseSearchConfig of [
			{ workflow: "listFirst" as const },
			{ workflow: "skipToResults" as const },
			{},
			{ workflow: "skipToResults" as const, formsReadSearch: true as const },
			{ formsReadSearch: true as const },
		]) {
			expect(codes(docWith({ caseSearchConfig }), CODE)).toEqual([]);
		}
	});
});

describe("a menu that searches first without its forms reading the search", () => {
	/** Every rule above reads the inline flag, so a search-first menu with a
	 *  Search button condition and a submenu sends no inline instance and
	 *  meets none of them. */
	it("passes every rule with a button condition and a submenu", () => {
		const doc = docWith(
			{
				caseSearchConfig: { searchButtonDisplayCondition: buttonCondition() },
				forms: [visitForm(), registrationForm()],
			},
			childModule(),
		);
		doc.modules[OTHER].parentModuleUuid = FOLLOWUP;
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});
