/**
 * The search workflow's mutations and planners, held against the commit
 * gate (`commitVerdicts.ts::mutationCommitVerdict`) and the store's
 * `applyMany`.
 *
 * Contract: an editor's Search batch never falls into a Search screen with
 * only its Search button (`workflowAfterInputChangeMutations`, through the
 * composer `withWorkflowAfterInputChange`), while a search first an author
 * chose with no visible field stays; a list first beside forms that read the
 * search is refused with its own code; turning Forms read the search on
 * clears list first in the same patch; and a case list registration slot
 * never names a form outside its module.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	type ModuleSpec,
} from "@/lib/__tests__/docHelpers";
import { formsReadSearchOnMutations } from "@/lib/doc/caseListRegistrationForm";
import { withWorkflowAfterInputChange } from "@/lib/doc/caseSearchConfigPatchMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type AppSettings,
	NEW_APP_SETTINGS,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { now } from "@/lib/domain/expression/builders";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("workflow-module");
const OTHER = testUuid("workflow-other-module");
const VISIT = testUuid("workflow-visit");
const REGISTER = testUuid("workflow-register");
const OTHER_VISIT = testUuid("workflow-other-visit");
const NAME_INPUT = testUuid("workflow-name-input");
const STAMP_INPUT = testUuid("workflow-stamp-input");
const SECOND_STAMP = testUuid("workflow-second-stamp");

const WEB_APPS: AppSettings = { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" };

const nameInput = (): SearchInputDef =>
	simpleSearchInputDef(NAME_INPUT, "name", "Name", "text", "case_name");
const stampInput = (uuid = STAMP_INPUT, name = "stamp"): SearchInputDef => ({
	kind: "hidden",
	uuid,
	name,
	label: "Stamp",
	value: now(),
});

/** A Patients menu with a follow-up form, a registration form a search can
 *  offer, and a second menu a form can move to. */
function app(options: {
	readonly inputs?: readonly SearchInputDef[];
	readonly caseSearchConfig?: ModuleSpec["caseSearchConfig"];
	readonly registration?: boolean;
	readonly appSettings?: AppSettings;
}): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [...(options.inputs ?? [])];
	const doc = buildDoc({
		appName: "Workflows",
		appSettings: options.appSettings ?? WEB_APPS,
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				...(options.caseSearchConfig !== undefined && {
					caseSearchConfig: options.caseSearchConfig,
				}),
				...(options.registration === true && {
					caseListRegistrationForm: { formUuid: REGISTER },
				}),
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
					...(options.registration === true
						? [
								{
									uuid: REGISTER,
									name: "Register patient",
									type: "registration" as const,
									postSubmit: "firstMenu" as const,
									fields: [
										f({
											kind: "text",
											id: "case_name",
											label: "Name",
											caseWrite: {
												caseType: "patient",
												property: "case_name",
											},
										}),
									],
								},
							]
						: []),
				],
			},
			{
				uuid: OTHER,
				name: "Others",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: OTHER_VISIT,
						name: "Other visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function commit(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	return mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE);
}

function admitted(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = commit(doc, mutations);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	if (!verdict.ok) throw new Error("The batch must be admitted.");
	return verdict;
}

const skipToResults: Mutation = {
	kind: "updateModule",
	uuid: MODULE,
	patch: {},
	caseSearchConfigPatch: { workflow: "skipToResults" },
};

