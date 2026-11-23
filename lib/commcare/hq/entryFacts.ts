/**
 * What CommCare HQ's entry builder reads of an app's JSON when it builds each
 * form's session values, per form and per menu, read from an app source: the
 * source HQ serves, or Nova's emission of a document.
 *
 * HQ writes a form's `<entry>` datums from facts of the app's JSON
 * (`suite_xml/sections/entries.py::EntriesHelper`), and the reads of an app
 * hold no suite. So two app sources whose facts are equal, form by form and
 * menu by menu, with their menus in one order under the same ids, get the
 * same datums from HQ's build. `hqEntryFacts` lists those facts;
 * `entryFactsDifference` and `menuFactsDifference` name the first that
 * differs; `datumIdsFromFacts` is a port of HQ's id rules over the facts
 * alone, which holds the list complete for every shape Nova emits.
 *
 * A form `publishedCaseBlocks` leaves unread has no record: its account is
 * that reader's. A menu is a `Module` or an `AdvancedModule` with a
 * `unique_id`; HQ's other menu kinds hold no form an entry reads.
 */

import { NO_ENTRIES } from "@/lib/domain/records";
import { activeActions, publishedCaseBlocks } from "./publishedCaseBlocks";

import { advancedFormParents, sharedFormParent } from "./sharedFormSource";

export interface HqEntryFacts {
	readonly moduleKind: "Module" | "AdvancedModule";
	readonly caseType: string;
	/** `root_module_id`, as a menu id. */
	readonly rootModule: string | null;
	readonly putInRoot: boolean;
	/**
	 * `parent_select.module_id` where it is active, its relationship is `parent`, and the form
	 * requires a case, the one case where HQ's entry builder walks the selection for it
	 * (`EntriesHelper.get_case_datums_basic_module`).
	 */
	readonly parentSelect: string | null;
	readonly multiSelect: boolean;
	/** A multi-select list's `max_select_value`; `null` on any other list. */
	readonly maxSelect: number | null;
	/** `Detail.auto_select`, which `ModuleBase.is_auto_select` reads on every basic list. */
	readonly autoSelect: boolean;
	/** `ModuleBase.auto_select_case` where an advanced form's load lists its cases from the
	 *  menu (`advancedLoadListMenus`), the one place HQ's build reads it. */
	readonly autoSelectCase: boolean;
	readonly caseListShown: boolean;
	/** `util.py::module_offers_search`. */
	readonly offersSearch: boolean;
	/** `util.py::module_uses_inline_search`. */
	readonly inlineSearch: boolean;
	/** `search_config.instance_name` where the menu searches inline. */
	readonly searchInstance: string | null;
	readonly additionalCaseTypes: readonly string[];
	/** `ModuleBase.has_grouped_tiles`: a tile grouped by an index. */
	readonly groupedTiles: boolean;
	readonly requires: "none" | "case" | "advanced";
	readonly opensCase: boolean;
	/**
	 * Child cases outside any repeat, in list order, each by its case type and
	 * its place in the form's `subcases`, which its datum's id holds.
	 */
	readonly newChildCases: readonly {
		readonly caseType: string;
		readonly index: number;
	}[];
	/** An active usercase update or preload. */
	readonly usesWorkerRecord: boolean;
	/** An advanced form's loads, in order. */
	readonly loads: readonly {
		readonly tag: string;
		readonly caseType: string;
		readonly detailsModule: string | null;
		readonly indexTag: string | null;
		readonly indexName: string | null;
		readonly autoSelect: string | null;
	}[];
	/**
	 * An advanced form's open actions outside any repeat, in order, each with
	 * its place in the form's `open_cases`, which its datum's id holds.
	 */
	readonly opens: readonly {
		readonly tag: string;
		readonly caseType: string;
		readonly index: number;
	}[];
	/** An advanced form's `arbitrary_datums`, by `datum_id`, in order. */
	readonly arbitraryDatums: readonly string[];
}

export const ENTRY_FACT_KEYS: readonly (keyof HqEntryFacts)[] = [
	"moduleKind",
	"caseType",
	"rootModule",
	"putInRoot",
	"parentSelect",
	"multiSelect",
	"maxSelect",
	"autoSelect",
	"autoSelectCase",
	"caseListShown",
	"offersSearch",
	"inlineSearch",
	"searchInstance",
	"additionalCaseTypes",
	"groupedTiles",
	"requires",
	"opensCase",
	"newChildCases",
	"usesWorkerRecord",
	"loads",
	"opens",
	"arbitraryDatums",
];

