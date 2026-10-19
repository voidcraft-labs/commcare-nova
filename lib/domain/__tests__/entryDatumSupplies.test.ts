import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	entryDatumSupplies,
	formLinkTargetSupplies,
	rootSelectionAlignment,
} from "../entryDatumSupplies";
import {
	instanceReadsDoc,
	reads,
} from "../expression/__tests__/instanceReadsFixture";
import { formStructure } from "../expression/formStructure";
import type { Uuid } from "../uuid";
import { chosen, chosenCaseDoc } from "./chosenCaseFixture";

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

	it("supplies what a search found to its module's menu forms, never to the no-matches form or another module", () => {
		const doc = instanceReadsDoc();
		const at = (module: typeof reads.find, form: typeof reads.find) =>
			entryDatumSupplies(doc, { kind: "form", module, form }).searchResults;
		expect(at(reads.find, reads.checkIn)).toEqual({ module: reads.find });
		expect(at(reads.find, reads.note)).toEqual({ module: reads.find });
		expect(at(reads.find, reads.register)).toBeUndefined();
		expect(at(reads.households, reads.visit)).toBeUndefined();
		const ordinary = structuredClone(doc);
		ordinary.modules[reads.find].caseSearchConfig = {};
		expect(
			entryDatumSupplies(ordinary, {
				kind: "form",
				module: reads.find,
				form: reads.checkIn,
			}).searchResults,
		).toBeUndefined();
	});
});

describe("the case list step of each module (case-list and search points)", () => {
	const village = { kind: "selected-case", module: chosen.villages } as const;
	const household = {
		kind: "selected-case",
		module: chosen.households,
	} as const;
	const atList = (doc: ReturnType<typeof chosenCaseDoc>, module: Uuid) => ({
		caseList: entryDatumSupplies(doc, { kind: "case-list", module }),
		search: entryDatumSupplies(doc, { kind: "search", module }),
	});

	it("supplies the choices before a module's own selection, never its own", () => {
		const { caseList, search } = atList(chosenCaseDoc(), chosen.members);
		for (const point of [caseList, search]) {
			expect(point.refs).toEqual([
				{ ref: village, scalar: true },
				{ ref: household, scalar: true },
			]);
			expect(point.differs).toBeUndefined();
		}
		const villages = atList(chosenCaseDoc(), chosen.villages);
		expect(villages.caseList).toEqual({ refs: [] });
	});

	it("holds a choice in differs where a module that selects through the list keeps it in another place", () => {
		// Households' list runs in its own entries, where the village is one
		// choice back, and as Members' parent choice, where it is two back.
		const { caseList, search } = atList(chosenCaseDoc(), chosen.households);
		for (const point of [caseList, search]) {
			expect(point.refs).toEqual([]);
			expect(point.differs).toEqual([{ ref: village, module: chosen.members }]);
		}
	});

	it("follows a change of parent selection", () => {
		const doc = chosenCaseDoc();
		doc.modules[chosen.members].parentCaseModuleUuid = undefined;
		expect(atList(doc, chosen.members).caseList).toEqual({ refs: [] });
		// Households no longer runs as anyone's parent choice.
		expect(atList(doc, chosen.households).caseList).toEqual({
			refs: [{ ref: village, scalar: true }],
		});
	});

	it("marks a several-case menu's choice as no one case", () => {
		const doc = chosenCaseDoc();
		doc.modules[chosen.villages].caseListConfig = {
			...caseListConfig([]),
			selection: { kind: "multiple", maximum: 3 },
		};
		expect(atList(doc, chosen.members).caseList.refs).toContainEqual({
			ref: village,
			scalar: false,
		});
	});

	it("holds a case list nested under its root's menu at the root's choice", () => {
		const doc = chosenCaseDoc();
		// Members nests under Households' menu and picks its household from
		// Households' list: the root's selection is aligned with Members'
		// parent choice, so the household is chosen before Members' own.
		doc.modules[chosen.members].parentModuleUuid = chosen.households;
		const { caseList } = atList(doc, chosen.members);
		expect(caseList.refs).toContainEqual({ ref: household, scalar: true });
		expect(caseList.differs).toBeUndefined();
	});

	it("gives a case-first form menu its own module's choice and a forms-first one none", () => {
		const doc = chosenCaseDoc();
		const menu = {
			kind: "form-menu",
			module: chosen.members,
			form: chosen.memberForm,
		} as const;
		expect(entryDatumSupplies(doc, menu).refs).toEqual([
			{ ref: village, scalar: true },
			{ ref: household, scalar: true },
			{
				ref: { kind: "selected-case", module: chosen.members },
				scalar: true,
			},
		]);
		const formsFirst = chosenCaseDoc();
		formsFirst.forms[chosen.memberForm].type = "registration";
		expect(entryDatumSupplies(formsFirst, menu).refs).toEqual([]);
	});
});
