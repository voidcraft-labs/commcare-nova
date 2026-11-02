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
 * an application gives no form; a form with no `xmlns`, an `xmlns` two forms
 * share, a form whose XForm is missing or does not parse, and a form whose
 * blocks depend on what the source does not say (a data registry's case, a
 * visit schedule) are left out, never guessed. The reader returns only what it
 * read; the caller counts what it left out.
 *
 * Every path is a data path relative to the instance root, its element names
 * joined by `/`. The own block's path is its `case` element at the data root;
 * every other block's path is the element its `case` stands in. Each
 * `properties` map holds HQ's own key for each property a block writes
 * (`name` for the case's name, as HQ's update maps hold it) and the question
 * path HQ reads it from (`ConditionalCaseUpdate.question_path`), as HQ stores
 * it.
 */

import { type ChildNode, type Element, isTag } from "domhandler";
import { tryParseXml } from "../xmlParse";

export type PublishedCaseBlock =
	| {
			readonly kind: "basic-own";
			readonly path: "case";
			readonly caseType: string;
			readonly opens: boolean;
			readonly closes: boolean;
			readonly properties: ReadonlyMap<string, string>;
	  }
	| {
			readonly kind: "basic-usercase";
			readonly path: "commcare_usercase";
			readonly properties: ReadonlyMap<string, string>;
	  }
	| {
			readonly kind: "basic-subcase";
			readonly index: number;
			readonly path: string;
			readonly repeatContext: string | null;
			readonly caseType: string;
			readonly relationship: "child" | "extension";
			readonly properties: ReadonlyMap<string, string>;
	  }
	| {
			readonly kind: "advanced";
			readonly action: "load" | "open";
			readonly tag: string;
			readonly path: string;
			readonly caseType: string;
			readonly properties: ReadonlyMap<string, string>;
	  }
	| {
			readonly kind: "save-to-case";
			readonly path: string;
			readonly caseType: string | null;
	  };

