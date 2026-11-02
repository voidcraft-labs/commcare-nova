/**
 * The case blocks of an advanced form, for the local archive.
 *
 * `addAdvancedCaseBlocks` is the `.ccz`'s mirror of CommCare HQ's
 * `xform.py::XForm._create_casexml_advanced`, the build step that writes an
 * `AdvancedForm`'s case transactions into the form HQ serves. The source a
 * publish uploads holds none of it; HQ's build writes it, and the local
 * archive, which has no such build, writes the same blocks here, before
 * `metaBlock.ts::addMetaBlock` (`XForm.add_case_and_meta_advanced`).
 *
 * In HQ's order, over the form's `AdvancedFormActions`:
 *
 * 1. Each load, in `load_update_cases` order, that writes a property or
 *    closes its case: a `case_<tag>` element appended to the data root,
 *    holding one `<case>` whose id is the load's session value
 *    (`instance('commcaresession')/session/data/<datum>`, the datum after
 *    HQ's child-module alignment), an `<update>` row per property in
 *    code-point order (`XFormCaseBlock.add_case_updates`, `name` written
 *    `case_name`), a block under `case_<tag>/parents/<index>/…` per case a
 *    `<index>/<property>` key reaches (`XForm._add_case_updates`), and a
 *    `<close/>` under its condition (`XForm.action_relevance`).
 * 2. Each open action, in `open_cases` order, at HQ's path
 *    (`get_action_path`): `case_<tag>/` under the data root; inside a
 *    repeat, `<repeat>/case_<tag>/` where the repeat holds two or more open
 *    actions that index a case, and the repeat row itself otherwise. Its
 *    `<case>` is the first child of that node (`subcase_node.insert(0, …)`).
 *    Its id is set at form load from its own session value outside a repeat
 *    and bound to `uuid()` inside one; `<create>` holds `case_name` (bound to
 *    the name path, which also gains `required="true()"`), `owner_id` (bound
 *    to the worker, or the text `-` where HQ does not set the owner,
 *    `xform.py::autoset_owner_id_for_advanced_action`) and `case_type` as
 *    text; then its `<update>`, its `<index>` (one child per index, named by
 *    its `reference_id`, with `case_type` and, for an extension,
 *    `relationship="extension"`, `XFormCaseBlock.add_index_ref`) and its
 *    `<close/>`. An index to a load reads the load's own session value
 *    before alignment, as HQ's build does; an index to an earlier open action
 *    reads that action's `case/@case_id`.
 *
 * Every `<bind>` and `<setvalue>` is constructed as a typed wire tree, and
 * the instances their printed trees read are declared once in the model
 * through one `InstanceSink`.
 */

import { type ChildNode, Element } from "domhandler";
import { findOne, getChildren } from "domutils";
import {
	el,
	text,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import {
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";
import type {
	AdvancedFormActions,
	AdvancedOpenCaseAction,
	ConditionalCaseUpdate,
	FormActionCondition,
	LoadUpdateAction,
} from "@/lib/commcare/types";
import {
	appendChildren,
	ensureInstance,
	findDataElement,
	findModelElement,
	insertBeforeItext,
	parseXForm,
	prependChildren,
	serializeXForm,
} from "@/lib/commcare/xform/domSplice";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { w } from "../xpath/wire/builders";
import { InstanceSink, sessionInstance } from "../xpath/wire/instances";
import { caseById } from "../xpath/wire/rowScope";
import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";

/** CommCare's case-transaction namespace, which every `<case>` is in. */
const CASE_TRANSACTION_XMLNS = "http://commcarehq.org/case/transaction/v2";

/** The owner HQ writes on an open action whose owner it does not set
 *  (`const.py::UNOWNED_EXTENSION_OWNER_ID`). */
const UNOWNED_OWNER_ID = "-";

/** What the injection reads of the form's case wire plan. */
export interface AdvancedCaseBlocksPlan {
	readonly actions: AdvancedFormActions;
}

export interface AdvancedCaseBlocksContext {
	/**
	 * The session datum each load's case id is read from, by the load's tag,
	 * after HQ's child-module alignment (`EntriesHelper.
	 * get_datum_meta_assertions_advanced`, read by `_create_casexml_advanced`
	 * as `adjusted_datums`). A load absent from the map reads its own
	 * datum, `case_id_<tag>` (`LoadUpdateAction.case_session_var`).
	 */
	readonly loadDatumIds?: ReadonlyMap<string, string>;
}

/** A load's own session datum, before alignment. */
function loadSessionVar(tag: string): string {
	return `case_id_${tag}`;
}

/** An open action's session datum: its type and its place in `open_cases`
 *  (`AdvancedOpenCaseAction.case_session_var`). */
function openSessionVar(action: AdvancedOpenCaseAction, index: number): string {
	return `case_id_new_${validateCaseType(action.case_type)}_${index}`;
}

function sessionRead(datumId: string): WireExpr {
	return w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step(datumId),
	]);
}