/** What HQ's entry builder reads of a menu when it builds the datums of another menu's forms: a
 *  parent menu, a parent selection's target, a load's `details_module`. A menu with no form has
 *  one too, which is why these are not left to the per-form record. */
export interface HqMenuFacts {
	readonly moduleKind: "Module" | "AdvancedModule";
	readonly caseType: string;
	readonly rootModule: string | null;
	readonly putInRoot: boolean;
	/** The menu's parent selection where HQ's build walks it (`parentStepRead`). */
	readonly parentSelect: string | null;
	readonly multiSelect: boolean;
	readonly maxSelect: number | null;
	readonly autoSelect: boolean;
	readonly autoSelectCase: boolean;
	readonly inlineSearch: boolean;
	readonly searchInstance: string | null;
	readonly additionalCaseTypes: readonly string[];
	/** The id of the menu's first entry, whose datums a child menu aligns against. */
	readonly firstForm: string | null;
}

export const MENU_FACT_KEYS: readonly (keyof HqMenuFacts)[] = [
	"moduleKind",
	"caseType",
	"rootModule",
	"putInRoot",
	"parentSelect",
	"multiSelect",
	"maxSelect",
	"autoSelect",
	"autoSelectCase",
	"inlineSearch",
	"searchInstance",
	"additionalCaseTypes",
	"firstForm",
];

