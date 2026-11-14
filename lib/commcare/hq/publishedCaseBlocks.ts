/**
 * Every case block CommCare HQ's build of each form of an app source writes,
 * read from the source HQ holds: what a deployment's baseline carries after a
 * push, or an imported app's own source.
 *
 * HQ's stored XForm holds no basic or advanced case block. HQ's build writes
 * those from the form's `actions` (`corehq/apps/app_manager/xform.py::
 * XForm._create_casexml`, `XForm._add_usercase`, `XForm._create_casexml_advanced`),
 * so they are derived here from `actions` by the same rules. A Save to Case
 * block is in the stored XForm itself, an element carrying Vellum's `role`
 * attribute `SaveToCase` (`Vellum/src/saveToCase.js`), and so is each
 * model-iteration repeat (`Vellum/src/modeliteration.js`); both are read from
 * the form's XForm under `_attachments`, parsed and walked as elements.
 *
 * Forms are keyed by their `xmlns`, never by position. A source that is not
 * an application gives no form. A form this reader cannot read is never
 * guessed and never passed over in silence: it is listed in `unread` by its
 * position, with why (`UnreadFormReason`): a shadow form, whose actions are
 * its parent's; a form of another kind; no `xmlns`, or one two forms share; an
 * XForm missing or unparsed; actions HQ's build could not read; and blocks
 * that depend on what the source does not say (a data registry's case, a
 * visit schedule).
 *
 * Every path is a data path relative to the instance root, its element names
 * joined by `/`. The own block's path is its `case` element at the data root;
 * every other block's path is the element its `case` stands in. Each
 * `properties` map holds HQ's own key for each property a block writes
 * (`name` for the case's name, as HQ's update maps hold it) and the question
 * path HQ reads it from (`ConditionalCaseUpdate.question_path`), as HQ stores
 * it. A condition's question is the one path read relative to the data root,
 * as `xform.py::XForm.resolve_path` resolves it.
 */

import type { Element } from "domhandler";
import {
	elementChildren,
	isElement,
	type NamespaceScope,
	namespacedAttribute,
	splitName,
	VELLUM_NS,
	XFORMS_NS,
	XHTML_NS,
} from "../xmlNamespaces";
import { tryParseXml } from "../xmlParse";

/** A condition as Case Management states it, the question's path relative to the data root. */
export type PublishedCondition =
	| { readonly type: "always" }
	| { readonly type: "never" }
	| {
			readonly type: "if";
			readonly question: string;
			readonly answer: string | null;
			readonly operator: "=" | "selected" | "boolean_true";
	  };

export interface PublishedIndex {
	readonly identifier: string;
	/** `own` for a basic child's index to the form's own case; a tag for an advanced one. */
	readonly target:
		| { readonly kind: "own" }
		| { readonly kind: "tag"; readonly tag: string };
	readonly relationship: "child" | "extension" | "question";
}