/** `case_<tag>`, the element an action's block stands in
 *  (`AdvancedAction.form_element_name`). */
function formElementName(tag: string): string {
	return `case_${tag}`;
}

const META_TIME_END = FormPath.root().child("meta").child("timeEnd");
const META_USER_ID = FormPath.root().child("meta").child("userID");

/** The relevance HQ's build writes for an action's condition
 *  (`xform.py::XForm.action_relevance`): `true()` for `always`, the
 *  question's comparison for `if`, `false()` otherwise. */
function actionRelevance(condition: FormActionCondition): WireExpr {
	if (condition.type === "always") return w.call("true");
	if (condition.type !== "if") return w.call("false");
	const question = FormPath.parse(
		validateXFormPath(condition.question ?? ""),
	).toWire();
	if (condition.operator === "boolean_true") return question;
	const answer = w.str(condition.answer ?? "");
	return condition.operator === "selected"
		? w.call("selected", [question, answer])
		: w.eq(question, answer);
}

/** Everything the injection adds besides the data elements it splices as
 *  it goes. */
interface Emission {
	readonly binds: Element[];
	readonly setvalues: Element[];
	readonly requiredNamePaths: string[];
	readonly context: WireElementContext;
}

function bind(
	emission: Emission,
	nodeset: FormPath,
	xpath: { calculate?: WireExpr; relevant?: WireExpr },
	attributes: Record<string, string> = {},
): void {
	emission.binds.push(
		xel(
			"bind",
			{ attributes, xpath: { nodeset: nodeset.toWire(), ...xpath } },
			emission.context,
		),
	);
}

/** An empty `<case>` and the two binds every case block carries
 *  (`XFormCaseBlock.elem`). */
function caseElement(emission: Emission, casePath: FormPath): Element {
	bind(
		emission,
		casePath.attr("date_modified"),
		{ calculate: META_TIME_END.toWire() },
		{ type: "xsd:dateTime" },
	);
	bind(emission, casePath.attr("user_id"), {
		calculate: META_USER_ID.toWire(),
	});
	return el(
		"case",
		{
			case_id: "",
			date_modified: "",
			user_id: "",
			xmlns: CASE_TRANSACTION_XMLNS,
		},
		[],
	);
}

function append(parent: Element, child: Element): void {
	appendChildren(parent, [child]);
}

/**
 * A block's `<update>` and its rows' binds, as
 * `XFormCaseBlock.add_case_updates` writes them: rows in code-point order of
 * their wire names, each calculated from its question and present only while
 * the question is (`count(<path>) > 0`), and, for a row saved only when its
 * answer changed, while the answer differs from the case's value.
 */
function addUpdates(
	emission: Emission,
	caseEl: Element,
	casePath: FormPath,
	updates: readonly (readonly [string, ConditionalCaseUpdate])[],
): void {
	if (updates.length === 0) return;
	const rows = updates
		.map(([key, update]) => ({
			property: validatePropertyName(key === "name" ? "case_name" : key),
			source: FormPath.parse(validateXFormPath(update.question_path)),
			edit: update.update_mode === "edit",
		}))
		.sort((a, b) =>
			a.property < b.property ? -1 : a.property > b.property ? 1 : 0,
		);
	const updatePath = casePath.child("update");
	for (const row of rows) {
		const source = row.source.toWire();
		const present = w.gt(w.call("count", [source]), w.num(0));
		bind(emission, updatePath.child(row.property), {
			calculate: source,
			relevant: row.edit
				? w.and(
						present,
						w.ne(
							w.append(caseById(casePath.attr("case_id").toWire(), "casedb"), [
								w.step(row.property),
							]),
							source,
						),
					)
				: present,
		});
	}
	append(
		caseEl,
		el(
			"update",
			{},
			rows.map((row) => el(row.property, {})),
		),
	);
}