export interface HqAppEntryFacts {
	/** One record per entry, by the form id in this source. Its content may be shared. */
	readonly forms: ReadonlyMap<string, HqEntryFacts>;
	/** One record per menu, by the menu's id, in HQ's menu order. */
	readonly menus: ReadonlyMap<string, HqMenuFacts>;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, or `null`. */
function idOf(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function objects(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.filter(isObject) : [];
}

/**
 * The case types a stored `additional_case_types` adds to the menu's own, as every reader
 * of it in HQ's build takes the list (`suite_xml/utils.py::get_ordered_case_types`:
 * `set(additional_case_types) - {case_type}`, sorted), so a list naming only the menu's own
 * type adds none.
 */
function otherCaseTypes(stored: unknown, caseType: unknown): string[] {
	if (!Array.isArray(stored)) return [];
	const others = new Set(
		stored.filter(
			(type): type is string => typeof type === "string" && type !== caseType,
		),
	);
	return [...others].sort();
}

/** `Form.requires_case`: a basic form that requires a case, `referral` among them. */
function basicFormRequiresCase(form: JsonObject): boolean {
	return (
		form.doc_type !== "AdvancedForm" &&
		(form.requires === "case" || form.requires === "referral")
	);
}

/**
 * Whether CommCare HQ's build walks `module`'s parent selection
 * (`suite_xml/utils.py::get_select_chain_meta`): for the menu's case list menu item
 * (`EntriesHelper.entry_for_module` builds its entry with no form, so its datums are the
 * chain's), for a form of the menu that requires a case
 * (`EntriesHelper.get_case_datums_basic_module`), and for every menu whose own chain is walked
 * through it. Nowhere else does a build read the selection, so a menu none of these reaches
 * holds it unread.
 */
export function parentStepRead(
	modules: readonly unknown[],
	module: JsonObject,
): boolean {
	if (ownParentStepRead(module)) return true;
	let steps = parentStepsRead.get(modules);
	if (steps === undefined) {
		steps = readParentSteps(modules);
		parentStepsRead.set(modules, steps);
	}
	if (steps.menus.has(module)) return steps.read.has(module);
	// A menu outside the list: read through the menus of the list that select it.
	const { read } = steps;
	return objects(modules).some(
		(other) =>
			selectsParent(other, module.unique_id) &&
			other.unique_id !== module.unique_id &&
			read.has(other),
	);
}

/** A menu whose own entries walk its parent selection: its case list menu item, or a form that
 *  requires a case. */
function ownParentStepRead(module: JsonObject): boolean {
	return (
		(isObject(module.case_list) && module.case_list.show === true) ||
		objects(module.forms).some(basicFormRequiresCase)
	);
}

/** Whether `module` selects the menu whose id is `id` as its parent. */
function selectsParent(module: JsonObject, id: unknown): boolean {
	const select = isObject(module.parent_select)
		? module.parent_select
		: NO_ENTRIES;
	return select.active === true && select.module_id === id;
}

/** For each list of menus, its menus and those whose parent selection a build walks. */
const parentStepsRead = new WeakMap<
	readonly unknown[],
	{ readonly menus: ReadonlySet<unknown>; readonly read: ReadonlySet<unknown> }
>();

/**
 * Every menu of `modules` whose parent selection a build walks, worked out once a list: a menu
 * whose own entries walk it, and every menu a menu that does selects as its parent, through
 * any chain of them. A chain names each menu once (a menu that selects itself walks nothing
 * more), so a menu is read exactly where a chain of distinct menus reaches one whose own
 * entries walk it: each menu and each selection examined once, whatever the depth.
 */
function readParentSteps(modules: readonly unknown[]): {
	readonly menus: ReadonlySet<unknown>;
	readonly read: ReadonlySet<unknown>;
} {
	const menus = objects(modules);
	const byId = new Map<unknown, JsonObject[]>();
	for (const menu of menus) {
		const same = byId.get(menu.unique_id);
		if (same === undefined) byId.set(menu.unique_id, [menu]);
		else same.push(menu);
	}
	const read = new Set<unknown>();
	const pending: JsonObject[] = [];
	for (const menu of menus)
		if (ownParentStepRead(menu)) {
			read.add(menu);
			pending.push(menu);
		}
	for (let child = pending.pop(); child !== undefined; child = pending.pop()) {
		const select = isObject(child.parent_select)
			? child.parent_select
			: NO_ENTRIES;
		if (select.active !== true) continue;
		for (const parent of byId.get(select.module_id) ?? []) {
			if (parent.unique_id === child.unique_id || read.has(parent)) continue;
			read.add(parent);
			pending.push(parent);
		}
	}
	return { menus: new Set(menus), read };
}

/**
 * The menus, by id, an advanced form's chosen load lists its cases from: the menu
 * `EntriesHelper.get_datum_meta_assertions_advanced`'s `get_target_module` gives each load
 * that auto-selects nothing and loads from no lookup table (its `details_module`, else the
 * form's own menu where the case types agree, else the first menu of the load's case type).
 * HQ's build reads a menu's `auto_select_case` there alone (`get_manual_datum`): a basic
 * menu's `is_auto_select` reads its case list's `auto_select`, since `ModuleBase.is_auto_select`
 * tests the method `is_multi_select` without calling it, and an advanced menu's answers false.
 */
export function advancedLoadListMenus(
	modules: readonly unknown[],
): ReadonlySet<string> {
	const menus = objects(modules);
	const listed = new Set<string>();
	for (const module of menus)
		for (const form of objects(module.forms)) {
			if (form.doc_type !== "AdvancedForm" && form.doc_type !== "ShadowForm")
				continue;
			const stored =
				form.doc_type === "ShadowForm" ? form.extra_actions : form.actions;
			const actions = isObject(stored) ? stored : NO_ENTRIES;
			for (const load of objects(actions.load_update_cases)) {
				const select = isObject(load.auto_select)
					? load.auto_select
					: NO_ENTRIES;
				if (idOf(select.mode) !== null || isObject(load.load_case_from_fixture))
					continue;
				const named = idOf(load.details_module);
				const target =
					named !== null
						? named
						: load.case_type === module.case_type
							? idOf(module.unique_id)
							: idOf(
									menus.find((menu) => menu.case_type === load.case_type)
										?.unique_id,
								);
				if (target !== null) listed.add(target);
			}
		}
	return listed;
}

/** The menu's short case list detail, `{}` where it has none. */
function shortDetail(module: JsonObject): JsonObject {
	const details = module.case_details;
	return isObject(details) && isObject(details.short)
		? details.short
		: NO_ENTRIES;
}

/** `max_select_value`'s default, which HQ's model holds where a list stores none. */
const DEFAULT_MAX_SELECT = 100;

/** The facts a form's record and a menu's record share: the menu's own. */
type OwnMenuFacts = Omit<HqMenuFacts, "firstForm"> &
	Pick<HqEntryFacts, "caseListShown" | "offersSearch" | "groupedTiles">;

/** What other menus decide of a menu's facts: whether its parent selection is walked and
 *  whether a load lists from it. */
interface MenuReads {
	readonly parentStep: boolean;
	readonly listedByALoad: boolean;
}

function ownMenuFacts(
	module: JsonObject,
	moduleKind: "Module" | "AdvancedModule",
	reads: MenuReads,
): OwnMenuFacts {
	const basic = moduleKind === "Module";
	const short = shortDetail(module);
	// `AdvancedModule.is_multi_select` and `is_auto_select` are false, and it
	// holds no parent selection.
	const multiSelect = basic && short.multi_select === true;
	const stored = short.max_select_value;
	// `-1` is the same state as the default by the manifest's
	// `menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list`.
	const maxSelect = !multiSelect
		? null
		: typeof stored === "number" && stored !== -1
			? stored
			: DEFAULT_MAX_SELECT;
	const parentSelect = module.parent_select;
	const search = isObject(module.search_config)
		? module.search_config
		: NO_ENTRIES;
	const offersSearch =
		(Array.isArray(search.properties) && search.properties.length > 0) ||
		(Array.isArray(search.default_properties) &&
			search.default_properties.length > 0);
	const inlineSearch =
		offersSearch &&
		search.inline_search === true &&
		search.auto_launch === true;
	const group = short.case_tile_group;
	return {
		moduleKind,
		caseType: typeof module.case_type === "string" ? module.case_type : "",
		rootModule: idOf(module.root_module_id),
		putInRoot: module.put_in_root === true,
		parentSelect:
			basic &&
			reads.parentStep &&
			isObject(parentSelect) &&
			parentSelect.active === true &&
			parentSelect.relationship === "parent"
				? idOf(parentSelect.module_id)
				: null,
		multiSelect,
		maxSelect,
		autoSelect: basic && short.auto_select === true,
		autoSelectCase: reads.listedByALoad && module.auto_select_case === true,
		inlineSearch,
		searchInstance: inlineSearch ? idOf(search.instance_name) : null,
		additionalCaseTypes: otherCaseTypes(
			search.additional_case_types,
			module.case_type,
		),
		caseListShown: isObject(module.case_list) && module.case_list.show === true,
		offersSearch,
		groupedTiles:
			typeof short.case_tile_template === "string" &&
			short.case_tile_template !== "" &&
			isObject(group) &&
			idOf(group.index_identifier) !== null,
	};
}

/** The facts of one form read by `publishedCaseBlocks`, whose actions are sound. */
function formFacts(
	form: JsonObject,
	menu: OwnMenuFacts,
	parent?: JsonObject,
): HqEntryFacts {
	const actions = isObject(form.actions) ? form.actions : NO_ENTRIES;
	const caseFacts =
		parent !== undefined
			? advancedFormFacts(form, {
					// ShadowForm._merge_actions takes every selection field from the extra
					// rows, in their order. Only the parent's open actions supply new cases.
					// A shadow's own arbitrary datums are its own (ShadowForm is an
					// AdvancedForm), so they come from the entry.
					load_update_cases: isObject(form.extra_actions)
						? form.extra_actions.load_update_cases
						: [],
					open_cases: isObject(parent.actions) ? parent.actions.open_cases : [],
				})
			: form.doc_type === "AdvancedForm"
				? advancedFormFacts(form, actions)
				: basicFormFacts(form, actions);
	return {
		moduleKind: menu.moduleKind,
		caseType: menu.caseType,
		rootModule: menu.rootModule,
		putInRoot: menu.putInRoot,
		parentSelect: basicFormRequiresCase(form) ? menu.parentSelect : null,
		multiSelect: menu.multiSelect,
		maxSelect: menu.maxSelect,
		autoSelect: menu.autoSelect,
		autoSelectCase: menu.autoSelectCase,
		caseListShown: menu.caseListShown,
		offersSearch: menu.offersSearch,
		inlineSearch: menu.inlineSearch,
		searchInstance: menu.searchInstance,
		additionalCaseTypes: menu.additionalCaseTypes,
		groupedTiles: menu.groupedTiles,
		...caseFacts,
	};
}

type CaseFacts = Pick<
	HqEntryFacts,
	| "requires"
	| "opensCase"
	| "newChildCases"
	| "usesWorkerRecord"
	| "loads"
	| "opens"
	| "arbitraryDatums"
>;

/** A basic form's: `Form.requires_case` (`case`, or the legacy `referral`),
 *  its active open, its root subcases and `util.py::actions_use_usercase`. */
function basicFormFacts(form: JsonObject, actions: JsonObject): CaseFacts {
	const requires = form.requires ?? "none";
	const active = activeActions(actions, requires);
	const mapsAny = (type: string, key: string) => {
		const action = actions[type];
		return (
			active.has(type) &&
			isObject(action) &&
			isObject(action[key]) &&
			Object.keys(action[key] as JsonObject).length > 0
		);
	};
	return {
		requires: requires === "case" || requires === "referral" ? "case" : "none",
		opensCase: active.has("open_case"),
		newChildCases: active.has("subcases")
			? objects(actions.subcases).flatMap((subcase, index) =>
					idOf(subcase.repeat_context) === null
						? [
								{
									caseType:
										typeof subcase.case_type === "string"
											? subcase.case_type
											: "",
									index,
								},
							]
						: [],
				)
			: [],
		usesWorkerRecord:
			mapsAny("usercase_update", "update") ||
			mapsAny("usercase_preload", "preload"),
		loads: [],
		opens: [],
		arbitraryDatums: [],
	};
}

/** An advanced form's loads and its open actions outside any repeat. */
function advancedFormFacts(form: JsonObject, actions: JsonObject): CaseFacts {
	return {
		requires: "advanced",
		opensCase: false,
		newChildCases: [],
		usesWorkerRecord: false,
		loads: objects(actions.load_update_cases).map((load) => {
			const index = isObject(load.case_index) ? load.case_index : NO_ENTRIES;
			const indexTag = idOf(index.tag);
			const autoSelect = isObject(load.auto_select)
				? load.auto_select
				: NO_ENTRIES;
			return {
				tag: typeof load.case_tag === "string" ? load.case_tag : "",
				caseType: typeof load.case_type === "string" ? load.case_type : "",
				detailsModule: idOf(load.details_module),
				indexTag,
				indexName:
					indexTag === null
						? null
						: typeof index.reference_id === "string"
							? index.reference_id
							: "parent",
				autoSelect: idOf(autoSelect.mode),
			};
		}),
		opens: objects(actions.open_cases).flatMap((open, index) =>
			idOf(open.repeat_context) === null
				? [
						{
							tag: typeof open.case_tag === "string" ? open.case_tag : "",
							caseType:
								typeof open.case_type === "string" ? open.case_type : "",
							index,
						},
					]
				: [],
		),
		arbitraryDatums: objects(form.arbitrary_datums).map((datum) =>
			typeof datum.datum_id === "string" ? datum.datum_id : "",
		),
	};
}

/** Every fact HQ's entry builder reads, per form and per menu, of `source`. */
export function hqEntryFacts(source: unknown): HqAppEntryFacts {
	const forms = new Map<string, HqEntryFacts>();
	const menus = new Map<string, HqMenuFacts>();
	if (!isObject(source) || !Array.isArray(source.modules))
		return { forms, menus };
	const read = publishedCaseBlocks(source).forms;
	const parents = advancedFormParents(source.modules);
	const listed = advancedLoadListMenus(source.modules);
	for (const module of source.modules) {
		if (!isObject(module)) continue;
		const kind = module.doc_type;
		if (kind !== "Module" && kind !== "AdvancedModule") continue;
		const id = idOf(module.unique_id);
		const own = ownMenuFacts(module, kind, {
			parentStep: parentStepRead(source.modules, module),
			listedByALoad: id !== null && listed.has(id),
		});
		const moduleForms = objects(module.forms);
		if (id !== null) {
			const {
				caseListShown: _caseListShown,
				offersSearch: _offersSearch,
				groupedTiles: _groupedTiles,
				...menu
			} = own;
			menus.set(id, {
				...menu,
				firstForm: idOf(moduleForms[0]?.unique_id),
			});
		}
		for (const form of moduleForms) {
			const entryId = idOf(form.unique_id);
			if (entryId === null) continue;
			const parent = sharedFormParent(form, parents);
			if (
				form.doc_type === "ShadowForm" &&
				(kind !== "AdvancedModule" || parent === undefined)
			)
				continue;
			const xmlns = idOf((parent ?? form).xmlns);
			if (xmlns === null || !read.has(xmlns)) continue;
			forms.set(entryId, formFacts(form, own, parent));
		}
	}
	return { forms, menus };
}

/** Two facts equal as JSON values. */
function factEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => factEqual(item, b[index]))
		);
	}
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((key) => key in b && factEqual(a[key], b[key]))
		);
	}
	return false;
}