export interface PublishedForm {
	readonly xmlns: string;
	readonly blocks: readonly PublishedCaseBlock[];
	/** The data path of each model-iteration repeat's row (`…/item`), as Vellum writes the shape. */
	readonly modelIterationRows: readonly string[];
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

/** A form HQ's source holds that this reader cannot read: it is left out. */
class Unread extends Error {}

function unread(): never {
	throw new Unread();
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

/**
 * A `SchemaDictProperty(ConditionalCaseUpdate)` as property → question path,
 * in HQ's key order. An entry with no question path is not a write HQ's
 * build can bind, and makes the form unread.
 */
function updateMap(value: unknown, into = new Map<string, string>()) {
	if (value === undefined || value === null) return into;
	if (!isObject(value)) unread();
	for (const [key, update] of Object.entries(value)) {
		const path = questionPath(update);
		if (path === undefined) unread();
		into.set(key, path);
	}
	return into;
}

/**
 * A repeat context, HQ's absolute path of the repeat (`/data/children`), as a
 * data path from the instance root (`children`).
 */
function relativeDataPath(absolute: string): string {
	const [empty, root, ...rest] = absolute.split("/");
	if (empty !== "" || root === undefined || root === "" || rest.length === 0)
		unread();
	if (rest.some((segment) => segment === "")) unread();
	return rest.join("/");
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
function activeActionTypes(requires: unknown): readonly string[] {
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
function activeActions(
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
 * The blocks of a basic form, by `xform.py::XForm._create_casexml` and
 * `XForm._add_usercase`.
 */
function basicBlocks(
	form: JsonObject,
	module: JsonObject,
): PublishedCaseBlock[] {
	const actions = form.actions;
	if (!isObject(actions)) unread();
	const requires = form.requires ?? "none";
	const active = activeActions(actions, requires);
	const opens = active.has("open_case");
	// HQ's build reads whether the project space may use data registries,
	// which the source does not say.
	if (!isMultiSelect(module) && !opens && mayLoadRegistryCase(module)) unread();
	// `default_case_management`: off in a menu that selects several cases,
	// unless the form opens a case.
	const defaultCaseManagement = !isMultiSelect(module) || opens;
	const caseType = stringOr(module.case_type, "");
	const blocks: PublishedCaseBlock[] = [];

	// The own block exists where some action is active and the form requires
	// a case or opens one, and is written where it holds anything: under
	// default case management it binds the case id or creates the case, and
	// otherwise it holds nothing.
	if (
		active.size > 0 &&
		!(requires === "none" && !opens) &&
		defaultCaseManagement
	) {
		const properties = new Map<string, string>();
		if (opens) {
			const open = actions.open_case as JsonObject;
			const name = questionPath(open.name_update);
			if (name !== undefined) properties.set("name", name);
			if (typeof open.external_id === "string" && open.external_id !== "")
				properties.set("external_id", open.external_id);
		}
		if (active.has("update_case"))
			updateMap((actions.update_case as JsonObject).update, properties);
		blocks.push({
			kind: "basic-own",
			path: "case",
			caseType,
			opens,
			closes: active.has("close_case"),
			properties,
		});
	}

	// Every subcase, active or not, has a block (an inactive one is
	// `relevant="false()"`), at `subcase_<i>`, or at its repeat where it is
	// that repeat's only subcase.
	if (active.has("subcases") && defaultCaseManagement) {
		const subcases = objectList(actions.subcases) ?? unread();
		const perRepeat = new Map<string, number>();
		for (const subcase of subcases) {
			const context = stringOr(subcase.repeat_context, "");
			perRepeat.set(context, (perRepeat.get(context) ?? 0) + 1);
		}
		subcases.forEach((subcase, index) => {
			const context = stringOr(subcase.repeat_context, "");
			const repeatContext = context === "" ? null : relativeDataPath(context);
			const nest = repeatContext === null || (perRepeat.get(context) ?? 0) > 1;
			const element = `subcase_${index}`;
			const properties = new Map<string, string>();
			const name = questionPath(subcase.name_update);
			if (name !== undefined) properties.set("name", name);
			updateMap(subcase.case_properties, properties);
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
				relationship:
					subcase.relationship === "extension" ? "extension" : "child",
				properties,
			});
		});
	}

	if (active.has("usercase_update")) {
		const properties = updateMap(
			(actions.usercase_update as JsonObject).update,
		);
		if (properties.size > 0)
			blocks.push({
				kind: "basic-usercase",
				path: "commcare_usercase",
				properties,
			});
	}
	return blocks;
}

/**
 * The blocks of an advanced form, by `xform.py::XForm._create_casexml_advanced`
 * and its `get_action_path`: each block at `case_<tag>`
 * (`models/form_actions.py::AdvancedAction.form_element_name`).
 */
function advancedBlocks(
	form: JsonObject,
	module: JsonObject,
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
		unread();
	const tagOf = (action: JsonObject): string =>
		typeof action.case_tag === "string" && action.case_tag !== ""
			? action.case_tag
			: unread();
	const blocks: PublishedCaseBlock[] = [];

	// A load writes a block, at the data root, only where it writes a property
	// or closes its case.
	for (const load of loads) {
		const properties = updateMap(load.case_properties);
		const closes =
			isObject(load.close_condition) &&
			load.close_condition.type !== undefined &&
			load.close_condition.type !== "never";
		if (properties.size === 0 && !closes) continue;
		const tag = tagOf(load);
		blocks.push({
			kind: "advanced",
			action: "load",
			tag,
			path: `case_${tag}`,
			caseType: stringOr(load.case_type, ""),
			properties,
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
		const repeat = context === "" ? null : relativeDataPath(context);
		const nest = repeat === null || (perRepeat.get(context) ?? 0) > 1;
		const properties = new Map<string, string>();
		const name = questionPath(open.name_update);
		if (name !== undefined) properties.set("name", name);
		updateMap(open.case_properties, properties);
		blocks.push({
			kind: "advanced",
			action: "open",
			tag,
			path: repeat === null ? element : nest ? `${repeat}/${element}` : repeat,
			caseType: stringOr(open.case_type, ""),
			properties,
		});
	}
	return blocks;
}

// ── The form's XForm ──────────────────────────────────────────────────

const XFORMS = "http://www.w3.org/2002/xforms";
const XHTML = "http://www.w3.org/1999/xhtml";
const VELLUM = "http://commcarehq.org/xforms/vellum";

type Scope = ReadonlyMap<string, string>;

/** `element`'s namespace scope: its declarations over its parent's. The
 *  empty prefix is the default namespace. */
function scopeOf(element: Element, parent: Scope): Scope {
	let scope: Map<string, string> | undefined;
	for (const [name, value] of Object.entries(element.attribs)) {
		const prefix =
			name === "xmlns"
				? ""
				: name.startsWith("xmlns:")
					? name.slice("xmlns:".length)
					: undefined;
		if (prefix === undefined) continue;
		scope ??= new Map(parent);
		scope.set(prefix, value);
	}
	return scope ?? parent;
}

function splitName(name: string): { prefix: string; local: string } {
	const colon = name.indexOf(":");
	return colon < 0
		? { prefix: "", local: name }
		: { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/** Whether `element`, in `scope`, is `local` in namespace `uri`. */
function isElement(
	element: Element,
	scope: Scope,
	uri: string,
	local: string,
): boolean {
	const name = splitName(element.name);
	return name.local === local && scope.get(name.prefix) === uri;
}

/** The value of the attribute `local` in namespace `uri`; an attribute with
 *  no prefix is in no namespace. */
function namespacedAttribute(
	element: Element,
	scope: Scope,
	uri: string,
	local: string,
): string | undefined {
	for (const [name, value] of Object.entries(element.attribs)) {
		const split = splitName(name);
		if (
			split.prefix !== "" &&
			split.prefix !== "xmlns" &&
			split.local === local &&
			scope.get(split.prefix) === uri
		)
			return value;
	}
	return undefined;
}

function elementChildren(
	nodes: readonly ChildNode[],
	scope: Scope,
): { element: Element; scope: Scope }[] {
	return nodes.filter(isTag).map((element) => ({
		element,
		scope: scopeOf(element, scope),
	}));
}

/** The data root of the XForm's primary instance: `h:html/h:head/model`'s
 *  first `instance` without an `id`, its one element child. */
function dataRoot(xml: string): { element: Element; scope: Scope } {
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) unread();
	const [html] = elementChildren(parsed.doc.children, new Map());
	if (html === undefined || !isElement(html.element, html.scope, XHTML, "html"))
		unread();
	const head = elementChildren(html.element.children, html.scope).find(
		({ element, scope }) => isElement(element, scope, XHTML, "head"),
	);
	const model =
		head &&
		elementChildren(head.element.children, head.scope).find(
			({ element, scope }) => isElement(element, scope, XFORMS, "model"),
		);
	const instance =
		model &&
		elementChildren(model.element.children, model.scope).find(
			({ element, scope }) =>
				isElement(element, scope, XFORMS, "instance") &&
				element.attribs.id === undefined,
		);
	const roots =
		instance && elementChildren(instance.element.children, instance.scope);
	if (roots === undefined || roots.length !== 1) unread();
	return roots[0];
}

/**
 * The Save to Case blocks and model-iteration rows of the XForm, in document
 * order. A Save to Case block is an element whose Vellum `role` is
 * `SaveToCase`, its case type the literal `vellum:case_type` holds (empty
 * where the block takes its type from an expression). A model-iteration
 * repeat is an element whose Vellum `role` is `Repeat`, holding the `ids`,
 * `count` and `current_index` attributes and an `item` row.
 */
function sourceBlocks(xml: string): {
	blocks: PublishedCaseBlock[];
	rows: string[];
} {
	const root = dataRoot(xml);
	const blocks: PublishedCaseBlock[] = [];
	const rows: string[] = [];
	const walk = (element: Element, scope: Scope, path: readonly string[]) => {
		for (const child of elementChildren(element.children, scope)) {
			const childPath = [...path, child.element.name];
			const role = namespacedAttribute(
				child.element,
				child.scope,
				VELLUM,
				"role",
			);
			if (role === "SaveToCase") {
				const caseType = namespacedAttribute(
					child.element,
					child.scope,
					VELLUM,
					"case_type",
				);
				blocks.push({
					kind: "save-to-case",
					path: childPath.join("/"),
					caseType: caseType === undefined || caseType === "" ? null : caseType,
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
	return { blocks, rows };
}

// ── The reader ────────────────────────────────────────────────────────

/** Every case block HQ's build of each form writes, keyed by the form's `xmlns`. */
export function publishedCaseBlocks(
	normalizedSource: unknown,
): ReadonlyMap<string, PublishedForm> {
	const forms = new Map<string, PublishedForm>();
	if (
		!isObject(normalizedSource) ||
		normalizedSource.doc_type !== "Application" ||
		!Array.isArray(normalizedSource.modules) ||
		!isObject(normalizedSource._attachments)
	)
		return forms;
	const attachments = normalizedSource._attachments;
	const shared = new Set<string>();
	for (const module of normalizedSource.modules) {
		if (!isObject(module) || !Array.isArray(module.forms)) continue;
		for (const form of module.forms) {
			if (!isObject(form)) continue;
			const xmlns = form.xmlns;
			if (typeof xmlns !== "string" || xmlns === "") continue;
			if (forms.has(xmlns) || shared.has(xmlns)) {
				// Two forms with one `xmlns` cannot be told apart by it.
				forms.delete(xmlns);
				shared.add(xmlns);
				continue;
			}
			const read = readForm(form, module, attachments);
			if (read !== undefined) forms.set(xmlns, { xmlns, ...read });
		}
	}
	return forms;
}

function readForm(
	form: JsonObject,
	module: JsonObject,
	attachments: JsonObject,
): Omit<PublishedForm, "xmlns"> | undefined {
	try {
		const builds =
			form.doc_type === "Form"
				? basicBlocks
				: form.doc_type === "AdvancedForm"
					? advancedBlocks
					: undefined;
		// A shadow form's actions are its parent's, merged at build.
		if (builds === undefined) return undefined;
		const xml =
			typeof form.unique_id === "string"
				? attachments[`${form.unique_id}.xml`]
				: undefined;
		if (typeof xml !== "string") return undefined;
		const source = sourceBlocks(xml);
		return {
			blocks: [...builds(form, module), ...source.blocks],
			modelIterationRows: source.rows,
		};
	} catch (error) {
		if (error instanceof Unread) return undefined;
		throw error;
	}
}