function addClose(
	emission: Emission,
	caseEl: Element,
	casePath: FormPath,
	condition: FormActionCondition,
): void {
	if (condition.type === "never") return;
	append(caseEl, el("close", {}));
	bind(emission, casePath.child("close"), {
		relevant: actionRelevance(condition),
	});
}

/** A load's block (`_create_casexml_advanced`'s load loop). */
function addLoadBlock(
	emission: Emission,
	data: Element,
	load: LoadUpdateAction,
	datumId: string,
): void {
	const properties = Object.entries(load.case_properties);
	if (properties.length === 0 && load.close_condition.type === "never") return;
	const name = formElementName(load.case_tag);
	const basePath = FormPath.root().child(name);
	const casePath = basePath.child("case");
	const caseId = sessionRead(datumId);
	const baseEl = el(name, {}, []);
	append(data, baseEl);
	const caseEl = caseElement(emission, casePath);
	bind(emission, casePath.attr("case_id"), { calculate: caseId });
	append(baseEl, caseEl);

	// `XForm._add_case_updates`: a key with no `/` writes the load's own
	// case; `<index>/<property>` writes the case that index reaches, from a
	// block of its own under `case_<tag>/parents`.
	const own: [string, ConditionalCaseUpdate][] = [];
	const byAncestor = new Map<string, [string, ConditionalCaseUpdate][]>();
	for (const [key, update] of properties) {
		const steps = key.split("/");
		const property = steps.pop() ?? key;
		const ancestor = steps.join("/");
		if (ancestor === "") own.push([property, update]);
		else
			byAncestor.set(ancestor, [
				...(byAncestor.get(ancestor) ?? []),
				[property, update],
			]);
	}
	addUpdates(emission, caseEl, casePath, own);
	if (byAncestor.size > 0) {
		const parentsEl = el("parents", {}, []);
		append(baseEl, parentsEl);
		const parentsPath = basePath.child("parents");
		for (const [ancestor, updates] of [...byAncestor].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			// HQ builds each chain afresh, so two keys that share a first index
			// stand in two elements of that name.
			let node = parentsEl;
			let nodePath = parentsPath;
			let id: WireExpr = caseId;
			for (const step of ancestor.split("/")) {
				const index = validatePropertyName(step);
				const child = el(index, {}, []);
				append(node, child);
				node = child;
				nodePath = nodePath.child(index);
				id = w.append(caseById(id, "casedb"), [w.step("index"), w.step(index)]);
			}
			const parentCasePath = nodePath.child("case");
			const parentCase = caseElement(emission, parentCasePath);
			bind(emission, parentCasePath.attr("case_id"), { calculate: id });
			addUpdates(emission, parentCase, parentCasePath, updates);
			append(node, parentCase);
		}
	}
	addClose(emission, caseEl, casePath, load.close_condition);
}

/** Where an open action's block stands (`_create_casexml_advanced`'s
 *  `get_action_path`): the node its `<case>` is the first child of, and
 *  the element HQ appends for that node under `parent`, where it makes one. */
function actionPath(
	action: AdvancedOpenCaseAction,
	indexedPerRepeat: ReadonlyMap<string, number>,
): {
	readonly path: FormPath;
	readonly parent: FormPath;
	readonly ownNode?: string;
} {
	const ownNode = formElementName(action.case_tag);
	if (action.repeat_context === "")
		return {
			path: FormPath.root().child(ownNode),
			parent: FormPath.root(),
			ownNode,
		};
	const repeat = FormPath.parse(validateXFormPath(action.repeat_context));
	return (indexedPerRepeat.get(action.repeat_context) ?? 0) > 1
		? { path: repeat.child(ownNode), parent: repeat, ownNode }
		: { path: repeat, parent: repeat };
}