/** The first key on which two forms' facts differ, in `ENTRY_FACT_KEYS` order. */
export function entryFactsDifference(
	a: HqEntryFacts,
	b: HqEntryFacts,
): keyof HqEntryFacts | undefined {
	return ENTRY_FACT_KEYS.find((key) => !factEqual(a[key], b[key]));
}

/** The first key on which two menus' facts differ, in `MENU_FACT_KEYS` order. */
export function menuFactsDifference(
	a: HqMenuFacts,
	b: HqMenuFacts,
): keyof HqMenuFacts | undefined {
	return MENU_FACT_KEYS.find((key) => !factEqual(a[key], b[key]));
}

/** A menu's search, which each fact of it reads whole. */
const SEARCH_FIELDS = [
	"Module.search_config",
	"AdvancedModule.search_config",
	"CaseSearch",
];

/**
 * The stored fields each fact is read from, each `Class.field`, or `Class` for every field of
 * the class: the schema items of the surface manifest (`schema:<Class>.<field>`) that
 * `ownMenuFacts`, `basicFormFacts` and `advancedFormFacts` read. A list's `multi_select` and
 * `max_select_value` are one setting, the several cases a worker may choose, so each fact of
 * it names both.
 */
const FACT_FIELDS: Readonly<
	Record<keyof HqEntryFacts | keyof HqMenuFacts, readonly string[]>