export type PublishedCaseBlock =
	| {
			readonly kind: "basic-own";
			readonly path: "case";
			readonly caseType: string;
			readonly opens: boolean;
			readonly closes: boolean;
			/** `open_case`'s; `always` where the form does not open its case. */
			readonly condition: PublishedCondition;
			/** `close_case`'s; `never` where it is inactive. */
			readonly closeCondition: PublishedCondition;
			/**
			 * The `session/data/<id>` the block's case id reads: `case_id`, or
			 * `case_id_new_<type>_0` where the form opens its case; `null` where
			 * HQ reads it from the entry (a menu with a parent menu or a parent
			 * selection), which `entryFacts.ts::hqEntryFacts` covers.
			 */
			readonly sessionDatum: string | null;
			/** `owner_id` among the update keys. */
			readonly ownerWritten: boolean;
			readonly properties: ReadonlyMap<string, string>;
			/** The update keys whose `update_mode` is `edit`. */
			readonly editOnly: ReadonlySet<string>;
	  }
	| {
			readonly kind: "basic-usercase";
			readonly path: "commcare_usercase";
			readonly properties: ReadonlyMap<string, string>;
			readonly editOnly: ReadonlySet<string>;
	  }
	| {
			readonly kind: "basic-subcase";
			readonly index: number;
			readonly path: string;
			readonly repeatContext: string | null;
			readonly caseType: string;
			readonly condition: PublishedCondition;
			readonly closeCondition: PublishedCondition;
			/** One `child` index to the form's own case, or none. */
			readonly indices: readonly PublishedIndex[];
			readonly ownerWritten: boolean;
			readonly properties: ReadonlyMap<string, string>;
			readonly editOnly: ReadonlySet<string>;
	  }
	| {
			readonly kind: "advanced";
			readonly action: "load" | "open";
			readonly tag: string;
			readonly path: string;
			readonly caseType: string;
			/** An open action's `open_condition`; `always` on a load. */
			readonly condition: PublishedCondition;
			readonly closeCondition: PublishedCondition;
			readonly indices: readonly PublishedIndex[];
			readonly ownerWritten: boolean;
			readonly properties: ReadonlyMap<string, string>;
			readonly editOnly: ReadonlySet<string>;
	  }
	| {
			readonly kind: "save-to-case";
			readonly path: string;
			readonly caseType: string | null;
			/** `create`, `update`, `close`, in that order, each present where the block holds the child. */
			readonly actions: readonly ("create" | "update" | "close")[];
			readonly indices: readonly {
				readonly identifier: string;
				readonly relationship: string | null;
			}[];
			/**
			 * The block's property leaves, sorted: each element child of its
			 * `create` and of its `update`, as `create/<name>` and
			 * `update/<name>`.
			 */
			readonly properties: readonly string[];
	  };

export interface PublishedForm {
	readonly xmlns: string;
	readonly blocks: readonly PublishedCaseBlock[];
	/** The data path of each model-iteration repeat's row (`…/item`), as Vellum writes the shape. */
	readonly modelIterationRows: readonly string[];
}

/** Why a form of the source is left out. */
export type UnreadFormReason =
	| "no-xmlns"
	| "shared-xmlns"
	| "shadow-form"
	| "unknown-form-kind"
	| "no-xform"
	| "xform-unparsed"
	| "actions-malformed"
	| "visit-schedule"
	| "registry-load";

/** A form left out, by its position in the source, with why. */
export interface UnreadPublishedForm {
	readonly menu: number;
	readonly form: number;
	readonly xmlns: string | null;
	readonly reason: UnreadFormReason;
}

