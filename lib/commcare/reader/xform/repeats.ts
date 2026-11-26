/**
 * Repeats and where model iteration is held. A `group` that is
 * no Question List and holds exactly one `repeat` child is a repeat
 * (`parser.js::buildControlNodeAdaptorMap`). Its mode is read from the
 * repeat's `jr:count` and `jr:noAddRemove` and from the node its `nodeset`
 * names. A model-iteration repeat's parts are recognized by rebuilding them
 * with the emitter's own trees (`xform/builder.ts::modelIterationParts`) and
 * comparing parsed trees; where they differ the wrapper is left unclaimed.
 */

import { type Element, isTag } from "domhandler";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import {
	heldOpeningRepeatNeed,
	queryRepeatPlacementNeeds,
} from "@/lib/domain/queryRepeatPlacement";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { modelIterationParts } from "../../xform/builder";
import type { FormPath } from "../../xform/formPath";
import {
	elementNamespace,
	JAVAROSA_NS,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import { serializeWire } from "../../xpath/wire/serialize";
import type { Accounting } from "../accounting";
import type { Claim } from "../claims";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { XmlCursor } from "../xmlCursor";
import type { ControlNode } from "./body";
import { X } from "./claims";
import { G } from "./generated";
import type { DraftField } from "./index";
import {
	type AttributeBind,
	attributeNameIn,
	type BindFacts,
	type DataNode,
	type DataTree,
	formPathOf,
	insideRepeat,
	readNodePath,
	type SetvalueFacts,
} from "./model";
import type { ParsedXForm } from "./parse";
import type { StandingRefusal } from "./refusals";

/** What a repeat's own attributes read as, before the fields of the form are known. */
export type RepeatRead =
	| { readonly kind: "user_controlled"; readonly node: DataNode }
	/** `jr:count` names a node; its claim waits on what that node becomes (`settleRepeatCount`). */
	| {
			readonly kind: "count";
			readonly node: DataNode;
			readonly target: DataNode;
			readonly count: { readonly attribute: string; readonly text: string };
			readonly noAddRemove: string;
	  }
	| {
			readonly kind: "model-iteration";
			/** The wrapper, the field's node. */
			readonly node: DataNode;
			/** The `item` row. */
			readonly row: DataNode;
	  }
	/** A finding stands at the repeat, or its parts were left unclaimed: a stand-in, with the
	 *  refusal that covers what it holds (its wrapper's label, its bind) where the repeat was
	 *  refused. */
	| {
			readonly kind: "stand-in";
			readonly node: DataNode;
			readonly refusal?: StandingRefusal;
	  };

export interface ReadRepeatInput {
	readonly wrapper: ControlNode;
	readonly repeat: ControlNode;
	readonly parsed: ParsedXForm;
	readonly tree: DataTree;
	readonly setvalues: readonly SetvalueFacts[];
	readonly attributeBinds: readonly AttributeBind[];
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly place: HqPlace;
}

const XFORM = { target: "xform", constraint: false } as const;

/** The site a repeat's `jr:template` is claimed at, by where its node sits: a child of the data
 *  root, or one deeper, as the lane names an instance's content. */
function templateSite(
	sites: {
		readonly template: Claim<"take">;
		readonly templateTop: Claim<"take">;
	},
	node: DataNode,
): Claim<"take"> {
	return node.path.length === 1 ? sites.templateTop : sites.template;
}

function plain(element: Element, name: string): string | undefined {
	return Object.hasOwn(element.attribs, name)
		? element.attribs[name]
		: undefined;
}

/** The text stage reads the first and subsequent add buttons. A native runtime never
 * shows the other captions. An itext reference on one cannot survive a Vellum save. */
function claimCaptions(input: ReadRepeatInput): void {
	const { repeat, parsed, cursor, place } = input;
	for (const child of repeat.element.children.filter(isTag)) {
		if (elementNamespace(child, parsed.scope(child)) !== JAVAROSA_NS) continue;
		const local = splitName(child.name).local;
		if (local === "addCaption" || local === "addEmptyCaption")
			continue; // readText resolves the caption and its translations.
		else if (plain(child, "ref") !== undefined)
			cursor.refuseSubtree(child, X.itextCaptions, place);
		else cursor.dropSubtree(child, X.otherCaptions);
	}
}

/** The setvalue of a target path at an event, the first in document order. */
function setvalueAt(
	setvalues: readonly SetvalueFacts[],
	target: readonly string[],
): SetvalueFacts | undefined {
	return setvalues.find(
		(one) =>
			one.target !== undefined &&
			one.target.length === target.length &&
			one.target.every((step, i) => step === target[i]),
	);
}

/** `join(' ', X)`: the query's text, or undefined where the value is no such call. */
function joinedQuery(
	text: string,
): { readonly from: number; readonly to: number } | undefined {
	const read = readFormSyntax(text);
	const node = read.ok ? read.node : undefined;
	if (node?.kind !== "call" || node.name !== "join" || node.args.length !== 2)
		return undefined;
	const [separator, query] = node.args;
	return separator?.kind === "string" &&
		separator.value === " " &&
		query !== undefined
		? { from: query.from, to: query.to }
		: undefined;
}

/** Reads a model-iteration wrapper's parts against the emitter's own trees; undefined where any
 *  part is missing or differs. */
function modelIteration(
	input: ReadRepeatInput,
	field: DraftField,
	wrapper: DataNode,
	row: DataNode,
	count: { readonly attribute: string },
	noAddRemove: string | undefined,
): boolean {
	const { cursor, setvalues, accounting } = input;
	const path = formPathOf(wrapper);
	const role = attributeNameIn(
		wrapper.element,
		input.parsed,
		VELLUM_NS,
		"role",
	);
	const template = attributeNameIn(
		row.element,
		input.parsed,
		JAVAROSA_NS,
		"template",
	);
	if (
		path === undefined ||
		role === undefined ||
		template === undefined ||
		noAddRemove === undefined ||
		!["ids", "count", "current_index"].every(
			(name) => plain(wrapper.element, name) !== undefined,
		) ||
		!["id", "index"].every((name) => plain(row.element, name) !== undefined) ||
		// The emitter's wrapper holds its row and nothing else: a node beside the row is no
		// row's child, though the repeat's field stands on the wrapper.
		wrapper.children.length !== 1
	)
		return false;
	const parts = modelIterationParts(path, insideRepeat(wrapper));
	accounting.noteRebuild();
	const pathOf = (formPath: FormPath) =>
		serializeWire(formPath.toWire(), XFORM).text;
	const ids = setvalueAt(setvalues, [...wrapper.path, "@ids"]);
	const idsQuery =
		ids?.value === undefined ? undefined : joinedQuery(ids.value);
	if (
		ids === undefined ||
		ids.event !== parts.ids.event ||
		idsQuery === undefined
	)
		return false;
	const fixed = parts.fixed.map((part) => {
		const ref = pathOf(part.path);
		const at = setvalues.find(
			(one) =>
				plain(one.element, "ref") !== undefined &&
				sameXPathText(plain(one.element, "ref") as string, ref, {
					ruleSet: "form",
				}),
		);
		return { part, at };
	});
	if (
		fixed.some(
			({ part, at }) =>
				at === undefined ||
				at.event !== part.event ||
				at.value === undefined ||
				!sameXPathText(at.value, serializeWire(part.value, XFORM).text, {
					ruleSet: "form",
				}),
		)
	)
		return false;
	const currentIndex = input.attributeBinds.find(
		(bind) => bind.node === wrapper && bind.attribute === "current_index",
	);
	const calculate =
		currentIndex === undefined
			? undefined
			: plain(currentIndex.element, "calculate");
	if (
		currentIndex === undefined ||
		calculate === undefined ||
		!sameXPathText(
			calculate,
			serializeWire(parts.currentIndex.calculate, XFORM).text,
			{
				ruleSet: "form",
			},
		)
	)
		return false;

	// The wrapper is the repeat field's data node, claimed by the question id rule.
	const sites = X.modelIteration;
	// The role names one of several disjoint classes. The loaded question
	// identities and action order decide which one in checkModelIterations.
	cursor.partOf({ element: wrapper.element, attribute: role }, sites.role);
	// The wrapper's and the row's own attributes are answer data Core copies into the instance.
	for (const name of ["ids", "count", "current_index"])
		cursor.partOf({ element: wrapper.element, attribute: name }, sites.node);
	cursor.take({ element: row.element }, sites.node).value;
	cursor.within({ element: row.element }, sites.node, [
		"xform:model/instance//*",
	]);
	cursor.take(
		{ element: row.element, attribute: template },
		templateSite(sites, row),
	).value;
	for (const name of ["id", "index"])
		cursor.partOf({ element: row.element, attribute: name }, sites.node);
	cursor.take({ element: input.repeat.element }, sites.control).value;
	claimRepeatContainer(input.accounting, input.repeat, input.place, sites);
	cursor.take(
		{ element: input.repeat.element, attribute: "nodeset" },
		sites.nodeset,
	).value;
	cursor.take(
		{ element: input.repeat.element, attribute: count.attribute },
		sites.count,
	).value;
	cursor.take(
		{ element: input.repeat.element, attribute: noAddRemove },
		sites.noAddRemove,
	).value;
	for (const setvalue of [ids, ...fixed.map(({ at }) => at as SetvalueFacts)]) {
		cursor.take({ element: setvalue.element }, sites.setvalue).value;
		cursor.take({ element: setvalue.element, attribute: "event" }, sites.event)
			.value;
		cursor.take(
			{ element: setvalue.element, attribute: "ref" },
			sites.setvalueRef,
		).value;
		if (setvalue !== ids)
			cursor.take(
				{ element: setvalue.element, attribute: "value" },
				sites.setvalueValue,
			).value;
	}
	cursor.derived({ element: currentIndex.element }, X.bindElement.element);
	cursor.take(
		{ element: currentIndex.element, attribute: currentIndex.pathAttribute },
		X.bind.nodeset,
	).value;
	cursor.derived(
		{ element: currentIndex.element, attribute: "calculate" },
		X.currentIndexCalculate,
	);
	field.expressions.push({
		slot: "ids_query",
		text: (ids.value as string).slice(idsQuery.from, idsQuery.to),
		at: { element: ids.element, attribute: "value" },
		key: "xform:setvalue@value",
		mode: XFORM,
		event: ids.event === "jr-insert" ? "jr-insert" : "xforms-ready",
	});
	return true;
}

/** Whether a `jr:count` is a path that starts at `instance('…')`: a path to a node of a
 *  secondary instance, which the form's data tree holds none of. */
function secondaryInstancePath(text: string): boolean {
	const read = readFormSyntax(text);
	let at = read.ok ? read.node : undefined;
	if (at?.kind !== "child" && at?.kind !== "filter") return false;
	while (at?.kind === "child" || at?.kind === "filter")
		at = at.kind === "child" ? at.left : at.base;
	return at?.kind === "call" && at.name === "instance";
}

/**
 * What Core reads of a held repeat beside the repeat itself, under the repeat's own entry: the
 * group wrapping it, which Core parses as a container group (`XFormParser.parseGroup`,
 * `jr-control:group`), and each child's namespace, which `parseGroup` reads of every child of a
 * repeat (`xform:repeat/*@xmlns`), of each control it holds.
 */
function claimRepeatContainer(
	accounting: Accounting,
	repeat: ControlNode,
	place: HqPlace,
	sites: {
		readonly container: Claim<"take">;
		readonly childNamespace: Claim<"take">;
	},
): void {
	// The wrapper's own node is the wrapper entry's (`readRepeat`), so the
	// container read is a further key there, as each child's namespace is.
	const claim = (
		site: { readonly element: Element; readonly attribute?: string },
		{ entry, key }: Claim<"take">,
	) => {
		if (key !== null) accounting.claimEntry(site, entry, key, place);
	};
	const wrapper = repeat.parent;
	if (wrapper !== null && wrapper.tag === "group")
		claim({ element: wrapper.element }, sites.container);
	// Each control the repeat holds; an action inside it is read, and refused, on its own
	// (`actions.ts`).
	for (const child of repeat.children)
		claim({ element: child.element, attribute: "xmlns" }, sites.childNamespace);
}

/**
 * Reads a repeat's own attributes and claims the wrapping group, its captions and, for a
 * repeat with no count or a model-iteration repeat, the repeat itself. A counted repeat's
 * claim waits for the fields of the form (`settleRepeatCount`).
 */
export function readRepeat(
	input: ReadRepeatInput,
	field: DraftField,
): RepeatRead {
	const { wrapper, repeat, cursor, place, tree } = input;
	cursor.derived({ element: wrapper.element }, X.repeatWrapper.control);
	if (wrapper.path === "ref" || wrapper.path === "nodeset")
		cursor.derived(
			{ element: wrapper.element, attribute: wrapper.path },
			X.repeatWrapper.ref,
		);
	claimCaptions(input);
	const node = repeat.node as DataNode;
	if (!node.template) return { kind: "stand-in", node };
	const count = attributeNameIn(
		repeat.element,
		input.parsed,
		JAVAROSA_NS,
		"count",
	);
	const noAddRemove = attributeNameIn(
		repeat.element,
		input.parsed,
		JAVAROSA_NS,
		"noAddRemove",
	);
	const template = attributeNameIn(
		node.element,
		input.parsed,
		JAVAROSA_NS,
		"template",
	);
	const refuseAll = (claim: Claim<"refuse">, name?: string) => {
		const detail = name === undefined ? undefined : { name };
		cursor.refuse({ element: repeat.element }, claim, place, detail);
		cursor.refuse({ element: node.element }, claim, place, detail);
		for (const attribute of [count, noAddRemove, "nodeset"])
			if (attribute !== undefined)
				cursor.refuse(
					{ element: repeat.element, attribute },
					claim,
					place,
					detail,
				);
		if (template !== undefined)
			cursor.refuse(
				{ element: node.element, attribute: template },
				claim,
				place,
				detail,
			);
		const refusal: StandingRefusal =
			detail === undefined ? { claim, place } : { claim, place, detail };
		return { kind: "stand-in", node, refusal } as const;
	};
	if (count === undefined) {
		if (noAddRemove !== undefined) return refuseAll(X.noAddRemoveWithoutCount);
		const sites = X.userRepeat;
		cursor.take({ element: node.element }, sites.node).value;
		cursor.take({ element: repeat.element }, sites.control).value;
		claimRepeatContainer(input.accounting, repeat, place, sites);
		cursor.take(
			{ element: repeat.element, attribute: "nodeset" },
			sites.nodeset,
		).value;
		if (template !== undefined)
			cursor.take(
				{ element: node.element, attribute: template },
				templateSite(sites, node),
			).value;
		field.field.repeat_mode = "user_controlled";
		return { kind: "user_controlled", node };
	}
	const text = repeat.element.attribs[count] ?? "";
	const read = readNodePath(text, tree, node.parent);
	if (read.kind === "not-a-path")
		return refuseAll(
			secondaryInstancePath(text) ? X.countNamingNoNode : X.countNotAPath,
			text,
		);
	// The data root is no question a count can name, as a node the tree lacks is none.
	if (read.kind !== "node") return refuseAll(X.countNamingNoNode, text);
	if (read.attribute !== undefined) {
		const wrapperNode = node.parent;
		if (
			read.attribute === "count" &&
			wrapperNode !== null &&
			read.node === wrapperNode &&
			wrapperNode.role === "Repeat" &&
			node.name === "item" &&
			modelIteration(
				input,
				field,
				wrapperNode,
				node,
				{ attribute: count },
				noAddRemove,
			)
		) {
			field.field.repeat_mode = "query_bound";
			field.field.placement = "model-iteration";
			return { kind: "model-iteration", node: wrapperNode, row: node };
		}
		return { kind: "stand-in", node: wrapperNode ?? node };
	}
	if (
		noAddRemove === undefined ||
		repeat.element.attribs[noAddRemove]?.trim() !== "true()"
	)
		return { kind: "stand-in", node };
	return {
		kind: "count",
		node,
		target: read.node,
		count: { attribute: count, text },
		noAddRemove,
	};
}

export interface SettleCountInput {
	readonly repeat: ControlNode;
	readonly read: Extract<RepeatRead, { kind: "count" }>;
	readonly field: DraftField;
	/** The field the count names, or undefined where it names a node that is no field. */
	readonly target: DraftField | undefined;
	/** Whether the count names the query count node Nova generates for this repeat. */
	readonly queryCount: boolean;
	/** The bind of the count node Nova generates for this repeat (`nova_count_<r>`), where
	 *  the count names it: the repeat's count is that node's calculate. */
	readonly generatedCount?: BindFacts;
	readonly parsed: ParsedXForm;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly place: HqPlace;
}

/**
 * Claims a counted repeat by what its count names: an integer question, a Hidden Value or
 * a single select is held, the count registered as the repeat's `repeat_count`; a decimal or any
 * other question is refused; the generated query count is the count placement.
 */
export function settleRepeatCount(input: SettleCountInput): boolean {
	const { repeat, read, field, target, cursor, place } = input;
	const kind = target?.kind;
	const generatedCount = input.generatedCount;
	const sites = input.queryCount
		? X.countFromQuery
		: generatedCount?.logic.calculate !== undefined
			? X.countFromHidden
			: kind === "int"
				? X.countFromInteger
				: kind === "hidden"
					? X.countFromHidden
					: kind === "single_select"
						? X.countFromSelect
						: undefined;
	if (sites === undefined) {
		const claim = kind === "decimal" ? X.countFromDecimal : X.countFromOther;
		const detail = { name: read.count.text };
		cursor.refuse({ element: repeat.element }, claim, place, detail);
		cursor.refuse({ element: read.node.element }, claim, place, detail);
		for (const attribute of [read.count.attribute, read.noAddRemove, "nodeset"])
			cursor.refuse(
				{ element: repeat.element, attribute },
				claim,
				place,
				detail,
			);
		const template = attributeNameIn(
			read.node.element,
			input.parsed,
			JAVAROSA_NS,
			"template",
		);
		if (template !== undefined)
			cursor.refuse(
				{ element: read.node.element, attribute: template },
				claim,
				place,
				detail,
			);
		return false;
	}
	cursor.take({ element: read.node.element }, sites.node).value;
	cursor.take({ element: repeat.element }, sites.control).value;
	claimRepeatContainer(input.accounting, repeat, place, sites);
	cursor.take({ element: repeat.element, attribute: "nodeset" }, sites.nodeset)
		.value;
	cursor.take(
		{ element: repeat.element, attribute: read.noAddRemove },
		sites.noAddRemove,
	).value;
	const template = attributeNameIn(
		read.node.element,
		input.parsed,
		JAVAROSA_NS,
		"template",
	);
	if (template !== undefined)
		cursor.take(
			{ element: read.node.element, attribute: template },
			templateSite(sites, read.node),
		).value;
	if (input.queryCount) {
		cursor.take(
			{ element: repeat.element, attribute: read.count.attribute },
			X.countFromQuery.count,
		).value;
		field.field.repeat_mode = "query_bound";
		field.field.placement = "count";
		return true;
	}
	field.field.repeat_mode = "count_bound";
	const countCalculate = generatedCount?.logic.calculate;
	if (generatedCount !== undefined && countCalculate !== undefined) {
		cursor.take(
			{ element: repeat.element, attribute: read.count.attribute },
			G.countFromNode,
		).value;
		field.expressions.push({
			slot: "repeat_count",
			text: countCalculate,
			at: { element: generatedCount.element, attribute: "calculate" },
			key: "xform:model/bind@calculate",
			mode: XFORM,
		});
		return true;
	}
	field.expressions.push({
		slot: "repeat_count",
		text: read.count.text,
		at: { element: repeat.element, attribute: read.count.attribute },
		key: "xform:repeat@jr:count",
		mode: XFORM,
	});
	return true;
}

// ── Where model iteration is held ─────────────────────────────────

export type ModelIterationVerdict =
	| { readonly kind: "held"; readonly existingTiming?: true }
	| { readonly kind: "refused"; readonly claim: Claim<"refuse"> };

/** Only a demonstrated opening limitation refuses an otherwise representable
 * query. The actual loaded IDs, including an empty list, belong to entry. */
export function modelIterationVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	repeatUuid: Uuid,
	setAfterIds: (fieldUuid: Uuid) => boolean | undefined,
): ModelIterationVerdict {
	const form = formStructure(doc, formUuid);
	if (form === undefined) return { kind: "held" };
	const need = heldOpeningRepeatNeed(form, repeatUuid, setAfterIds);
	switch (need?.kind) {
		case "nested":
			return { kind: "refused", claim: X.modelIterationNested };
		case "query-reads-answers":
			return { kind: "refused", claim: X.modelIterationBlankAnswer };
		case "ancestor-condition-changes":
			return { kind: "refused", claim: X.modelIterationLateRelevance };
		default:
			return queryRepeatPlacementNeeds(form, repeatUuid).length > 0
				? { kind: "held", existingTiming: true }
				: { kind: "held" };
	}
}