> = {
	moduleKind: ["Module.doc_type", "AdvancedModule.doc_type"],
	caseType: ["Module.case_type", "AdvancedModule.case_type"],
	rootModule: ["Module.root_module_id", "AdvancedModule.root_module_id"],
	putInRoot: ["Module.put_in_root", "AdvancedModule.put_in_root"],
	parentSelect: ["Module.parent_select", "ParentSelect"],
	multiSelect: ["Detail.multi_select", "Detail.max_select_value"],
	maxSelect: ["Detail.multi_select", "Detail.max_select_value"],
	autoSelect: ["Detail.auto_select"],
	autoSelectCase: [
		"Module.auto_select_case",
		"AdvancedModule.auto_select_case",
		// This setting affects a list only when a manual load uses its
		// details. Refusing that load also removes this effective value.
		"AdvancedFormActions.load_update_cases",
		"LoadUpdateAction",
		"CaseIndex",
	],
	caseListShown: [
		"Module.case_list",
		"AdvancedModule.case_list",
		"CaseList.show",
	],
	offersSearch: [...SEARCH_FIELDS, "CaseSearchProperty"],
	inlineSearch: SEARCH_FIELDS,
	searchInstance: SEARCH_FIELDS,
	additionalCaseTypes: SEARCH_FIELDS,
	groupedTiles: [
		"Detail.case_tile_template",
		"Detail.case_tile_group",
		"CaseTileGroupConfig",
	],
	firstForm: [
		"Module.forms",
		"AdvancedModule.forms",
		"Form.unique_id",
		"AdvancedForm.unique_id",
		"ShadowForm.unique_id",
	],
	requires: ["Form.requires"],
	opensCase: ["FormActions.open_case", "OpenCaseAction"],
	newChildCases: ["FormActions.subcases", "OpenSubCaseAction"],
	usesWorkerRecord: [
		"FormActions.usercase_update",
		"FormActions.usercase_preload",
	],
	loads: [
		"AdvancedFormActions.load_update_cases",
		"LoadUpdateAction",
		"CaseIndex",
		"AutoSelectCase",
	],
	opens: ["AdvancedFormActions.open_cases", "AdvancedOpenCaseAction"],
	arbitraryDatums: ["AdvancedForm.arbitrary_datums", "ArbitraryDatum"],
};