/** The element at `path`, the first of each name at every step, as HQ's
 *  build finds a repeat (`instance_node.find`). */
function resolveElement(data: Element, path: FormPath): Element {
	let cursor = data;
	for (const segment of path.segments().slice(1)) {
		const next =
			segment.kind === "element"
				? findOne((e) => e.name === segment.name, cursor.children, false)
				: null;
		if (next === null)
			throw new Error(
				`Nova could not place an advanced form's case block: the form has no element at ${path.toXPath()}. An open action's repeat is a repeat of the form, so the plan of the form's case changes and its fields disagree.`,
			);
		cursor = next;
	}
	return cursor;
}

/** An open action's block (`_create_casexml_advanced`'s open loop). */
function addOpenBlock(
	emission: Emission,
	data: Element,
	actions: AdvancedFormActions,
	index: number,
	indexedPerRepeat: ReadonlyMap<string, number>,
): void {
	const action = actions.open_cases[index];
	if (action === undefined) return;
	const caseType = validateCaseType(action.case_type);
	const { path, parent, ownNode } = actionPath(action, indexedPerRepeat);
	let node: Element;
	if (ownNode !== undefined) {
		node = el(ownNode, {}, []);
		append(resolveElement(data, parent), node);
	} else node = resolveElement(data, path);
	const casePath = path.child("case");
	const caseEl = caseElement(emission, casePath);
	prependChildren(node, [caseEl]);

	// `XFormCaseBlock.add_create_block`.
	const createPath = casePath.child("create");
	const ownerSet = autosetsOwner(action);
	append(
		caseEl,
		el("create", {}, [
			el("case_name", {}),
			el("owner_id", {}, ownerSet ? [] : [text(UNOWNED_OWNER_ID)]),
			el("case_type", {}, [text(caseType)]),
		]),
	);
	bind(emission, casePath, {
		relevant: actionRelevance(action.open_condition),
	});
	if (action.repeat_context === "")
		emission.setvalues.push(
			xel(
				"setvalue",
				{
					attributes: { event: "xforms-ready" },
					xpath: {
						ref: casePath.attr("case_id").toWire(),
						value: sessionRead(openSessionVar(action, index)),
					},
				},
				emission.context,
			),
		);
	else bind(emission, casePath.attr("case_id"), { calculate: w.call("uuid") });
	const namePath = validateXFormPath(action.name_update.question_path);
	bind(emission, createPath.child("case_name"), {
		calculate: FormPath.parse(namePath).toWire(),
	});
	if (ownerSet)
		bind(emission, createPath.child("owner_id"), {
			calculate: META_USER_ID.toWire(),
		});
	emission.requiredNamePaths.push(namePath);

	addUpdates(
		emission,
		caseEl,
		casePath,
		Object.entries(action.case_properties),
	);

	// `XFormCaseBlock.add_index_ref`, once per index.
	if (action.case_indices.length > 0) {
		const indexEl = el("index", {}, []);
		append(caseEl, indexEl);
		for (const caseIndex of action.case_indices) {
			const referenceId = validatePropertyName(
				caseIndex.reference_id || "parent",
			);
			const target = actionByTag(actions, caseIndex.tag);
			append(
				indexEl,
				el(referenceId, {
					case_type: validateCaseType(target.action.case_type),
					...(caseIndex.relationship === "extension" && {
						relationship: "extension",
					}),
				}),
			);
			bind(emission, casePath.child("index").child(referenceId), {
				calculate:
					target.kind === "load"
						? sessionRead(loadSessionVar(target.action.case_tag))
						: actionPath(target.action, indexedPerRepeat)
								.path.child("case")
								.attr("case_id")
								.toWire(),
			});
		}
	}
	addClose(emission, caseEl, casePath, action.close_condition);
}

/** `autoset_owner_id_for_advanced_action`: HQ sets the owner unless the
 *  action writes `owner_id` or every index it carries is an extension. */
function autosetsOwner(action: AdvancedOpenCaseAction): boolean {
	if (Object.hasOwn(action.case_properties, "owner_id")) return false;
	if (action.case_indices.length === 0) return true;
	return action.case_indices.some((index) => index.relationship === "child");
}

