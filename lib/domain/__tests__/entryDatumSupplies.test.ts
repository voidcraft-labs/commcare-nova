import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	entryDatumSupplies,
	formLinkTargetSupplies,
	rootSelectionAlignment,
} from "../entryDatumSupplies";
import { formStructure } from "../expression/formStructure";

const ROOT = testUuid("datum-root");
const CHILD = testUuid("datum-child");
const ROOT_FORM = testUuid("datum-root-form");
const CHILD_FORM = testUuid("datum-child-form");

function selectionDoc() {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: ROOT,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([]),
				forms: [{ uuid: ROOT_FORM, name: "Visit", type: "followup" }],
			},
			{
				uuid: CHILD,
				name: "More visits",
				caseType: "patient",
				caseListConfig: caseListConfig([]),
				forms: [{ uuid: CHILD_FORM, name: "Next visit", type: "followup" }],
			},
		],
	});
}

describe("entry datums at their evaluation points", () => {
	it("supplies a selection to a case-first form menu after selection", () => {
		const doc = selectionDoc();
		const selected = {
			ref: { kind: "selected-case", module: ROOT },
			scalar: true,
		};
		expect(
			entryDatumSupplies(doc, { kind: "form", module: ROOT, form: ROOT_FORM })
				.refs,
		).toEqual([selected]);
		expect(
			entryDatumSupplies(doc, {
				kind: "form-menu",
				module: ROOT,
				form: ROOT_FORM,
			}).refs,
		).toEqual([selected]);
		for (const kind of ["case-list", "search"] as const)
			expect(entryDatumSupplies(doc, { kind, module: ROOT }).refs).toEqual([]);
	});

	it("keeps a forms-first menu before selection and gives a registration its new identity", () => {
		const doc = selectionDoc();
		doc.forms[ROOT_FORM].type = "registration";
		expect(
			entryDatumSupplies(doc, {
				kind: "form-menu",
				module: ROOT,
				form: ROOT_FORM,
			}).refs,
		).toEqual([]);
		expect(
			entryDatumSupplies(doc, { kind: "form", module: ROOT, form: ROOT_FORM })
				.refs,
		).toEqual([{ ref: { kind: "new-case" }, scalar: true }]);
	});

	it("retains both module identities when a root selection supplies a child entry", () => {
		const doc = selectionDoc();
		doc.modules[CHILD].parentModuleUuid = ROOT;
		const point = { kind: "form" as const, module: CHILD, form: CHILD_FORM };
		expect(rootSelectionAlignment(doc, point)).toMatchObject({
			matches: [{ sourceModuleUuid: ROOT, targetModuleUuid: CHILD }],
			boundMismatches: [],
			parentSelectionConflict: false,
		});
		expect(entryDatumSupplies(doc, point).refs).toEqual([
			{ ref: { kind: "selected-case", module: CHILD }, scalar: true },
			{ ref: { kind: "selected-case", module: ROOT }, scalar: true },
		]);
		expect(
			formLinkTargetSupplies(doc, { type: "module", moduleUuid: CHILD }).refs,
		).toEqual([{ ref: { kind: "selected-case", module: ROOT }, scalar: true }]);
	});

	it("refuses a wider parent multi-selection before treating it as a child supply", () => {
		const doc = selectionDoc();
		doc.modules[CHILD].parentModuleUuid = ROOT;
		doc.modules[ROOT].caseListConfig = {
			...caseListConfig([]),
			selection: { kind: "multiple", maximum: 5 },
		};
		doc.modules[CHILD].caseListConfig = {
			...caseListConfig([]),
			selection: { kind: "multiple", maximum: 2 },
		};
		const point = { kind: "form" as const, module: CHILD, form: CHILD_FORM };
		expect(rootSelectionAlignment(doc, point)).toMatchObject({
			matches: [],
			boundMismatches: [
				{
					moduleUuid: CHILD,
					sourceModuleUuid: ROOT,
					targetModuleUuid: CHILD,
					sourceMaximum: 5,
					targetMaximum: 2,
				},
			],
		});
		expect(entryDatumSupplies(doc, point).refs).toEqual([
			{ ref: { kind: "selected-case", module: CHILD }, scalar: false },
		]);
	});

	it("skips a no-matches form when aligning a parent menu and honors a pending entry change", () => {
		const doc = selectionDoc();
		const noMatches = testUuid("datum-no-matches");
		doc.forms[noMatches] = {
			...doc.forms[ROOT_FORM],
			uuid: noMatches,
			id: "register_patient",
			type: "registration",
			entry: { kind: "search-no-matches" },
		};
		doc.formOrder[ROOT] = [noMatches, ROOT_FORM];
		doc.fieldOrder[noMatches] = [];
		doc.modules[CHILD].parentModuleUuid = ROOT;
		expect(
			rootSelectionAlignment(doc, {
				kind: "form",
				module: CHILD,
				form: CHILD_FORM,
			}),
		).toMatchObject({
			parentEntry: { kind: "form", module: ROOT, form: ROOT_FORM },
			matches: [{ sourceModuleUuid: ROOT, targetModuleUuid: CHILD }],
		});
		expect(
			formLinkTargetSupplies(doc, { type: "module", moduleUuid: CHILD }).refs,
		).toEqual([{ ref: { kind: "selected-case", module: ROOT }, scalar: true }]);
		const point = { kind: "form-menu" as const, module: ROOT, form: ROOT_FORM };
		expect(entryDatumSupplies(doc, point).refs).toEqual([
			{ ref: { kind: "selected-case", module: ROOT }, scalar: true },
		]);
		const prepared = formStructure(doc, noMatches);
		if (prepared === undefined)
			throw new Error("The registration fixture is missing.");
		expect(
			entryDatumSupplies(doc, point, { ...prepared, entry: undefined }).refs,
		).toEqual([]);
	});

	it("supplies a child-case identity only for an actual non-repeat writer", () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "visit", parent_type: "patient", properties: [] },
				{ name: "sample", parent_type: "patient", properties: [] },
			],
			modules: [
				{
					uuid: ROOT,
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: ROOT_FORM,
							name: "Visit",
							type: "followup",
							fields: [
								f({
									id: "visit_name",
									kind: "text",
									label: "Visit",
									caseWrite: { caseType: "visit", property: "case_name" },
								}),
								f({
									id: "samples",
									kind: "repeat",
									children: [
										f({
											id: "sample_name",
											kind: "text",
											label: "Sample",
											caseWrite: { caseType: "sample", property: "case_name" },
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		expect(
			entryDatumSupplies(doc, { kind: "form", module: ROOT, form: ROOT_FORM })
				.refs,
		).toEqual([
			{ ref: { kind: "selected-case", module: ROOT }, scalar: true },
			{ ref: { kind: "new-child-case", caseType: "visit" }, scalar: true },
		]);
	});
});