/**
 * Whether the fact `fact` is read from the surface item `key`: a schema item naming a field
 * the fact reads, or any field of a class it reads whole. Where the reader refuses such an
 * item, the document Nova emits leaves the refused value out, so the fact differs for that
 * refusal.
 */
export function factReadsSurfaceKey(
	fact: keyof HqEntryFacts | keyof HqMenuFacts,
	key: string,
): boolean {
	if (!key.startsWith("schema:")) return false;
	const item = key.slice("schema:".length);
	const dot = item.indexOf(".");
	const owner = dot === -1 ? item : item.slice(0, dot);
	return FACT_FIELDS[fact].some((field) =>
		field.includes(".") ? field === item : field === owner,
	);
}

// ── HQ's id rules, ported ─────────────────────────────────────────────

/**
 * One datum as `entries.py::FormDatumMeta` holds what an id rule reads: its
 * id, its case type, whether a worker selects it, whether it is an
 * `instance-datum` (the datum `_same_case` tells apart by its root name),
 * whether an action made it, and, for a selection a menu's list supplies,
 * that menu's search, which places a query before it.
 */
interface DatumMeta {
	id: string;
	readonly caseType: string | null;
	readonly requiresSelection: boolean;
	readonly instance: boolean;
	readonly fromAction: boolean;
	readonly search?: {
		readonly inlineSearch: boolean;
		readonly searchInstance: string | null;
	};
}