export interface PublishedCaseBlocks {
	readonly forms: ReadonlyMap<string, PublishedForm>;
	/** Every form left out, by position, with why. */
	readonly unread: readonly UnreadPublishedForm[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectList(value: unknown): JsonObject[] | undefined {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every(isObject)) return undefined;
	return value;
}

function stringOr<T>(value: unknown, fallback: T): string | T {
	return typeof value === "string" ? value : fallback;
}

/** A form HQ's source holds that this reader cannot read: it is left out, with why. */
class Unread extends Error {
	constructor(readonly reason: UnreadFormReason) {
		super(reason);
	}
}

function unread(reason: UnreadFormReason = "actions-malformed"): never {
	throw new Unread(reason);
}

// ── HQ's actions ──────────────────────────────────────────────────────

/** `models/form_actions.py::FormActionCondition.is_active`: `if` or `always`. */
function conditionActive(condition: unknown): boolean {
	return (
		isObject(condition) &&
		(condition.type === "if" || condition.type === "always")
	);
}

/** A `FormAction`'s `is_active`: its condition is active. */
function actionActive(action: unknown): action is JsonObject {
	return isObject(action) && conditionActive(action.condition);
}

/** The question path of a `ConditionalCaseUpdate`. */
function questionPath(update: unknown): string | undefined {
	return isObject(update) && typeof update.question_path === "string"
		? update.question_path
		: undefined;
}

const ALWAYS: PublishedCondition = { type: "always" };
const NEVER: PublishedCondition = { type: "never" };

/**
 * A `FormActionCondition` as Case Management states it. An absent condition,
 * or one with no `type`, is the schema's default, `never`; an absent or null
 * `operator` is its default, `=`. An `if` names its question relative to the
 * data root `root`, as `xform.py::XForm.resolve_path` resolves it: an
 * absolute path under the root loses `/<root>/`, any other path is already
 * from the root. A type, an operator or an answer outside the schema, and an
 * `if` whose question names nothing under the root, is a condition HQ's build
 * cannot state, and makes the form unread.
 */
function readCondition(condition: unknown, root: string): PublishedCondition {
	if (condition === undefined || condition === null) return NEVER;
	if (!isObject(condition)) unread();
	const type = condition.type ?? "never";
	if (type === "never") return NEVER;
	if (type === "always") return ALWAYS;
	if (type !== "if") unread();
	const operator = condition.operator ?? "=";
	if (
		operator !== "=" &&
		operator !== "selected" &&
		operator !== "boolean_true"
	)
		unread();
	const answer = condition.answer ?? null;
	if (answer !== null && typeof answer !== "string") unread();
	const question = condition.question;
	if (typeof question !== "string" || question === "") unread();
	return {
		type: "if",
		question: question.startsWith("/")
			? relativeDataPath(question, root)
			: question,
		answer,
		operator,
	};
}

/**
 * A `SchemaDictProperty(ConditionalCaseUpdate)` as property → question path,
 * in HQ's key order, each key whose `update_mode` is `edit` added to
 * `editOnly`. An entry with no question path is not a write HQ's build can
 * bind, and an `update_mode` outside the schema's two is none HQ's build
 * reads; either makes the form unread.
 */
function updateMap(
	value: unknown,
	into = new Map<string, string>(),
	editOnly = new Set<string>(),
): { properties: Map<string, string>; editOnly: Set<string> } {
	if (value === undefined || value === null)
		return { properties: into, editOnly };
	if (!isObject(value)) unread();
	for (const [key, update] of Object.entries(value)) {
		const path = questionPath(update);
		if (path === undefined) unread();
		into.set(key, path);
		const mode = (update as JsonObject).update_mode ?? "always";
		if (mode === "edit") editOnly.add(key);
		else if (mode !== "always") unread();
	}
	return { properties: into, editOnly };
}

/**
 * An absolute path under the data root `root` (`/data/children`), as a data
 * path from the instance root (`children`). Any other path names nothing
 * HQ's build can place, and makes the form unread.
 */
function relativeDataPath(absolute: string, root: string): string {
	const [empty, first, ...rest] = absolute.split("/");
	if (empty !== "" || first !== root || rest.length === 0) unread();
	if (rest.some((segment) => segment === "")) unread();
	return rest.join("/");
}

/** `xform.py::autoset_owner_id_for_*`'s test: `owner_id` among a block's update keys. */
function writesOwner(properties: ReadonlyMap<string, string>): boolean {
	return properties.has("owner_id");
}

/** `xform.py::_module_loads_registry_case`: whether the menu offers a data
 *  registry search that loads the case (`util.py::module_loads_registry_case`). */
function mayLoadRegistryCase(module: JsonObject): boolean {
	const search = module.search_config;
	if (!isObject(search)) return false;
	const offersSearch =
		(Array.isArray(search.properties) && search.properties.length > 0) ||
		(Array.isArray(search.default_properties) &&
			search.default_properties.length > 0);
	return (
		offersSearch &&
		typeof search.data_registry === "string" &&
		search.data_registry !== "" &&
		search.data_registry_workflow === "load_case"
	);
}

/** `models/modules.py::ModuleBase.is_multi_select`: the menu's short case
 *  list selects several cases. */
export function isMultiSelectMenu(module: JsonObject): boolean {
	return isMultiSelect(module);
}

/** `util.py::module_loads_registry_case` for a menu as stored. */
export function menuMayLoadRegistryCase(module: JsonObject): boolean {
	return mayLoadRegistryCase(module);
}

function isMultiSelect(module: JsonObject): boolean {
	const details = module.case_details;
	return (
		isObject(details) &&
		isObject(details.short) &&
		details.short.multi_select === true
	);
}

/** The action types `models/forms.py::Form.active_actions` reads for the
 *  form's `requires`. */
export function activeActionTypes(requires: unknown): readonly string[] {
	if (requires === undefined || requires === "none")
		return [
			"open_case",
			"update_case",
			"close_case",
			"subcases",
			"usercase_update",
			"usercase_preload",
		];
	if (requires === "case")
		return [
			"update_case",
			"close_case",
			"case_preload",
			"subcases",
			"usercase_update",
			"usercase_preload",
			"load_from_form",
		];
	return [
		"open_case",
		"update_case",
		"close_case",
		"case_preload",
		"subcases",
		"usercase_update",
		"usercase_preload",
	];
}

/**
 * `models/forms.py::FormBase._get_active_actions`: a list is active when it
 * holds an entry, a preload when it maps any question, any other action when
 * its condition is active.
 */
export function activeActions(
	actions: JsonObject,
	requires: unknown,
): ReadonlySet<string> {
	const active = new Set<string>();
	for (const type of activeActionTypes(requires)) {
		const action = actions[type];
		if (type === "subcases") {
			if (Array.isArray(action) && action.length > 0) active.add(type);
		} else if (type.endsWith("_preload") || type === "load_from_form") {
			if (
				isObject(action) &&
				isObject(action.preload) &&
				Object.keys(action.preload).length > 0
			)
				active.add(type);
		} else if (actionActive(action)) active.add(type);
	}
	return active;
}

/**
 * The session value the own block's case id reads
 * (`xform.py::get_add_case_preloads_case_id_xpath`): the new case's
 * `case_id_new_<type>_0` where the form opens its case
 * (`models/forms.py::Form.session_var_for_action`), `null` in a menu with a
 * parent menu or an active parent selection, where HQ reads it from the
 * entry, and `case_id` otherwise.
 */
function ownSessionDatum(
	module: JsonObject,
	caseType: string,
	opens: boolean,
): string | null {
	if (opens) return `case_id_new_${caseType}_0`;
	const rootModule =
		typeof module.root_module_id === "string" && module.root_module_id !== "";
	const parentSelect =
		isObject(module.parent_select) && module.parent_select.active === true;
	return rootModule || parentSelect ? null : "case_id";
}

/**
 * The blocks of a basic form, by `xform.py::XForm._create_casexml` and
 * `XForm._add_usercase`.
 */
function basicBlocks(
	form: JsonObject,
	module: JsonObject,
	root: string,
): PublishedCaseBlock[] {
	const actions = form.actions;
	if (!isObject(actions)) unread();
	const requires = form.requires ?? "none";
	const active = activeActions(actions, requires);
	const opens = active.has("open_case");
	// HQ's build reads whether the project space may use data registries,
	// which the source does not say.
	if (!isMultiSelect(module) && !opens && mayLoadRegistryCase(module))
		unread("registry-load");
	// `default_case_management`: off in a menu that selects several cases,
	// unless the form opens a case.
	const defaultCaseManagement = !isMultiSelect(module) || opens;
	const caseType = stringOr(module.case_type, "");
	const blocks: PublishedCaseBlock[] = [];

	// The own block exists where some action is active and the form requires
	// a case or opens one, and is written where it holds anything: under
	// default case management it binds the case id or creates the case, and
	// otherwise it holds nothing.
	const ownBlock = active.size > 0 && !(requires === "none" && !opens);
	if (ownBlock && defaultCaseManagement) {
		const properties = new Map<string, string>();
		const editOnly = new Set<string>();
		let condition = ALWAYS;
		if (opens) {
			const open = actions.open_case as JsonObject;
			condition = readCondition(open.condition, root);
			const name = questionPath(open.name_update);
			if (name !== undefined) properties.set("name", name);
			if (typeof open.external_id === "string" && open.external_id !== "")
				properties.set("external_id", open.external_id);
		}
		if (active.has("update_case"))
			updateMap(
				(actions.update_case as JsonObject).update,
				properties,
				editOnly,
			);
		const closes = active.has("close_case");
		blocks.push({
			kind: "basic-own",
			path: "case",
			caseType,
			opens,
			closes,
			condition,
			closeCondition: closes
				? readCondition((actions.close_case as JsonObject).condition, root)
				: NEVER,
			sessionDatum: ownSessionDatum(module, caseType, opens),
			ownerWritten: writesOwner(properties),
			properties,
			editOnly,
		});
	}

	// Every subcase, active or not, has a block (an inactive one is
	// `relevant="false()"`), at `subcase_<i>`, or at its repeat where it is
	// that repeat's only subcase. Each indexes the form's own case where the
	// form has a case block: a `child` index, whatever `relationship` the
	// subcase stores, which the basic build never reads. The build writes it
	// to a case of the form's own type only while the project space's
	// `DONT_INDEX_SAME_CASETYPE` is off, which the source does not say; it is
	// read here as the build writes it with the flag off.
	if (active.has("subcases") && defaultCaseManagement) {
		const subcases = objectList(actions.subcases) ?? unread();
		const perRepeat = new Map<string, number>();
		for (const subcase of subcases) {
			const context = stringOr(subcase.repeat_context, "");
			perRepeat.set(context, (perRepeat.get(context) ?? 0) + 1);
		}
		subcases.forEach((subcase, index) => {
			const context = stringOr(subcase.repeat_context, "");
			const repeatContext =
				context === "" ? null : relativeDataPath(context, root);
			const nest = repeatContext === null || (perRepeat.get(context) ?? 0) > 1;
			const element = `subcase_${index}`;
			const properties = new Map<string, string>();
			const name = questionPath(subcase.name_update);
			if (name !== undefined) properties.set("name", name);
			const { editOnly } = updateMap(subcase.case_properties, properties);
			const referenceId = subcase.reference_id;
			if (
				referenceId !== undefined &&
				referenceId !== null &&
				typeof referenceId !== "string"
			)
				unread();
			blocks.push({
				kind: "basic-subcase",
				index,
				path:
					repeatContext === null
						? element
						: nest
							? `${repeatContext}/${element}`
							: repeatContext,
				repeatContext,
				caseType: stringOr(subcase.case_type, ""),
				condition: readCondition(subcase.condition, root),
				closeCondition: readCondition(subcase.close_condition, root),
				indices: ownBlock
					? [
							{
								identifier:
									typeof referenceId === "string" && referenceId !== ""
										? referenceId
										: "parent",
								target: { kind: "own" },
								relationship: "child",
							},
						]
					: [],
				ownerWritten: writesOwner(properties),
				properties,
				editOnly,
			});
		});
	}

	if (active.has("usercase_update")) {
		const { properties, editOnly } = updateMap(
			(actions.usercase_update as JsonObject).update,
		);
		if (properties.size > 0)
			blocks.push({
				kind: "basic-usercase",
				path: "commcare_usercase",
				properties,
				editOnly,
			});
	}
	return blocks;
}

/**
 * An advanced action's `case_indices`
 * (`models/form_actions.py::CaseIndex`): each names the tag of the action it
 * indexes, under `reference_id` (`parent` where blank), with its
 * `relationship` (`child` where absent). An index naming no tag, and a
 * relationship outside the schema's three, are none HQ's build can write.
 */
function advancedIndices(value: unknown): PublishedIndex[] {
	const indices = objectList(value) ?? unread();
	return indices.map((index) => {
		const tag = index.tag;
		if (typeof tag !== "string" || tag === "") unread();
		const referenceId = index.reference_id ?? "";
		if (typeof referenceId !== "string") unread();
		const relationship = index.relationship ?? "child";
		if (
			relationship !== "child" &&
			relationship !== "extension" &&
			relationship !== "question"
		)
			unread();
		return {
			identifier: referenceId === "" ? "parent" : referenceId,
			target: { kind: "tag", tag },
			relationship,
		};
	});
}

/**
 * The blocks of an advanced form, by `xform.py::XForm._create_casexml_advanced`
 * and its `get_action_path`: each block at `case_<tag>`
 * (`models/form_actions.py::AdvancedAction.form_element_name`). A load's
 * block writes no index: its `case_index` chooses the case in the entry.
 */
function advancedBlocks(
	form: JsonObject,
	module: JsonObject,
	root: string,
): PublishedCaseBlock[] {
	const actions = form.actions;
	if (!isObject(actions)) unread();
	const loads = objectList(actions.load_update_cases) ?? unread();
	const opens = objectList(actions.open_cases) ?? unread();
	// The last load of the menu's case type takes a block for the visit
	// schedule, which reads the module's phases.
	if (
		module.has_schedule === true &&
		isObject(form.schedule) &&
		form.schedule.enabled === true
	)
		unread("visit-schedule");
	const tagOf = (action: JsonObject): string =>
		typeof action.case_tag === "string" && action.case_tag !== ""
			? action.case_tag
			: unread();
	const blocks: PublishedCaseBlock[] = [];

	// A load writes a block, at the data root, only where it writes a property
	// or closes its case.
	for (const load of loads) {
		const { properties, editOnly } = updateMap(load.case_properties);
		const closeCondition = readCondition(load.close_condition, root);
		if (properties.size === 0 && closeCondition.type === "never") continue;
		const tag = tagOf(load);
		blocks.push({
			kind: "advanced",
			action: "load",
			tag,
			path: `case_${tag}`,
			caseType: stringOr(load.case_type, ""),
			condition: ALWAYS,
			closeCondition,
			indices: [],
			ownerWritten: writesOwner(properties),
			properties,
			editOnly,
		});
	}

	// `AdvancedFormActions.count_subcases_per_repeat_context` counts only the
	// opens that index another case.
	const perRepeat = new Map<string, number>();
	for (const open of opens) {
		const indexed = Array.isArray(open.case_indices)
			? open.case_indices.length > 0
			: false;
		if (!indexed) continue;
		const context = stringOr(open.repeat_context, "");
		perRepeat.set(context, (perRepeat.get(context) ?? 0) + 1);
	}
	for (const open of opens) {
		const tag = tagOf(open);
		const element = `case_${tag}`;
		const context = stringOr(open.repeat_context, "");
		const repeat = context === "" ? null : relativeDataPath(context, root);
		const nest = repeat === null || (perRepeat.get(context) ?? 0) > 1;
		const properties = new Map<string, string>();
		const name = questionPath(open.name_update);
		if (name !== undefined) properties.set("name", name);
		const { editOnly } = updateMap(open.case_properties, properties);
		blocks.push({
			kind: "advanced",
			action: "open",
			tag,
			path: repeat === null ? element : nest ? `${repeat}/${element}` : repeat,
			caseType: stringOr(open.case_type, ""),
			condition: readCondition(open.open_condition, root),
			closeCondition: readCondition(open.close_condition, root),
			indices: advancedIndices(open.case_indices),
			ownerWritten: writesOwner(properties),
			properties,
			editOnly,
		});
	}
	return blocks;
}

// ── The form's XForm ──────────────────────────────────────────────────

/** The data root of the XForm's primary instance: `h:html/h:head/model`'s
 *  first `instance` without an `id`, its one element child. */
function dataRoot(xml: string): { element: Element; scope: NamespaceScope } {
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) unread("xform-unparsed");
	const [html] = elementChildren(parsed.doc.children, new Map());
	if (
		html === undefined ||
		!isElement(html.element, html.scope, XHTML_NS, "html")
	)
		unread("xform-unparsed");
	const head = elementChildren(html.element.children, html.scope).find(
		({ element, scope }) => isElement(element, scope, XHTML_NS, "head"),
	);
	const model =
		head &&
		elementChildren(head.element.children, head.scope).find(
			({ element, scope }) => isElement(element, scope, XFORMS_NS, "model"),
		);
	const instance =
		model &&
		elementChildren(model.element.children, model.scope).find(
			({ element, scope }) =>
				isElement(element, scope, XFORMS_NS, "instance") &&
				element.attribs.id === undefined,
		);
	const roots =
		instance && elementChildren(instance.element.children, instance.scope);
	if (roots === undefined || roots.length !== 1) unread("xform-unparsed");
	return roots[0];
}