/** The action a tag names (`AdvancedFormActions.actions_meta_by_tag`). */
function actionByTag(
	actions: AdvancedFormActions,
	tag: string,
):
	| { readonly kind: "load"; readonly action: LoadUpdateAction }
	| { readonly kind: "open"; readonly action: AdvancedOpenCaseAction } {
	const open = actions.open_cases.find((action) => action.case_tag === tag);
	if (open !== undefined) return { kind: "open", action: open };
	const load = actions.load_update_cases.find(
		(action) => action.case_tag === tag,
	);
	if (load !== undefined) return { kind: "load", action: load };
	throw new Error(
		`Nova could not write an advanced form's case index: no action of the form has the tag "${tag}". Every index names a load or an earlier open action of the same form.`,
	);
}

/**
 * Write an advanced form's case blocks into its source, as CommCare HQ's
 * build does. Returns the form unchanged when it has no load or open action.
 */
export function addAdvancedCaseBlocks(
	xform: string,
	plan: AdvancedCaseBlocksPlan,
	ctx: AdvancedCaseBlocksContext = {},
): string {
	const { actions } = plan;
	if (actions.load_update_cases.length === 0 && actions.open_cases.length === 0)
		return xform;
	const instances = new InstanceSink();
	const emission: Emission = {
		binds: [],
		setvalues: [],
		requiredNamePaths: [],
		context: { mode: { target: "xform", constraint: false }, instances },
	};
	const doc = parseXForm(xform);
	const data = findDataElement(doc, "addAdvancedCaseBlocks");

	for (const load of actions.load_update_cases)
		addLoadBlock(
			emission,
			data,
			load,
			ctx.loadDatumIds?.get(load.case_tag) ?? loadSessionVar(load.case_tag),
		);

	// `AdvancedFormActions.count_subcases_per_repeat_context`: the open
	// actions that index a case, per repeat.
	const indexedPerRepeat = new Map<string, number>();
	for (const action of actions.open_cases)
		if (action.case_indices.length > 0)
			indexedPerRepeat.set(
				action.repeat_context,
				(indexedPerRepeat.get(action.repeat_context) ?? 0) + 1,
			);
	const rows = new Set<string>();
	for (const action of actions.open_cases) {
		if (action.repeat_context === "") continue;
		if ((indexedPerRepeat.get(action.repeat_context) ?? 0) > 1) continue;
		if (rows.has(action.repeat_context))
			throw new Error(
				`Nova placed two open actions at the row of the repeat ${action.repeat_context}, where CommCare HQ's build writes both case blocks at one path. A repeat holds two open actions only where at least two of them index a case.`,
			);
		rows.add(action.repeat_context);
	}
	for (let index = 0; index < actions.open_cases.length; index++)
		addOpenBlock(emission, data, actions, index, indexedPerRepeat);

	const model = findModelElement(doc, "addAdvancedCaseBlocks");
	for (const { id, src } of instances.declarations())
		ensureInstance(model, id, src);
	const inserted: ChildNode[] = [...emission.binds, ...emission.setvalues];
	insertBeforeItext(model, inserted);
	for (const namePath of emission.requiredNamePaths)
		markRequired(model, namePath, emission.context);
	return serializeXForm(doc);
}

/**
 * `required="true()"` on the bind of the path a create's name names, merged
 * onto the bind the source already holds for it, as HQ's `add_bind` merges.
 */
function markRequired(
	model: Element,
	namePath: string,
	context: WireElementContext,
): void {
	const existing = getChildren(model).find(
		(child): child is Element =>
			child instanceof Element &&
			child.name === "bind" &&
			child.attribs.nodeset === namePath,
	);
	if (existing !== undefined) {
		existing.attribs.required = serializeWire(w.call("true"), {
			target: "xform",
			constraint: false,
		}).text;
		return;
	}
	insertBeforeItext(model, [
		xel(
			"bind",
			{
				xpath: {
					nodeset: FormPath.parse(namePath).toWire(),
					required: w.call("true"),
				},
			},
			context,
		),
	]);
}