/** A menu's facts by id, or why the facts cannot say. */
function menuOf(app: HqAppEntryFacts, id: string): HqMenuFacts {
	const menu = app.menus.get(id);
	if (menu === undefined)
		throw new Error(
			`The entry facts name the menu ${id}, which they hold no record of. Every menu a form's facts name is read with them; look at how the facts were made.`,
		);
	return menu;
}

/**
 * `suite_xml/utils.py::get_select_chain_meta` with its datums
 * (`entries.py::EntriesHelper.get_datum_meta_module`): the form's own menu,
 * then each parent selection's menu, read root first, each under its session
 * variable. Only a basic menu has a chain.
 */
function selectionChain(
	own: Pick<
		HqMenuFacts,
		| "moduleKind"
		| "caseType"
		| "parentSelect"
		| "multiSelect"
		| "inlineSearch"
		| "searchInstance"
	>,
	app: HqAppEntryFacts,
): DatumMeta[] {
	if (own.moduleKind !== "Module") return [];
	const chain: DatumMeta[] = [];
	const seen = new Set<string>();
	const datum = (menu: typeof own, id: string): DatumMeta => ({
		id,
		caseType: menu.caseType,
		requiresSelection: true,
		instance: menu.multiSelect,
		fromAction: true,
		search: {
			inlineSearch: menu.inlineSearch,
			searchInstance: menu.searchInstance,
		},
	});
	chain.push(datum(own, own.multiSelect ? "selected_cases" : "case_id"));
	let previous: typeof own = own;
	while (previous.moduleKind === "Module" && previous.parentSelect !== null) {
		if (seen.has(previous.parentSelect))
			throw new Error(
				`The entry facts' parent selections run in a circle through the menu ${previous.parentSelect}, which CommCare HQ's build refuses.`,
			);
		seen.add(previous.parentSelect);
		const current = menuOf(app, previous.parentSelect);
		const parents = "parent_".repeat(chain.length);
		chain.push(
			datum(
				current,
				current.multiSelect ? `${parents}selected_cases` : `${parents}id`,
			),
		);
		previous = current;
	}
	return chain.reverse();
}

/**
 * `entries.py::EntriesHelper.add_parent_datums`: a child menu's datums
 * aligned against its root's first form's. A datum whose id a root datum
 * holds is renamed `<id>_<case type>`; each root datum no worker selects is
 * carried; a root selection takes the child's next datum where it is the same
 * case on the same kind of datum, under the root's id.
 */
function alignWithRoot(
	datums: DatumMeta[],
	rootModule: string | null,
	app: HqAppEntryFacts,
	depth: number,
): DatumMeta[] {
	if (rootModule === null) return datums;
	const root = menuOf(app, rootModule);
	const parentDatums = firstFormDatums(root, app, depth + 1);
	if (parentDatums.length === 0) return datums;
	const byId = new Map(datums.map((datum) => [datum.id, datum]));
	const aligned: DatumMeta[] = [];
	const remaining = [...datums];
	for (const parent of parentDatums) {
		const clash = byId.get(parent.id);
		if (clash !== undefined)
			clash.id = `${clash.id}_${clash.caseType ?? "None"}`;
		if (!parent.requiresSelection) {
			aligned.push(parent);
			continue;
		}
		const next = remaining[0];
		if (
			next !== undefined &&
			next.caseType === parent.caseType &&
			next.instance === parent.instance &&
			next.fromAction
		) {
			next.id = parent.id;
			aligned.push(next);
			remaining.shift();
		}
	}
	return [...aligned, ...remaining];
}

