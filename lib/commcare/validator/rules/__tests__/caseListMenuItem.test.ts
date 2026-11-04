/**
 * The module rules over `Module.caseListMenuItem`: the entry needs a case
 * type, stands beside forms, and is what lets a module have no menu forms,
 * as CommCare HQ's build requires (`helpers/validators.py`, `not
 * module.forms and not module.case_list.show`). A root with the entry beside
 * a form is no bare case list, so a submenu of another case type is admitted
 * under it. Each test builds the document the rule reads and runs the whole
 * validator, so a rule still reading a retired slot fails here.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	type ModuleSpec,
} from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../runner";

const PATIENTS = testUuid("case-list-menu-item-patients");
const VISITS = testUuid("case-list-menu-item-visits");

const patients = (overrides: Partial<ModuleSpec> = {}): ModuleSpec => ({
	uuid: PATIENTS,
	name: "Patients",
	caseType: "patient",
	caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
	forms: [
		{
			name: "Visit",
			type: "followup",
			fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
		},
	],
	...overrides,
});

function docOf(...modules: ModuleSpec[]): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		modules,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
}

function findings(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => ({
		code: error.code,
		moduleUuid: error.location.moduleUuid,
		message: error.message,
	}));
}

describe("the case list menu entry", () => {
	it("stands beside the menu's forms", () => {
		const doc = docOf(patients({ caseListMenuItem: {} }));
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(findings(doc)).toEqual([]);
	});

	it("is the menu of a module with no forms", () => {
		const doc = docOf(patients({ caseListMenuItem: {}, forms: [] }));
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(findings(doc)).toEqual([]);
	});

	it("needs a case type", () => {
		const doc = docOf(
			patients({
				caseType: undefined,
				caseListConfig: undefined,
				caseListMenuItem: {},
				forms: [],
			}),
		);
		expect(findings(doc)).toEqual([
			{
				code: "CASE_LIST_MENU_ITEM_NO_CASE_TYPE",
				moduleUuid: PATIENTS,
				message: `Module "Patients" lists its case list as a menu entry but has no case type, so the list has no cases to show. You can set the case type it lists, or take the entry off (case_list_menu_item null).`,
			},
		]);
	});

	it("is what a typed module with no forms is missing", () => {
		const doc = docOf(patients({ forms: [] }));
		expect(findings(doc)).toEqual([
			{
				code: "NO_FORMS_OR_CASE_LIST",
				moduleUuid: PATIENTS,
				message: `Module "Patients" has a case type ("patient") but no forms. CommCare needs forms that work with its cases or a case list entry, so you can add a form, give it a case list menu entry, or, if you're removing its last form, delete the whole menu.`,
			},
		]);
	});
});

describe("a submenu of another case type", () => {
	const visits = (): ModuleSpec => ({
		uuid: VISITS,
		name: "Visits",
		caseType: "visit",
		caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		forms: [
			{
				name: "Follow up visit",
				type: "followup",
				fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
			},
		],
	});

	function nested(root: ModuleSpec): BlueprintDoc {
		const doc = docOf(root, visits());
		doc.modules[VISITS] = {
			...doc.modules[VISITS],
			parentModuleUuid: PATIENTS,
		};
		return doc;
	}

	it("is refused under a bare case list", () => {
		const doc = nested(patients({ caseListMenuItem: {}, forms: [] }));
		expect(
			findings(doc).map(({ code, moduleUuid }) => [code, moduleUuid]),
		).toEqual([["NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM", VISITS]]);
	});

	it("is admitted under a root whose case list entry stands beside a form", () => {
		const doc = nested(patients({ caseListMenuItem: {} }));
		expect(
			findings(doc).filter(
				({ code }) => code === "NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM",
			),
		).toEqual([]);
	});
});
