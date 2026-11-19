/**
 * `hqEntryFacts` lists what CommCare HQ's entry builder reads of an app
 * source, and `datumIdsFromFacts` ports HQ's id rules over that list alone.
 *
 * Sources are Nova's own emission (`expandDoc`), edited at one key where a
 * shape only CommCare HQ's pages write is needed, with the page or model that
 * writes it named. The plausible failures: a fact read from the wrong key or
 * the wrong menu (a parent selection read where it is not active, a
 * multi-select limit read on a list that selects one case), a menu with no
 * form left without a record, so a child menu's alignment against it goes
 * uncompared, a comparison that names a later key than the first that
 * differs, and an id rule ported otherwise than HQ's (a child menu's datum
 * not renamed where its root's first form holds the id, a new case's datum
 * numbered by its place among the root cases alone).
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import { STAGES } from "@/lib/commcare/reader/index";
import { bindExpressions } from "@/lib/commcare/reader/provisional";
import type { HqApplication } from "@/lib/commcare/types";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import type { Uuid } from "@/lib/domain";
import {
	datumIdsFromFacts,
	ENTRY_FACT_KEYS,
	entryFactsDifference,
	type HqAppEntryFacts,
	type HqEntryFacts,
	type HqMenuFacts,
	hqEntryFacts,
	MENU_FACT_KEYS,
	menuFactsDifference,
} from "../entryFacts";

const HOUSEHOLDS = testUuid("facts-households");
const MEMBERS = testUuid("facts-members");
const BROWSE = testUuid("facts-browse");
const REGISTER = testUuid("facts-register");
const VISIT = testUuid("facts-visit");
const MEMBER_VISIT = testUuid("facts-member-visit");

/**
 * Households: a registration and a follow-up. Members: a submenu of
 * Households that chooses a household first, with one follow-up. Browse: a
 * menu with no form, whose case list is its menu item.
 */
function nested() {
	return buildDoc(
		{
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "member", parent_type: "household", properties: [] },
			],
			modules: [
				{
					uuid: "facts-households",
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "facts-register",
							name: "Register household",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: "Name",
									caseWrite: { caseType: "household", property: "case_name" },
								}),
							],
						},
						{
							uuid: "facts-visit",
							name: "Visit household",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
				{
					uuid: "facts-members",
					name: "Members",
					caseType: "member",
					parentCaseModuleUuid: "facts-households",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "facts-member-visit",
							name: "Visit member",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
				{
					uuid: "facts-browse",
					name: "Browse households",
					caseType: "household",
					caseListMenuItem: {},
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			],
		},
		(doc) => {
			const members = doc.modules[MEMBERS];
			if (members === undefined) throw new Error("Members is gone.");
			members.parentModuleUuid = HOUSEHOLDS;
		},
	);
}

/** Nova's emission of the nested document, as JSON to edit. */
function source(): HqApplication {
	return structuredClone(expandDoc(nested()));
}

type Json = Record<string, unknown>;

/** The emitted menu whose id derives from `uuid`. */
function moduleOf(hq: HqApplication, uuid: Uuid): Json {
	const module = (hq.modules as unknown as Json[]).find(
		(candidate) => candidate.unique_id === derivedUniqueId(uuid),
	);
	if (module === undefined) throw new Error(`No menu for ${uuid}`);
	return module;
}

function formFacts(facts: HqAppEntryFacts, uuid: Uuid): HqEntryFacts {
	const form = facts.forms.get(derivedFormXmlns(uuid));
	if (form === undefined) throw new Error(`No facts for ${uuid}`);
	return form;
}

function menuFacts(facts: HqAppEntryFacts, uuid: Uuid): HqMenuFacts {
	const menu = facts.menus.get(derivedUniqueId(uuid));
	if (menu === undefined) throw new Error(`No menu facts for ${uuid}`);
	return menu;
}

const HOUSEHOLD_MENU: HqMenuFacts = {
	moduleKind: "Module",
	caseType: "household",
	rootModule: null,
	putInRoot: false,
	parentSelect: null,
	multiSelect: false,
	maxSelect: null,
	autoSelect: false,
	autoSelectCase: false,
	inlineSearch: false,
	searchInstance: null,
	additionalCaseTypes: [],
	firstForm: derivedFormXmlns(REGISTER),
};