/** `EntriesHelper._get_first_forms_datums`: the datums of the menu's first form. */
function firstFormDatums(
	menu: HqMenuFacts,
	app: HqAppEntryFacts,
	depth: number,
): DatumMeta[] {
	if (menu.firstForm === null) return [];
	const facts = app.forms.get(menu.firstForm);
	if (facts === undefined)
		throw new Error(
			`The entry facts hold no record of the form ${menu.firstForm}, the first form of a menu another menu aligns against. A child menu's session values follow its root's first form; look at why that form has no facts.`,
		);
	return formDatums(facts, app, depth);
}

/**
 * `EntriesHelper.get_datums_meta_for_form_generic`: a basic form's
 * (`get_case_datums_basic_module`) or an advanced form's
 * (`get_datum_meta_assertions_advanced`, then `get_new_case_id_datums_meta`),
 * with no query datum.
 */
function formDatums(
	facts: HqEntryFacts,
	app: HqAppEntryFacts,
	depth: number,
): DatumMeta[] {
	if (depth > app.menus.size + 1)
		throw new Error(
			"The entry facts' parent menus run in a circle, which CommCare HQ's build refuses.",
		);
	const newCase = (id: string, caseType: string): DatumMeta => ({
		id,
		caseType,
		requiresSelection: false,
		instance: false,
		fromAction: true,
	});
	if (facts.requires === "advanced") {
		const loads = facts.loads.map(
			(load): DatumMeta =>
				load.autoSelect !== null
					? {
							id: `case_id_${load.tag}`,
							caseType: null,
							requiresSelection: false,
							instance: false,
							fromAction: true,
						}
					: {
							id: `case_id_${load.tag}`,
							caseType: load.caseType,
							requiresSelection: true,
							instance: false,
							fromAction: true,
						},
		);
		// `get_datum_meta_assertions_advanced` aligns the loads and the
		// arbitrary datums with the root; the new cases follow.
		const arbitrary = facts.arbitraryDatums.map(
			(id): DatumMeta => ({
				id,
				caseType: null,
				requiresSelection: false,
				instance: false,
				fromAction: false,
			}),
		);
		return [
			...alignWithRoot([...loads, ...arbitrary], facts.rootModule, app, depth),
			...facts.opens.map((open) =>
				newCase(`case_id_new_${open.caseType}_${open.index}`, open.caseType),
			),
		];
	}
	const datums: DatumMeta[] =
		facts.requires === "case" ? selectionChain(facts, app) : [];
	const caseDatum = datums.at(-1);
	if (facts.opensCase)
		datums.push(newCase(`case_id_new_${facts.caseType}_0`, facts.caseType));
	const offset = facts.opensCase ? 1 : 0;
	for (const child of facts.newChildCases)
		datums.push(
			newCase(
				`case_id_new_${child.caseType}_${child.index + offset}`,
				child.caseType,
			),
		);
	if (facts.usesWorkerRecord)
		datums.push({
			id: "usercase_id",
			caseType: "commcare-user",
			requiresSelection: false,
			instance: false,
			fromAction: false,
		});
	if (caseDatum !== undefined && facts.groupedTiles)
		datums.push({
			id: `${caseDatum.id}_parent_ids`,
			caseType: null,
			requiresSelection: false,
			instance: false,
			fromAction: false,
		});
	return alignWithRoot(datums, facts.rootModule, app, depth);
}

/**
 * The session value ids HQ's entry builder gives a form, in order, from the
 * facts alone: a port of its id rules (`case_id`, a parent selection's
 * `parent_id`, a child menu's renamed id, a load's `case_id_<tag>`, a new
 * case's `case_id_new_<type>_<n>`, `usercase_id`, a grouped tile's
 * `<id>_parent_ids`, a search's query before the selection it supplies), and
 * of nothing else it builds. It reads `facts` and the app's other records
 * (the menus a parent menu or a parent selection names, and a root menu's
 * first form) and no document; a record it needs and the facts lack is an
 * error, never a guess.
 */
export function datumIdsFromFacts(
	facts: HqEntryFacts,
	app: HqAppEntryFacts,
): readonly string[] {
	const datums = formDatums(facts, app, 0);
	if (facts.requires === "advanced") return datums.map((datum) => datum.id);
	// `EntriesHelper.add_remote_query_datums`, after the alignment.
	return datums.flatMap((datum) =>
		datum.search?.inlineSearch === true && datum.caseType !== null
			? [
					datum.search.searchInstance === null
						? "results:inline"
						: `results:${datum.search.searchInstance}`,
					datum.id,
				]
			: [datum.id],
	);
}
