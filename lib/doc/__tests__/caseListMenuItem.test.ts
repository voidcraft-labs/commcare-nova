/**
 * The case list menu item (`Module.caseListMenuItem`) in the doc layer: its
 * one mutation kind, the planners that birth and keep it, the document diff,
 * and the gate's footprint.
 *
 * Contract: `setCaseListMenuItem` sets or takes off the whole entry; an
 * authored entry is never removed in passing (a form added to a bare case
 * list keeps it), and a typed module that loses its last menu form gains it,
 * while clearing a module's case type takes it off; autosave and replay
 * reproduce an entry change with exactly one `setCaseListMenuItem`; and the
 * scoped gate re-checks the module and its child modules.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { createBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { incrementalValidationScope } from "@/lib/doc/incrementalValidationScope";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { modulePatchMutations } from "@/lib/doc/modulePatchMutations";
import { applyMutations } from "@/lib/doc/mutations";
import { caseTypeClearPatch, formScaffoldMutations } from "@/lib/doc/scaffolds";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { assertAdmittedDoc } from "./admittedDoc";

const PATIENTS = testUuid("menu-item-patients");
const CHILD = testUuid("menu-item-child");
const VISIT = testUuid("menu-item-visit");
const CHILD_VISIT = testUuid("menu-item-child-visit");
const SURVEYS = testUuid("menu-item-surveys");
const LIST = testUuid("menu-item-list");
const SURVEY = testUuid("menu-item-survey");
const ICON = testMediaAssetId("menu-item-icon");

const nameColumns = () =>
	caseListConfig([{ field: "case_name", header: "Name" }]);

/** A typed menu with a follow-up form and a child menu, a typed menu that is
 *  only its case list, and a typed menu holding a survey form. */
function app(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Menu items",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				uuid: PATIENTS,
				name: "Patients",
				caseType: "patient",
				caseListConfig: nameColumns(),
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
			{
				uuid: CHILD,
				name: "Child",
				caseType: "patient",
				caseListConfig: nameColumns(),
				forms: [
					{
						uuid: CHILD_VISIT,
						name: "Child visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
			{
				uuid: LIST,
				name: "Patient list",
				caseType: "patient",
				caseListMenuItem: {},
				caseListConfig: nameColumns(),
				forms: [],
			},
			{
				uuid: SURVEYS,
				name: "Surveys",
				caseType: "patient",
				caseListConfig: nameColumns(),
				forms: [
					{
						uuid: SURVEY,
						name: "Survey",
						type: "survey",
						fields: [f({ kind: "text", id: "answer", label: "Answer" })],
					},
				],
			},
		],
	});
	// The fixture builder places every menu at the root; Child sits under
	// Patients, which it already follows in the module order.
	const nested = produce(doc, (draft) => {
		draft.modules[CHILD].parentModuleUuid = PATIENTS;
	});
	assertAdmittedDoc(nested);
	return nested;
}

function admitted(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	if (!verdict.ok) throw new Error("The batch must be admitted.");
	return verdict.nextDoc;
}