describe("hqEntryFacts", () => {
	it("records every key of every form and every menu, a menu with no form included, in HQ's menu order", () => {
		const facts = hqEntryFacts(source());
		expect([...facts.menus.keys()]).toEqual(
			[HOUSEHOLDS, MEMBERS, BROWSE].map((uuid) => derivedUniqueId(uuid)),
		);
		expect(menuFacts(facts, HOUSEHOLDS)).toEqual(HOUSEHOLD_MENU);
		expect(menuFacts(facts, MEMBERS)).toEqual({
			...HOUSEHOLD_MENU,
			caseType: "member",
			rootModule: derivedUniqueId(HOUSEHOLDS),
			parentSelect: derivedUniqueId(HOUSEHOLDS),
			firstForm: derivedFormXmlns(MEMBER_VISIT),
		});
		expect(menuFacts(facts, BROWSE)).toEqual({
			...HOUSEHOLD_MENU,
			firstForm: null,
		});
		for (const menu of facts.menus.values())
			expect(Object.keys(menu).sort()).toEqual([...MENU_FACT_KEYS].sort());

		const visit: HqEntryFacts = {
			moduleKind: "Module",
			caseType: "household",
			rootModule: null,
			putInRoot: false,
			parentSelect: null,
			multiSelect: false,
			maxSelect: null,
			autoSelect: false,
			autoSelectCase: false,
			caseListShown: false,
			offersSearch: false,
			inlineSearch: false,
			searchInstance: null,
			additionalCaseTypes: [],
			groupedTiles: false,
			requires: "case",
			opensCase: false,
			newChildCases: [],
			usesWorkerRecord: false,
			loads: [],
			opens: [],
		};
		expect(formFacts(facts, VISIT)).toEqual(visit);
		expect(formFacts(facts, REGISTER)).toEqual({
			...visit,
			requires: "none",
			opensCase: true,
		});
		expect(formFacts(facts, MEMBER_VISIT)).toEqual({
			...visit,
			caseType: "member",
			rootModule: derivedUniqueId(HOUSEHOLDS),
			parentSelect: derivedUniqueId(HOUSEHOLDS),
		});
		expect(facts.forms.size).toBe(3);
		for (const form of facts.forms.values())
			expect(Object.keys(form).sort()).toEqual([...ENTRY_FACT_KEYS].sort());
	});

	it("reads a parent selection only where it is active and names its parent", () => {
		const inactive = source();
		(moduleOf(inactive, MEMBERS).parent_select as Json).active = false;
		expect(formFacts(hqEntryFacts(inactive), MEMBER_VISIT).parentSelect).toBe(
			null,
		);
		// HQ's case list page writes `relationship: null` for a selection by
		// another relation (`models/modules.py::ParentSelect`).
		const other = source();
		(moduleOf(other, MEMBERS).parent_select as Json).relationship = null;
		expect(formFacts(hqEntryFacts(other), MEMBER_VISIT).parentSelect).toBe(
			null,
		);
	});

	it("reads a parent selection only on a menu whose selection a build walks", () => {
		const hq = source();
		// A selection on a menu whose forms choose no case, which shows no case list and which no
		// menu selects through: no entry HQ builds walks it.
		const browse = moduleOf(hq, BROWSE);
		browse.case_list = { ...(browse.case_list as Json), show: false };
		browse.parent_select = {
			active: true,
			relationship: "parent",
			module_id: derivedUniqueId(HOUSEHOLDS),
		};
		const facts = hqEntryFacts(hq);
		expect(menuFacts(facts, BROWSE).parentSelect).toBe(null);
		// A form that requires a case walks it, and its menu's record holds it.
		expect(formFacts(facts, MEMBER_VISIT).parentSelect).toBe(
			derivedUniqueId(HOUSEHOLDS),
		);
		expect(menuFacts(facts, MEMBERS).parentSelect).toBe(
			derivedUniqueId(HOUSEHOLDS),
		);
		// Shown as its case list menu item, the menu's selection is walked again.
		browse.case_list = { ...(browse.case_list as Json), show: true };
		expect(menuFacts(hqEntryFacts(hq), BROWSE).parentSelect).toBe(
			derivedUniqueId(HOUSEHOLDS),
		);
	});

	it("reads auto_select_case only on a menu an advanced form's chosen load lists from", () => {
		const hq = source();
		// A basic menu's case datum reads its case list's `auto_select`
		// (`ModuleBase.is_auto_select` tests `is_multi_select` without calling it).
		moduleOf(hq, HOUSEHOLDS).auto_select_case = true;
		const unread = hqEntryFacts(hq);
		expect(menuFacts(unread, HOUSEHOLDS).autoSelectCase).toBe(false);
		expect(formFacts(unread, VISIT).autoSelectCase).toBe(false);
		// A load naming the menu as its list reads it.
		const members = moduleOf(hq, MEMBERS);
		members.doc_type = "AdvancedModule";
		const form = (members.forms as Json[])[0] as Json;
		form.doc_type = "AdvancedForm";
		form.actions = {
			doc_type: "AdvancedFormActions",
			load_update_cases: [
				{
					case_type: "household",
					case_tag: "load_household0",
					details_module: derivedUniqueId(HOUSEHOLDS),
					case_properties: {},
				},
			],
			open_cases: [],
		};
		expect(menuFacts(hqEntryFacts(hq), HOUSEHOLDS).autoSelectCase).toBe(true);
		// So does a load with no list of its own, of a type its own menu does not hold: the first
		// menu of the type.
		delete ((form.actions as Json).load_update_cases as Json[])[0]
			?.details_module;
		expect(menuFacts(hqEntryFacts(hq), HOUSEHOLDS).autoSelectCase).toBe(true);
	});

	it("reads a list's selection settings as HQ's model holds them", () => {
		const hq = source();
		const short = (moduleOf(hq, HOUSEHOLDS).case_details as Json).short as Json;
		short.multi_select = true;
		short.auto_select = true;
		delete short.max_select_value;
		expect(formFacts(hqEntryFacts(hq), VISIT)).toMatchObject({
			multiSelect: true,
			maxSelect: 100,
			autoSelect: true,
		});
		// `-1` is the default's same state (the manifest's
		// `detail-max-select-value-on-a-multi-select-basic-list`).
		short.max_select_value = -1;
		expect(formFacts(hqEntryFacts(hq), VISIT).maxSelect).toBe(100);
		short.max_select_value = 7;
		expect(formFacts(hqEntryFacts(hq), VISIT).maxSelect).toBe(7);
		// A list that selects one case has no limit, and
		// `ModuleBase.is_auto_select` reads `auto_select` on it all the same.
		short.multi_select = false;
		expect(formFacts(hqEntryFacts(hq), VISIT)).toMatchObject({
			multiSelect: false,
			maxSelect: null,
			autoSelect: true,
		});
	});

	it("reads a search, its inline workflow and its instance, the case list item, related types and a grouped tile", () => {
		const hq = source();
		const module = moduleOf(hq, HOUSEHOLDS);
		module.search_config = {
			...(module.search_config as Json),
			properties: [{ name: "name" }],
			inline_search: true,
			auto_launch: true,
			instance_name: "households",
			additional_case_types: ["member"],
		};
		(module.case_list as Json).show = true;
		const short = (module.case_details as Json).short as Json;
		short.case_tile_template = "one_3X_two_4X_one_2X";
		short.case_tile_group = { index_identifier: "parent", header_rows: 2 };
		const facts = hqEntryFacts(hq);
		expect(formFacts(facts, VISIT)).toMatchObject({
			caseListShown: true,
			offersSearch: true,
			inlineSearch: true,
			searchInstance: "households",
			additionalCaseTypes: ["member"],
			groupedTiles: true,
		});
		expect(menuFacts(facts, HOUSEHOLDS)).toMatchObject({
			inlineSearch: true,
			searchInstance: "households",
			additionalCaseTypes: ["member"],
		});
		// Every reader in HQ's build takes the list less the menu's own type,
		// once each and sorted (`suite_xml/utils.py::get_ordered_case_types`),
		// so a list naming only that type adds none.
		(module.search_config as Json).additional_case_types = ["household"];
		expect(menuFacts(hqEntryFacts(hq), HOUSEHOLDS).additionalCaseTypes).toEqual(
			[],
		);
		(module.search_config as Json).additional_case_types = [
			"member",
			"household",
			"child",
			"member",
		];
		expect(formFacts(hqEntryFacts(hq), VISIT).additionalCaseTypes).toEqual([
			"child",
			"member",
		]);
		// A search that does not launch on its own is no inline search, and
		// its instance name is read nowhere.
		(module.search_config as Json).auto_launch = false;
		expect(formFacts(hqEntryFacts(hq), VISIT)).toMatchObject({
			offersSearch: true,
			inlineSearch: false,
			searchInstance: null,
		});
	});

	it("reads a form's new cases with their places, and its use of the worker's record", () => {
		const hq = source();
		const register = (moduleOf(hq, HOUSEHOLDS).forms as Json[])[0];
		const actions = register.actions as Json;
		const subcase = (caseType: string, repeat: string) => ({
			doc_type: "OpenSubCaseAction",
			case_type: caseType,
			name_update: { question_path: "/data/name" },
			case_properties: {},
			repeat_context: repeat,
			condition: { type: "always" },
		});
		actions.subcases = [
			subcase("member", "/data/members"),
			subcase("member", ""),
		];
		actions.usercase_update = {
			update: { visits: { question_path: "/data/name" } },
			condition: { type: "always" },
		};
		expect(formFacts(hqEntryFacts(hq), REGISTER)).toMatchObject({
			opensCase: true,
			newChildCases: [{ caseType: "member", index: 1 }],
			usesWorkerRecord: true,
		});
	});

	it("reads an advanced form's loads and its open actions outside any repeat, with their places", () => {
		const hq = source();
		const module = moduleOf(hq, MEMBERS);
		module.doc_type = "AdvancedModule";
		module.auto_select_case = true;
		const form = (module.forms as Json[])[0];
		form.doc_type = "AdvancedForm";
		form.actions = {
			doc_type: "AdvancedFormActions",
			load_update_cases: [
				{
					case_type: "household",
					case_tag: "load_household0",
					details_module: derivedUniqueId(HOUSEHOLDS),
					case_properties: {},
				},
				{
					case_type: "member",
					case_tag: "load_member0",
					case_properties: {},
					case_index: { tag: "load_household0", reference_id: "parent" },
				},
				{
					case_type: "commcare-user",
					case_tag: "autoload_commcare_user0",
					case_properties: {},
					auto_select: { mode: "usercase", value_key: "" },
				},
			],
			open_cases: [
				{
					case_type: "visit",
					case_tag: "open_visit_0",
					name_update: { question_path: "/data/note" },
					repeat_context: "/data/visits",
					case_indices: [],
				},
				{
					case_type: "visit",
					case_tag: "open_visit_1",
					name_update: { question_path: "/data/note" },
					case_indices: [],
				},
			],
		};
		const facts = formFacts(hqEntryFacts(hq), MEMBER_VISIT);
		expect(facts).toMatchObject({
			moduleKind: "AdvancedModule",
			requires: "advanced",
			parentSelect: null,
			autoSelectCase: true,
			opensCase: false,
			loads: [
				{
					tag: "load_household0",
					caseType: "household",
					detailsModule: derivedUniqueId(HOUSEHOLDS),
					indexTag: null,
					indexName: null,
					autoSelect: null,
				},
				{
					tag: "load_member0",
					caseType: "member",
					detailsModule: null,
					indexTag: "load_household0",
					indexName: "parent",
					autoSelect: null,
				},
				{
					tag: "autoload_commcare_user0",
					caseType: "commcare-user",
					detailsModule: null,
					indexTag: null,
					indexName: null,
					autoSelect: "usercase",
				},
			],
			opens: [{ tag: "open_visit_1", caseType: "visit", index: 1 }],
		});
	});

	it("has no record of a form CommCare HQ's case blocks reader leaves out", () => {
		const hq = source();
		delete hq._attachments[
			`${(moduleOf(hq, HOUSEHOLDS).forms as Json[])[1].unique_id as string}.xml`
		];
		const facts = hqEntryFacts(hq);
		expect(facts.forms.has(derivedFormXmlns(VISIT))).toBe(false);
		expect(facts.forms.has(derivedFormXmlns(REGISTER))).toBe(true);
	});
});

