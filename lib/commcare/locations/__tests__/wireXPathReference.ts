// A JavaRosa stand-in, small enough to be obviously right.
//
// This is a TEST ASSET and never production code. Nova has exactly one owner
// evaluator — `lib/case-store/sql/compileTerm.ts` — and this exists only so a
// second, independent reading of the SAME rule can be compared against it. The
// restore closure's `livequeryReference.ts` is here for the same reason and
// under the same rule: a differential test needs two implementations, and the
// moment one of them ships, the test stops proving anything.
//
// It reads structure through the Lezer grammar, never by matching text. That
// is not stylistic — a regex that "recognizes" the lowered shape would pass an
// emitter that produced a subtly different tree, which is precisely the failure
// this test exists to catch.
//
// The supported subset is exactly what `emitTerm` produces for a location owner
// rule: `instance()` roots, child steps, attribute steps, `[…]` predicates, and
// `=`. Anything else throws by name rather than answering wrong — an evaluator
// that silently returns "" for a shape it does not understand would report
// parity it never checked.

import type { SyntaxNode } from "@lezer/common";
import { type AnyNode, type Element, isTag } from "domhandler";
import { textContent } from "domutils";
import { parser } from "@/lib/commcare/xpath";

/** An item in a node set: an element, or an attribute's string value. */
export type WireItem = Element | string;

export interface WireWorld {
	/** Secondary instances by id — what `instance('<id>')` resolves to. Each is
	 *  the element WRAPPING the instance body, matching the restore: the
	 *  `locations` instance is the `<fixture>` element, so `/locations` is its
	 *  child exactly as it is on a device. */
	readonly instances: Readonly<Record<string, Element>>;
}

/** The node types this evaluator reads. Everything else is punctuation. */
const EXPRESSION_TYPES = new Set([
	"XPath",
	"Child",
	"Filtered",
	"Invoke",
	"NameTest",
	"AttrSpecified",
	"StringLiteral",
	"EqualsExpr",
]);

function expressionChildren(node: SyntaxNode): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (EXPRESSION_TYPES.has(child.type.name)) children.push(child);
	}
	return children;
}

/** The XPath string-value of one item. */
export function stringValue(item: WireItem): string {
	return typeof item === "string" ? item : textContent(item);
}

function elementChildren(parent: Element, name: string): Element[] {
	return parent.children.filter(
		(child: AnyNode): child is Element => isTag(child) && child.name === name,
	);
}

/**
 * Evaluate one expression node to a node set.
 *
 * `context` is the current node — meaningful only inside a predicate, where a
 * bare `@type` step reads the element being filtered.
 */
function evaluate(
	node: SyntaxNode,
	source: string,
	world: WireWorld,
	context: WireItem | undefined,
): WireItem[] {
	const text = (target: SyntaxNode) => source.slice(target.from, target.to);
	switch (node.type.name) {
		case "XPath": {
			const [only] = expressionChildren(node);
			if (only === undefined) return [];
			return evaluate(only, source, world, context);
		}
		case "Invoke": {
			const name = node.getChild("FunctionName");
			if (name === null || text(name) !== "instance") {
				throw new Error(
					`The wire-XPath reference evaluator understands instance() and nothing else, but this expression calls ${name === null ? "an unnamed function" : `${text(name)}()`}. Either the emitter grew a shape this oracle has not learned, or the oracle is being pointed at an expression it was never meant to read.`,
				);
			}
			const literal = node.getChild("ArgumentList")?.getChild("StringLiteral");
			const id =
				literal === null || literal === undefined ? "" : unquote(text(literal));
			const instance = world.instances[id];
			if (instance === undefined) {
				throw new Error(
					`The expression reads instance('${id}'), which this world does not carry. Add it to the world's instances, or check whether the emitter named an instance the restore never delivers.`,
				);
			}
			return [instance];
		}
		case "Child": {
			const [base, step] = expressionChildren(node);
			if (base === undefined || step === undefined) return [];
			return evaluate(base, source, world, context).flatMap((item) =>
				applyStep(step, source, world, item),
			);
		}
		case "Filtered": {
			const [base, predicate] = expressionChildren(node);
			if (base === undefined || predicate === undefined) return [];
			return evaluate(base, source, world, context).filter((item) =>
				truthy(predicate, source, world, item),
			);
		}
		case "NameTest":
		case "AttrSpecified": {
			if (context === undefined) return [];
			return applyStep(node, source, world, context);
		}
		case "StringLiteral":
			return [unquote(text(node))];
		case "EqualsExpr":
			return truthy(node, source, world, context) ? ["true"] : [];
		default:
			throw new Error(
				`The wire-XPath reference evaluator reached a '${node.type.name}' node, which is outside the subset a location owner rule lowers to. Teach the evaluator that shape deliberately rather than letting it answer for one it cannot read.`,
			);
	}
}

/** Apply one location step to one item. */
function applyStep(
	step: SyntaxNode,
	source: string,
	world: WireWorld,
	item: WireItem,
): WireItem[] {
	if (typeof item === "string") return [];
	const text = (target: SyntaxNode) => source.slice(target.from, target.to);
	if (step.type.name === "NameTest") {
		return elementChildren(item, text(step));
	}
	if (step.type.name === "AttrSpecified") {
		const name = step.getChild("NameTest");
		if (name === null) return [];
		const value = item.attribs[text(name)];
		return value === undefined ? [] : [value];
	}
	if (step.type.name === "Filtered") {
		const [base, predicate] = expressionChildren(step);
		if (base === undefined || predicate === undefined) return [];
		return applyStep(base, source, world, item).filter((candidate) =>
			truthy(predicate, source, world, candidate),
		);
	}
	return evaluate(step, source, world, item);
}

/**
 * Predicate truth.
 *
 * `=` is EXISTENTIAL across node sets in XPath 1.0 — true when any pair of
 * items on the two sides shares a string value. Getting this wrong would make
 * the oracle agree with the SQL for the wrong reason on a place with two
 * matching ancestors.
 */
function truthy(
	node: SyntaxNode,
	source: string,
	world: WireWorld,
	context: WireItem | undefined,
): boolean {
	if (node.type.name === "EqualsExpr") {
		const [left, right] = expressionChildren(node);
		if (left === undefined || right === undefined) return false;
		const lhs = evaluate(left, source, world, context).map(stringValue);
		const rhs = evaluate(right, source, world, context).map(stringValue);
		return lhs.some((value) => rhs.includes(value));
	}
	return evaluate(node, source, world, context).length > 0;
}

function unquote(literal: string): string {
	return literal.slice(1, -1);
}

/**
 * Evaluate a lowered wire expression and return the first item's string value,
 * or `""` for an empty node set — JavaRosa's own answer for an expression that
 * matches nothing, and the reason a missing fixture fails silently.
 */
export function evaluateWireXPath(
	expression: string,
	world: WireWorld,
): string {
	const tree = parser.parse(expression);
	let broken = false;
	tree.iterate({
		enter(child) {
			if (child.type.isError) broken = true;
		},
	});
	if (broken) {
		throw new Error(
			`This expression does not parse as XPath, so nothing evaluated it: ${expression}`,
		);
	}
	const [first] = evaluate(tree.topNode, expression, world, undefined);
	return first === undefined ? "" : stringValue(first);
}