/** The element children of `element` whose local name is `local`. */
function childrenNamed(
	element: Element,
	scope: NamespaceScope,
	local: string,
): { element: Element; scope: NamespaceScope }[] {
	return elementChildren(element.children, scope).filter(
		(child) => splitName(child.element.name).local === local,
	);
}

/**
 * A Save to Case block's `case` element, read as the case transaction it
 * writes: which of `create`, `update` and `close` it holds, each child of its
 * `index` (by name, with its `relationship` attribute, `null` where it has
 * none), and the leaves of its `create` and `update`.
 */
function saveToCaseContent(
	block: Element,
	scope: NamespaceScope,
): Pick<
	Extract<PublishedCaseBlock, { kind: "save-to-case" }>,
	"actions" | "indices" | "properties"
> {
	const [caseElement] = childrenNamed(block, scope, "case");
	if (caseElement === undefined)
		return { actions: [], indices: [], properties: [] };
	const holds = (local: string) =>
		childrenNamed(caseElement.element, caseElement.scope, local);
	const actions = (["create", "update", "close"] as const).filter(
		(action) => holds(action).length > 0,
	);
	const indices = holds("index").flatMap(({ element, scope: indexScope }) =>
		elementChildren(element.children, indexScope).map((index) => ({
			identifier: splitName(index.element.name).local,
			relationship: index.element.attribs.relationship ?? null,
		})),
	);
	const properties = (["create", "update"] as const)
		.flatMap((action) =>
			holds(action).flatMap(({ element, scope: actionScope }) =>
				elementChildren(element.children, actionScope).map(
					(leaf) => `${action}/${splitName(leaf.element.name).local}`,
				),
			),
		)
		.sort();
	return { actions, indices, properties };
}