describe("entryFactsDifference and menuFactsDifference", () => {
	it("name the first differing key in key order, and nothing for equal facts", () => {
		const facts = hqEntryFacts(source());
		const visit = formFacts(facts, VISIT);
		expect(entryFactsDifference(visit, structuredClone(visit))).toBe(undefined);
		expect(
			entryFactsDifference(visit, {
				...visit,
				opens: [{ tag: "open_visit_0", caseType: "visit", index: 0 }],
				caseType: "member",
			}),
		).toBe("caseType");
		expect(
			entryFactsDifference(visit, {
				...visit,
				newChildCases: [{ caseType: "member", index: 1 }],
				loads: [],
			}),
		).toBe("newChildCases");
		const menu = menuFacts(facts, HOUSEHOLDS);
		expect(menuFactsDifference(menu, structuredClone(menu))).toBe(undefined);
		expect(
			menuFactsDifference(menu, {
				...menu,
				firstForm: null,
				parentSelect: "elsewhere",
			}),
		).toBe("parentSelect");
		expect(menuFactsDifference(menu, { ...menu, firstForm: null })).toBe(
			"firstForm",
		);
	});
});

describe("datumIdsFromFacts", () => {
	it("gives a submenu that chooses its parent first the root's ids, its own renamed where the root's first form holds one", () => {
		const facts = hqEntryFacts(source());
		expect(datumIdsFromFacts(formFacts(facts, REGISTER), facts)).toEqual([
			"case_id_new_household_0",
		]);
		expect(datumIdsFromFacts(formFacts(facts, VISIT), facts)).toEqual([
			"case_id",
		]);
		// Members aligns against Households' first form, the registration:
		// its new case's datum is carried, and the chain's own ids stand.
		expect(datumIdsFromFacts(formFacts(facts, MEMBER_VISIT), facts)).toEqual([
			"case_id_new_household_0",
			"parent_id",
			"case_id",
		]);
	});

	it("aligns a submenu's selection against the root's first form's, and renames a clash by its case type", () => {
		const hq = source();
		// The follow-up first, as a person reorders forms on HQ's menu page.
		const households = moduleOf(hq, HOUSEHOLDS);
		households.forms = [...(households.forms as Json[])].reverse();
		const facts = hqEntryFacts(hq);
		// The root's `case_id` takes the parent selection's datum, and the
		// child's own `case_id`, which the root holds, becomes
		// `case_id_member`.
		expect(datumIdsFromFacts(formFacts(facts, MEMBER_VISIT), facts)).toEqual([
			"case_id",
			"case_id_member",
		]);
	});

	it("gives a submenu's registration the root's selection id where the root's first form chooses a case of its type", () => {
		const hq = source();
		// The follow-up first, as a person reorders forms on HQ's menu page.
		const households = moduleOf(hq, HOUSEHOLDS);
		households.forms = [...(households.forms as Json[])].reverse();
		const register = (households.forms as Json[])[1];
		// Members lists households with no parent selection, and its form
		// registers a household, as HQ's case management page writes a
		// registration.
		const members = moduleOf(hq, MEMBERS);
		members.case_type = "household";
		(members.parent_select as Json).active = false;
		const form = (members.forms as Json[])[0];
		form.requires = "none";
		form.actions = structuredClone(register.actions);
		const facts = hqEntryFacts(hq);
		expect(formFacts(facts, MEMBER_VISIT)).toMatchObject({
			caseType: "household",
			rootModule: derivedUniqueId(HOUSEHOLDS),
			parentSelect: null,
			requires: "none",
			opensCase: true,
		});
		// `entries.py::EntriesHelper.add_parent_datums` matches by case type
		// and datum kind alone (`_same_case`) and asks nothing of whether a
		// worker selects the datum, so the new case's datum takes the root's
		// `case_id`.
		expect(datumIdsFromFacts(formFacts(facts, MEMBER_VISIT), facts)).toEqual([
			"case_id",
		]);
		// The root's own registration aligns against nothing and keeps its id.
		expect(datumIdsFromFacts(formFacts(facts, REGISTER), facts)).toEqual([
			"case_id_new_household_0",
		]);
	});

	it("puts a search's query before the selection it supplies, named by the search's instance", () => {
		const hq = source();
		const module = moduleOf(hq, HOUSEHOLDS);
		module.search_config = {
			...(module.search_config as Json),
			properties: [{ name: "name" }],
			inline_search: true,
			auto_launch: true,
		};
		expect(
			datumIdsFromFacts(formFacts(hqEntryFacts(hq), VISIT), hqEntryFacts(hq)),
		).toEqual(["results:inline", "case_id"]);
		(module.search_config as Json).instance_name = "households";
		expect(
			datumIdsFromFacts(formFacts(hqEntryFacts(hq), VISIT), hqEntryFacts(hq)),
		).toEqual(["results:households", "case_id"]);
	});

	it("numbers a new case by its place in the form's list, after the form's own, then the worker's record and a grouped tile's parents", () => {
		const hq = source();
		const households = moduleOf(hq, HOUSEHOLDS);
		const short = (households.case_details as Json).short as Json;
		short.case_tile_template = "one_3X_two_4X_one_2X";
		short.case_tile_group = { index_identifier: "parent", header_rows: 2 };
		const facts = hqEntryFacts(hq);
		const visit = formFacts(facts, VISIT);
		expect(
			datumIdsFromFacts(
				{
					...visit,
					newChildCases: [{ caseType: "member", index: 2 }],
					usesWorkerRecord: true,
				},
				facts,
			),
		).toEqual([
			"case_id",
			"case_id_new_member_2",
			"usercase_id",
			"case_id_parent_ids",
		]);
		const register = formFacts(facts, REGISTER);
		expect(
			datumIdsFromFacts(
				{ ...register, newChildCases: [{ caseType: "member", index: 1 }] },
				facts,
			),
		).toEqual(["case_id_new_household_0", "case_id_new_member_2"]);
	});

	it("gives an advanced form a datum per load and per open action outside a repeat, by its tag and place", () => {
		const facts = hqEntryFacts(source());
		const visit = formFacts(facts, VISIT);
		expect(
			datumIdsFromFacts(
				{
					...visit,
					moduleKind: "AdvancedModule",
					requires: "advanced",
					loads: [
						{
							tag: "load_household0",
							caseType: "household",
							detailsModule: null,
							indexTag: null,
							indexName: null,
							autoSelect: null,
						},
						{
							tag: "autoload_commcare_user0",
							caseType: "commcare-user",
							detailsModule: null,
							indexTag: null,
							indexName: null,
							autoSelect: "usercase",
						},
					],
					opens: [{ tag: "open_visit_1", caseType: "visit", index: 1 }],
				},
				facts,
			),
		).toEqual([
			"case_id_load_household0",
			"case_id_autoload_commcare_user0",
			"case_id_new_visit_1",
		]);
	});

	it("says so where the facts name a menu they hold no record of", () => {
		const facts = hqEntryFacts(source());
		expect(() =>
			datumIdsFromFacts(
				{ ...formFacts(facts, VISIT), parentSelect: "nowhere" },
				facts,
			),
		).toThrow(/nowhere/);
	});
});

