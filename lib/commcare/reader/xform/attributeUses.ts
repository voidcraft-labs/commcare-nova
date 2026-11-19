/**
 * The uses of every XForm attribute Core parses as XPath that no slot holds whole: a bind's
 * `nodeset`, a control's `ref`, a setvalue's `ref`, an itemset's `nodeset` and its label's and
 * value's `ref`, a repeat's `nodeset` and a count no slot reads, the logic Nova's emitter and
 * CommCare HQ's build write on a node no question holds, and an output of a text no slot reads
 * (in a translation for a language the app does not hold). A reference path is an expression:
 * Core parses each with the one grammar (`XPathReference.getPathExpr`, `XPathParseTool.parseXPath`),
 * so the functions, steps, operators and instances its text holds are uses of the app, as a
 * bind's calculate's are.
 */

import type { Element } from "domhandler";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import { fieldKindDeclaresKey } from "@/lib/domain/fields";
import type { ReadContext } from "../context";
import type { ReadMode } from "../pendingExpressions";
import { type ExpressionAttribute, parsedAsXPath } from "../xmlCursor";
import type { DraftField, ReadXForm } from "./index";

const XFORM: ReadMode = { target: "xform", constraint: false };

/** The outermost element above `element`: a form's `<h:html>`. */
function outermost(element: Element): Element {
	let at = element;
	while (at.parent !== null && at.parent.type !== "root")
		at = at.parent as Element;
	return at;
}

/** The field whose logic a form's attribute uses are read in: the first field, in document
 *  order, that holds a display condition. Every field of a form reads its text under the form's
 *  rules and its instances, which is all a path's uses are classed by. */
function ownerOf(xform: ReadXForm): SlotContextRef | undefined {
	const walk = (parent: DraftField | null): DraftField | undefined => {
		for (const field of xform.childrenOf(parent)) {
			if (
				field.uuid !== undefined &&
				!field.standIn &&
				fieldKindDeclaresKey(field.kind, "relevant")
			)
				return field;
			const inner = walk(field);
			if (inner !== undefined) return inner;
		}
		return undefined;
	};
	const owner = walk(null);
	return owner?.uuid === undefined
		? undefined
		: ({
				entity: "field",
				uuid: owner.uuid,
				slot: "relevant",
			} as SlotContextRef);
}

/**
 * Registers, for the uses its syntax makes alone (`PendingExpression.usesOnly`), each attribute
 * of each form a claim read whose surface key Core parses as XPath
 * (`xmlCursor.ts::XmlCursor.expressionAttributes`) where no registration holds its whole value:
 * one with none, and one a slot reads a part of (a model-iteration query inside its
 * `join(' ', …)`, an itemset's filter inside its `nodeset`), whose other uses the whole value's
 * registration claims beside the part's (`Accounting.claimEntry`'s `unlessClaimed`). An output
 * of a markdown copy or of another language that is the twin of a source output is claimed after
 * the expression stage opens, under every claim the stage made of its twin
 * (`prose.ts::claimTwin`), its uses among them; a literal output of a copy, which has no twin,
 * is claimed in the form stage and is one of these attributes.
 */
export function registerAttributeUses(ctx: ReadContext): void {
	const registered = new Map<Element, Map<string, Set<string>>>();
	const note = (element: Element, attribute: string, text: string) => {
		const byAttribute =
			registered.get(element) ?? new Map<string, Set<string>>();
		registered.set(element, byAttribute);
		const texts = byAttribute.get(attribute) ?? new Set<string>();
		byAttribute.set(attribute, texts);
		texts.add(text);
	};
	/* A registration of a part of an attribute's value, by the form whose cursor read it: the
	 * attribute stands among those the form's claims read, its claim made by the expression
	 * stage for the slot that reads the part. */
	const parts = new Map<Element, ExpressionAttribute[]>();
	ctx.pending.list().forEach((registration, index) => {
		const at = ctx.pending.site(index).at;
		if (!("element" in at) || at.attribute === undefined) return;
		note(at.element, at.attribute, registration.text);
		if (
			at.element.attribs[at.attribute] !== registration.text &&
			parsedAsXPath(registration.key)
		) {
			const html = outermost(at.element);
			const list = parts.get(html) ?? [];
			parts.set(html, list);
			list.push({ node: at, key: registration.key });
		}
	});
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const xform = form.xform;
			if (xform === null) continue;
			const attributes = [
				...xform.cursor.expressionAttributes(),
				...(parts.get(xform.parsed.html) ?? []),
			];
			if (attributes.length === 0) continue;
			const ref = ownerOf(xform);
			if (ref === undefined) continue;
			for (const { node, key } of attributes) {
				const attribute = node.attribute;
				if (attribute === undefined) continue;
				const text = node.element.attribs[attribute];
				if (
					text === undefined ||
					registered.get(node.element)?.get(attribute)?.has(text) === true
				)
					continue;
				ctx.pending.register(
					{ ref, text, mode: XFORM, place: form.place, key, usesOnly: true },
					node,
				);
				note(node.element, attribute, text);
			}
		}
}