/**
 * The data root's name, and the Save to Case blocks and model-iteration rows
 * of the XForm, in document order. A Save to Case block is an element whose
 * Vellum `role` is `SaveToCase`, its case type the literal `vellum:case_type`
 * holds (empty where the block takes its type from an expression). A
 * model-iteration repeat is an element whose Vellum `role` is `Repeat`,
 * holding the `ids`, `count` and `current_index` attributes and an `item` row.
 */
function sourceBlocks(xml: string): {
	root: string;
	blocks: PublishedCaseBlock[];
	rows: string[];
} {
	const root = dataRoot(xml);
	const blocks: PublishedCaseBlock[] = [];
	const rows: string[] = [];
	const walk = (
		element: Element,
		scope: NamespaceScope,
		path: readonly string[],
	) => {
		for (const child of elementChildren(element.children, scope)) {
			const childPath = [...path, child.element.name];
			const role = namespacedAttribute(
				child.element,
				child.scope,
				VELLUM_NS,
				"role",
			);
			if (role === "SaveToCase") {
				const caseType = namespacedAttribute(
					child.element,
					child.scope,
					VELLUM_NS,
					"case_type",
				);
				blocks.push({
					kind: "save-to-case",
					path: childPath.join("/"),
					caseType: caseType === undefined || caseType === "" ? null : caseType,
					...saveToCaseContent(child.element, child.scope),
				});
			} else if (
				role === "Repeat" &&
				["ids", "count", "current_index"].every(
					(name) => child.element.attribs[name] !== undefined,
				)
			) {
				const item = elementChildren(child.element.children, child.scope).find(
					({ element }) => element.name === "item",
				);
				if (item !== undefined) rows.push([...childPath, "item"].join("/"));
			}
			walk(child.element, child.scope, childPath);
		}
	};
	walk(root.element, root.scope, []);
	return { root: splitName(root.element.name).local, blocks, rows };
}