describe("a search with no visible field", () => {
	it("opens on its results when an editor enables Search with no field", () => {
		const doc = app({});
		const batch = withWorkflowAfterInputChange(doc, [
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigOperation: "enable",
			},
		]);
		expect(batch.at(-1)).toEqual(skipToResults);
		const { nextDoc } = admitted(doc, batch);
		expect(nextDoc.modules[MODULE]?.caseSearchConfig).toEqual({
			workflow: "skipToResults",
		});
	});

	it("opens on its results when the last visible field is removed", () => {
		const doc = app({ inputs: [nameInput(), stampInput()] });
		const batch = withWorkflowAfterInputChange(doc, [
			{ kind: "removeSearchInput", moduleUuid: MODULE, uuid: NAME_INPUT },
		]);
		expect(batch.at(-1)).toEqual(skipToResults);
		const { nextDoc } = admitted(doc, batch);
		expect(nextDoc.modules[MODULE]?.caseSearchConfig).toEqual({
			workflow: "skipToResults",
		});
	});

	it("opens on its results when the last visible field is hidden", () => {
		const doc = app({ inputs: [nameInput()] });
		const { uuid: _uuid, ...hidden } = stampInput(NAME_INPUT, "name");
		const batch = withWorkflowAfterInputChange(doc, [
			{
				kind: "updateSearchInput",
				moduleUuid: MODULE,
				uuid: NAME_INPUT,
				searchInput: hidden,
			},
		]);
		expect(batch.at(-1)).toEqual(skipToResults);
		admitted(doc, batch);
	});

	it("keeps a search first the author chose with no visible field", () => {
		// The module already searches with no visible field and an absent
		// workflow: the author's Search first, which a further edit leaves.
		const doc = app({ inputs: [stampInput()], caseSearchConfig: {} });
		const edit: Mutation = {
			kind: "addSearchInput",
			moduleUuid: MODULE,
			searchInput: stampInput(SECOND_STAMP, "second_stamp"),
		};
		expect(withWorkflowAfterInputChange(doc, [edit])).toEqual([edit]);
		const { nextDoc } = admitted(doc, [edit]);
		expect(nextDoc.modules[MODULE]?.caseSearchConfig).toEqual({});
	});

	it("writes nothing where the search keeps a visible field or a workflow", () => {
		const visible = app({ inputs: [nameInput()] });
		const addStamp: Mutation = {
			kind: "addSearchInput",
			moduleUuid: MODULE,
			searchInput: stampInput(),
		};
		expect(withWorkflowAfterInputChange(visible, [addStamp])).toEqual([
			addStamp,
		]);
		const chosen = app({
			inputs: [nameInput(), stampInput()],
			caseSearchConfig: { workflow: "listFirst" },
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		});
		const removal: Mutation = {
			kind: "removeSearchInput",
			moduleUuid: MODULE,
			uuid: NAME_INPUT,
		};
		expect(withWorkflowAfterInputChange(chosen, [removal])).toEqual([removal]);
	});
});

describe("list first and forms that read the search", () => {
	it("refuses list first beside forms that read the search with its own code", () => {
		const doc = app({
			inputs: [nameInput()],
			caseSearchConfig: { formsReadSearch: true },
		});
		const verdict = commit(doc, [
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { workflow: "listFirst" },
			},
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.findings.map((finding) => finding.code)).toContain(
			"FORMS_READ_SEARCH_WITH_LIST_FIRST",
		);
	});

	it("clears list first in the patch that turns Forms read the search on", () => {
		const doc = app({
			inputs: [nameInput()],
			caseSearchConfig: { workflow: "listFirst" },
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		});
		const mutations = formsReadSearchOnMutations(doc, MODULE);
		expect(mutations).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { formsReadSearch: true, workflow: null },
			},
		]);
		// Android can't run forms that read the search, so the same batch
		// with the app run only in Web Apps is the one the gate admits.
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc));
		store
			.getState()
			.applyMany([
				{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
				...mutations,
			]);
		expect(store.getState().modules[MODULE]?.caseSearchConfig).toEqual({
			formsReadSearch: true,
		});
		admitted(doc, [
			{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
			...mutations,
		]);
	});
});

describe("the case list registration slot follows its form", () => {
	const searching = () =>
		app({
			inputs: [nameInput()],
			caseSearchConfig: { formsReadSearch: true },
			registration: true,
		});

	it("leaves with the form a removal takes", () => {
		const doc = searching();
		const { nextDoc } = admitted(doc, [{ kind: "removeForm", uuid: REGISTER }]);
		expect(nextDoc.modules[MODULE]?.caseListRegistrationForm).toBeUndefined();
	});

	it("leaves with the form a move takes to another module", () => {
		const doc = searching();
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc));
		store.getState().applyMany([
			{
				kind: "moveForm",
				uuid: REGISTER,
				toModuleUuid: OTHER,
				after: OTHER_VISIT,
			},
		]);
		expect(
			store.getState().modules[MODULE]?.caseListRegistrationForm,
		).toBeUndefined();
		expect(store.getState().formOrder[OTHER]).toEqual([OTHER_VISIT, REGISTER]);
	});

	it("stays through a reorder within its module", () => {
		const doc = searching();
		const { nextDoc } = admitted(doc, [
			{ kind: "moveForm", uuid: REGISTER, toModuleUuid: MODULE, after: null },
		]);
		expect(nextDoc.formOrder[MODULE]).toEqual([REGISTER, VISIT]);
		expect(nextDoc.modules[MODULE]?.caseListRegistrationForm).toEqual({
			kind: "after-empty-search",
			formUuid: REGISTER,
		});
	});

	it("is refused where it names another module's form", () => {
		const doc = searching();
		const verdict = commit(doc, [
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {
					caseListRegistrationForm: {
						kind: "after-empty-search",
						formUuid: OTHER_VISIT,
					},
				},
			},
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.findings.map((finding) => finding.code)).toContain(
			"CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE",
		);
	});
});