describe("setCaseListMenuItem", () => {
	it("sets the whole entry beside forms and takes it off again", () => {
		const doc = app();
		const withItem = admitted(doc, [
			{
				kind: "setCaseListMenuItem",
				uuid: PATIENTS,
				item: { label: "All patients", icon: ICON },
			},
		]);
		expect(withItem.modules[PATIENTS]?.caseListMenuItem).toEqual({
			label: "All patients",
			icon: ICON,
		});
		const without = admitted(withItem, [
			{ kind: "setCaseListMenuItem", uuid: PATIENTS, item: null },
		]);
		expect(without.modules[PATIENTS]).not.toHaveProperty("caseListMenuItem");
	});

	it("is refused where it takes the only entry off a menu with no forms", () => {
		const verdict = mutationCommitVerdict(
			app(),
			[{ kind: "setCaseListMenuItem", uuid: LIST, item: null }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.findings.map((finding) => finding.code)).toContain(
			"NO_FORMS_OR_CASE_LIST",
		);
	});
});

describe("the planners keep an authored entry", () => {
	it("keeps the entry when a form is added to a bare case list", () => {
		const doc = app();
		const scaffold = formScaffoldMutations(doc, LIST, "followup");
		if (scaffold === null) throw new Error("No form scaffold.");
		expect(
			scaffold.mutations.some(
				(mutation) => mutation.kind === "setCaseListMenuItem",
			),
		).toBe(false);
		const next = admitted(doc, scaffold.mutations);
		expect(next.modules[LIST]?.caseListMenuItem).toEqual({});
		expect(next.formOrder[LIST]).toEqual([scaffold.formUuid]);
	});

	it("gives a typed module its entry when its last menu form is removed", () => {
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(app()));
		store.getState().startTracking();
		const commands = createBlueprintMutations(store, {
			canEdit: true,
			authoringLanguage: null,
			lookupCommitState: {
				kind: "unmanaged",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			},
		});
		const outcome = commands.removeForm(SURVEY);
		expect(outcome).toMatchObject({ ok: true });
		expect(store.getState().formOrder[SURVEYS]).toEqual([]);
		expect(store.getState().modules[SURVEYS]?.caseListMenuItem).toEqual({});
	});

	it("takes the entry off with the case type", () => {
		const doc = produce(app(), (draft) => {
			draft.modules[SURVEYS].caseListMenuItem = { label: "Everyone" };
		});
		const mutations = modulePatchMutations(
			doc.modules[SURVEYS],
			caseTypeClearPatch(),
		);
		expect(mutations).toContainEqual({
			kind: "setCaseListMenuItem",
			uuid: SURVEYS,
			item: null,
		});
		const next = admitted(doc, mutations);
		expect(next.modules[SURVEYS]).not.toHaveProperty("caseListMenuItem");
		expect(next.modules[SURVEYS]).not.toHaveProperty("caseType");
	});
});

describe("diffDocsToMutations", () => {
	it("reproduces an entry change with one setCaseListMenuItem", () => {
		const prev = app();
		const next = produce(prev, (draft) => {
			draft.modules[LIST].caseListMenuItem = { label: "Everyone", icon: ICON };
			draft.modules[PATIENTS].caseListMenuItem = {};
		});
		const mutations = diffDocsToMutations(prev, next);
		const itemMutations = mutations.filter(
			(mutation) => mutation.kind === "setCaseListMenuItem",
		);
		expect(itemMutations).toEqual([
			{ kind: "setCaseListMenuItem", uuid: PATIENTS, item: {} },
			{
				kind: "setCaseListMenuItem",
				uuid: LIST,
				item: { label: "Everyone", icon: ICON },
			},
		]);
		expect(
			mutations.some(
				(mutation) =>
					mutation.kind === "updateModule" &&
					Object.hasOwn(mutation.patch, "caseListMenuItem"),
			),
		).toBe(false);
		const replayed = produce(prev, (draft) => {
			applyMutations(draft, mutations);
		});
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	});

	it("reproduces taking the entry off", () => {
		const prev = produce(app(), (draft) => {
			draft.modules[PATIENTS].caseListMenuItem = { label: "Everyone" };
		});
		const next = produce(prev, (draft) => {
			delete draft.modules[PATIENTS].caseListMenuItem;
		});
		const mutations = diffDocsToMutations(prev, next);
		expect(mutations).toEqual([
			{ kind: "setCaseListMenuItem", uuid: PATIENTS, item: null },
		]);
	});
});

describe("incrementalValidationScope", () => {
	it("names the module, its child modules and their forms", () => {
		const doc = app();
		const mutations: Mutation[] = [
			{ kind: "setCaseListMenuItem", uuid: PATIENTS, item: {} },
		];
		const nextDoc = produce(doc, (draft) => {
			applyMutations(draft, mutations);
		});
		expect(incrementalValidationScope(doc, mutations, nextDoc)).toEqual({
			moduleUuids: new Set([PATIENTS, CHILD]),
			formUuids: new Set([VISIT, CHILD_VISIT]),
		});
	});
});