// ── The reader ────────────────────────────────────────────────────────

/** The form's `xmlns` where it stores one. */
function storedXmlns(form: unknown): string | null {
	return isObject(form) && typeof form.xmlns === "string" && form.xmlns !== ""
		? form.xmlns
		: null;
}

/**
 * Every case block HQ's build of each form writes, keyed by the form's
 * `xmlns`, and every form left out, with why.
 */
export function publishedCaseBlocks(
	normalizedSource: unknown,
): PublishedCaseBlocks {
	const forms = new Map<string, PublishedForm>();
	const unreadForms: UnreadPublishedForm[] = [];
	if (
		!isObject(normalizedSource) ||
		normalizedSource.doc_type !== "Application" ||
		!Array.isArray(normalizedSource.modules) ||
		!isObject(normalizedSource._attachments)
	)
		return { forms, unread: unreadForms };
	const attachments = normalizedSource._attachments;
	const modules = normalizedSource.modules;
	// Two forms with one `xmlns` cannot be told apart by it.
	const holders = new Map<string, number>();
	for (const module of modules) {
		if (!isObject(module) || !Array.isArray(module.forms)) continue;
		for (const form of module.forms) {
			const xmlns = storedXmlns(form);
			if (xmlns !== null) holders.set(xmlns, (holders.get(xmlns) ?? 0) + 1);
		}
	}
	modules.forEach((module, menu) => {
		if (!isObject(module) || !Array.isArray(module.forms)) return;
		module.forms.forEach((form: unknown, position: number) => {
			const xmlns = storedXmlns(form);
			const read = readForm(form, xmlns, holders, module, attachments);
			if ("reason" in read)
				unreadForms.push({ menu, form: position, xmlns, reason: read.reason });
			else if (xmlns !== null) forms.set(xmlns, { xmlns, ...read });
		});
	});
	return { forms, unread: unreadForms };
}

