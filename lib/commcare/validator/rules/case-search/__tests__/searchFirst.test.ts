/**
 * Tests for the four search-first refusals in `searchFirst.ts`, each
 * mirroring a CommCare HQ build-validator refusal of the inline search
 * shape (`helpers/validators.py`).
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
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Module,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/predicate";
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
	searchFirstModule: Partial<ModuleSpec>,
	other?: ModuleSpec,
	caseTypes?: DocSpec["caseTypes"],
): BlueprintDoc {
	return buildDoc({
		appName: "T",
		modules: [
			{
				uuid: FOLLOWUP,
				name: "Followup",
				caseType: "case",
				caseListConfig: searchList(),
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: FOLLOWUP_FORM,
						name: "Visit",
						type: "followup",
						fields: [question()],
					},
				],
				...searchFirstModule,
			},
			...(other === undefined ? [] : [other]),
		],
		caseTypes: caseTypes ?? [
			{
				name: "case",
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

describe("searchFirstRequiresCaseFirstModule", () => {
	const CODE = "SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE";

	it("admits a case-first module and a case-list-only module", () => {
		expect(codes(docWith({}), CODE)).toEqual([]);
		expect(
			codes(docWith({ caseListOnly: true, forms: undefined }), CODE),
		).toEqual([]);
	});

	it("refuses a module with a registration form", () => {
		const doc = docWith({
			forms: [
				{
					uuid: FOLLOWUP_FORM,
					name: "Visit",
					type: "followup",
					fields: [question()],
				},
				{
					name: "Register",
					type: "registration",
					fields: [
						f({
							kind: "text",
							id: "case_name",
							label: proseText("Name"),
							caseWrite: { caseType: "case", property: "case_name" },
						}),
					],
				},
			],
		});
		const hits = codes(doc, CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain("open on Search");
	});

	it("refuses a module with no case type", () => {
		const doc = docWith({
			caseType: undefined,
			caseListOnly: true,
			forms: undefined,
		});
		expect(codes(doc, CODE)).toHaveLength(1);
	});

	it("is silent when Search first is off", () => {
		const doc = docWith({
			caseSearchConfig: undefined,
			forms: [
				{
					uuid: FOLLOWUP_FORM,
					name: "Visit",
					type: "followup",
					fields: [question()],
				},
				{
					name: "Register",
					type: "registration",
					fields: [
						f({
							kind: "text",
							id: "case_name",
							label: proseText("Name"),
							caseWrite: { caseType: "case", property: "case_name" },
						}),
					],
				},
			],
		});
		expect(codes(doc, CODE)).toEqual([]);
	});
});

describe("searchFirstNoButtonDisplayCondition", () => {
	const CODE = "SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION";

	it("refuses a search-button condition on a search-first module", () => {
		const doc = docWith({
			caseSearchConfig: {
				searchFirst: true,
				searchButtonDisplayCondition: eq(
					sessionUser("username"),
					literal("alice"),
				),
			},
		});
		const hits = codes(doc, CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain("no Search button");
	});

	it("admits the same condition when Search first is off", () => {
		const doc = docWith({
			caseSearchConfig: {
				searchButtonDisplayCondition: eq(
					sessionUser("username"),
					literal("alice"),
				),
			},
		});
		expect(codes(doc, CODE)).toEqual([]);
	});
});

describe("searchFirstNoPreviousWorkflow", () => {
	const CODE = "SEARCH_FIRST_NO_PREVIOUS_WORKFLOW";

	it("refuses an explicit previous on a case form of a search-first module", () => {
		const doc = docWith({
			forms: [
				{
					uuid: FOLLOWUP_FORM,
					name: "Visit",
					type: "followup",
					postSubmit: "previous",
					fields: [question()],
				},
			],
		});
		const hits = codes(doc, CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain('"Visit"');
	});

	it("admits the absent slot (the default is the module) and the other destinations", () => {
		expect(codes(docWith({}), CODE)).toEqual([]);
		for (const postSubmit of ["module", "app_home"] as const) {
			const doc = docWith({
				forms: [
					{
						uuid: FOLLOWUP_FORM,
						name: "Visit",
						type: "followup",
						postSubmit,
						fields: [question()],
					},
				],
			});
			expect(codes(doc, CODE)).toEqual([]);
		}
	});

	it("admits previous when Search first is off", () => {
		const doc = docWith({
			caseSearchConfig: undefined,
			forms: [
				{
					uuid: FOLLOWUP_FORM,
					name: "Visit",
					type: "followup",
					postSubmit: "previous",
					fields: [question()],
				},
			],
		});
		expect(codes(doc, CODE)).toEqual([]);
	});
});

describe("searchFirstUniqueInstance", () => {
	const CODE = "SEARCH_FIRST_UNIQUE_INSTANCE";

	it("refuses a submenu under a search-first module, on both modules", () => {
		const doc = docWith(
			{},
			{
				uuid: OTHER,
				name: "Child",
				caseType: "case",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ name: "Note", type: "followup", fields: [question()] }],
			},
		);
		doc.modules[OTHER].parentModuleUuid = FOLLOWUP;
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.code === CODE,
		);
		expect(hits.map((hit) => hit.location.moduleUuid).sort()).toEqual(
			[FOLLOWUP, OTHER].sort(),
		);
	});

	it("refuses a module that selects its parent from a search-first module", () => {
		const doc = docWith(
			{},
			{
				uuid: OTHER,
				name: "Children",
				caseType: "child",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ name: "Note", type: "followup", fields: [question()] }],
			},
			[
				{
					name: "case",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "child",
					parent_type: "case",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].location.moduleUuid).toBe(OTHER);
		expect(hits[0].message).toContain("selects a parent case");
	});

	it("admits a search-first module that selects ITS parent from an ordinary module", () => {
		const doc = docWith(
			{ caseType: "child" },
			{
				uuid: OTHER,
				name: "Parents",
				caseType: "case",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ name: "Note", type: "followup", fields: [question()] }],
			},
			[
				{
					name: "case",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "child",
					parent_type: "case",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		);
		expect(codes(doc, CODE)).toEqual([]);
	});

	it("is silent for ordinary nesting", () => {
		const doc = docWith(
			{ caseSearchConfig: undefined },
			{
				uuid: OTHER,
				name: "Child",
				caseType: "case",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ name: "Note", type: "followup", fields: [question()] }],
			},
		);
		doc.modules[OTHER].parentModuleUuid = FOLLOWUP;
		expect(codes(doc, CODE)).toEqual([]);
	});
});
