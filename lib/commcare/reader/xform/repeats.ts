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
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { queryRepeatPlacementNeeds } from "@/lib/domain/queryRepeatPlacement";
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

/** A repeat's captions: `jr:addCaption` and `jr:addEmptyCaption` refused, the others dropped
 *  where they hold text and refused where they reference itext. */
function claimCaptions(input: ReadRepeatInput): void {
	const { repeat, parsed, cursor, place } = input;
	for (const child of repeat.element.children.filter(isTag)) {
		if (elementNamespace(child, parsed.scope(child)) !== JAVAROSA_NS) continue;
		const local = splitName(child.name).local;
		if (local === "addCaption" || local === "addEmptyCaption")
			cursor.refuseSubtree(child, X.addCaptions, place);
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
	cursor.take({ element: wrapper.element, attribute: role }, sites.role).value;
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
	| { readonly kind: "held" }
	| { readonly kind: "refused"; readonly claim: Claim<"refuse"> };

/** The fields an expression reads by identity. */
function fieldsRead(expression: Expression | undefined): Uuid[] {
	const read: Uuid[] = [];
	if (expression === undefined) return read;
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "field") read.push(term.uuid);
	});
	return read;
}

/**
 * Whether a model-iteration repeat is held where Nova's own rule runs model iteration
 * (`queryRepeatPlacementNeeds` empty), refused under one of the three manifest refusals where the
 * blank answer is certain, or refused as outside that rule. `setAfterIds` says whether a node's
 * only load-time value stands after the wrapper's `@ids` setvalue in the form's effective load
 * order.
 */
export function modelIterationVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	repeatUuid: Uuid,
	setAfterIds: (fieldUuid: Uuid) => boolean,
): ModelIterationVerdict {
	const form = formStructure(doc, formUuid);
	if (form === undefined) return { kind: "held" };
	const needs = queryRepeatPlacementNeeds(form, repeatUuid);
	if (needs.length === 0) return { kind: "held" };
	/** An answer certainly blank where the setvalues run: a node whose only load-time value is set
	 *  after the wrapper's `@ids`, whatever its kind, or a question with a control and no default. */
	const blankAtLoad = (uuid: Uuid): boolean => {
		const field = doc.fields[uuid];
		if (field === undefined) return false;
		if (setAfterIds(uuid)) return true;
		if (field.kind === "hidden") return false;
		return (
			field.kind !== "group" &&
			field.kind !== "repeat" &&
			field.kind !== "section" &&
			field.kind !== "label" &&
			!("default_value" in field && field.default_value !== undefined)
		);
	};
	if (needs.some((need) => need.kind === "nested"))
		return { kind: "refused", claim: X.modelIterationNested };
	const query = form.expressionAt({
		entity: "field",
		uuid: repeatUuid,
		slot: "ids_query",
	});
	if (
		needs.some((need) => need.kind === "query-reads-answers") &&
		fieldsRead(query).some(blankAtLoad)
	)
		return { kind: "refused", claim: X.modelIterationBlankAnswer };
	for (const need of needs) {
		if (need.kind !== "ancestor-condition-changes") continue;
		const condition = form.expressionAt({
			entity: "field",
			uuid: need.groupUuid,
			slot: "relevant",
		});
		if (
			fieldsRead(condition).some((uuid) => {
				const field = doc.fields[uuid];
				return (
					field !== undefined &&
					field.kind !== "hidden" &&
					!("default_value" in field && field.default_value !== undefined)
				);
			})
		)
			return { kind: "refused", claim: X.modelIterationLateRelevance };
	}
	return { kind: "refused", claim: X.modelIterationOutsideRule };
}