function readForm(
	form: unknown,
	xmlns: string | null,
	holders: ReadonlyMap<string, number>,
	module: JsonObject,
	attachments: JsonObject,
): Omit<PublishedForm, "xmlns"> | { readonly reason: UnreadFormReason } {
	// A shadow form's actions are its parent's, merged at build.
	if (isObject(form) && form.doc_type === "ShadowForm")
		return { reason: "shadow-form" };
	const builds = !isObject(form)
		? undefined
		: form.doc_type === "Form"
			? basicBlocks
			: form.doc_type === "AdvancedForm"
				? advancedBlocks
				: undefined;
	if (builds === undefined || !isObject(form))
		return { reason: "unknown-form-kind" };
	if (xmlns === null) return { reason: "no-xmlns" };
	if ((holders.get(xmlns) ?? 0) > 1) return { reason: "shared-xmlns" };
	const xml =
		typeof form.unique_id === "string"
			? attachments[`${form.unique_id}.xml`]
			: undefined;
	if (typeof xml !== "string") return { reason: "no-xform" };
	try {
		const source = sourceBlocks(xml);
		return {
			blocks: [...builds(form, module, source.root), ...source.blocks],
			modelIterationRows: source.rows,
		};
	} catch (error) {
		if (error instanceof Unread) return { reason: error.reason };
		throw error;
	}
}

/**
 * Whether some block of the source saves a property only where its answer
 * changed (`update_mode: edit`), which the build applies only where the
 * project space saves only changed answers: the one case a bring-in reads
 * that setting for.
 */
export function sourceHoldsEditMode(blocks: PublishedCaseBlocks): boolean {
	for (const form of blocks.forms.values())
		for (const block of form.blocks)
			if (block.kind !== "save-to-case" && block.editOnly.size > 0) return true;
	return false;
}