describe("compareEntryFacts in its place among the reader's stages", () => {
	it("finds no difference over an app with a basic parent selection and a search", async () => {
		const members = caseListConfig([{ field: "case_name", header: "Name" }]);
		const doc = buildDoc({
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "member", parent_type: "household", properties: [] },
			],
			modules: [
				{
					uuid: "compare-households",
					name: "Households",
					caseType: "household",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "household", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					uuid: "compare-members",
					name: "Members",
					caseType: "member",
					parentCaseModuleUuid: "compare-households",
					caseListConfig: {
						...members,
						searchInputs: [
							{
								uuid: testUuid("compare-search-name"),
								name: "name",
								label: "Name",
								kind: "simple",
								type: "text",
								property: "case_name",
							},
						],
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "notes",
									caseWrite: { caseType: "member", property: "notes" },
								}),
							],
						},
					],
				},
			],
		});
		const emitted = expandDoc(doc);
		const app = JSON.parse(
			JSON.stringify({
				...retainedSourceBody("shell/app-source"),
				modules: emitted.modules,
				_attachments: emitted._attachments,
			}),
		) as Record<string, unknown>;
		const ctx = readContext({
			...readerInput(await sourceFromBody(app)),
			recordDialect: () => undefined,
		});
		// Every stage up to the binding, the comparison of entry facts among them.
		for (const stage of STAGES) {
			if (stage === bindExpressions) break;
			stage(ctx);
		}
		const read = ctx.draft.modules.find(
			(module) => module.module.name === "Members",
		);
		expect(read?.module.parentCaseModuleUuid).toBeDefined();
		expect(ctx.facts.entryFactsRefused).toEqual([]);
		expect(
			ctx.accounting
				.findings()
				.filter(
					(finding) =>
						finding.code === "unrecognized" &&
						(finding.detail as { name?: string }).name?.startsWith(
							"entry-fact:",
						),
				),
		).toEqual([]);
	});
});
