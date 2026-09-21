import type { SyntaxNode } from "@lezer/common";
import { RESERVED_XFORM_NODE_PREFIX } from "@/lib/commcare/constants";
import { parser } from "@/lib/commcare/xpath/parser";
import { printWireXPathSource } from "@/lib/commcare/xpath/wireSource";
import {
	type BlueprintDoc,
	isContainer,
	type Uuid,
	type XPathExpression,
} from "@/lib/domain";
import type { FormPath } from "./formPath";

interface ReferenceSpan {
	readonly from: number;
	readonly to: number;
	readonly uuid?: Uuid;
}
interface Calculation {
	readonly name: string;
	readonly path: string;
	readonly source: string;
}

/** Core substitutes a validation candidate at the predicate's current node too.
 * Count a different question's filtered answers outside that candidate context.
 * Only explicit scalar-field collections with context-independent predicates
 * qualify. The proposed answer and ambiguous/relative paths stay in validation.
 */
export function planConstraintCollections(
	expression: XPathExpression,
	fieldUuid: Uuid,
	doc: BlueprintDoc,
	path: FormPath,
): { source: string; calculations: Calculation[] } {
	let source = "";
	const references: ReferenceSpan[] = [];
	for (const part of expression.parts) {
		const from = source.length;
		source += printWireXPathSource({ parts: [part] }, doc);
		if (part.kind !== "text")
			references.push({
				from,
				to: source.length,
				...(part.kind === "field-ref" || part.kind === "path-ref"
					? { uuid: part.uuid }
					: {}),
			});
	}
	const tree = parser.parse(source);
	let invalid = false;
	tree.iterate({
		enter(node) {
			if (node.type.isError) invalid = true;
		},
	});
	if (invalid) return { source, calculations: [] };
	const calculations: Calculation[] = [];
	const edits: { from: number; to: number; replacement: string }[] = [];
	const bySource = new Map<string, Calculation>();
	tree.iterate({
		enter(cursor) {
			const node = cursor.node;
			if (node.name !== "Invoke") return;
			const name = node.getChild("FunctionName"),
				args = node.getChild("ArgumentList");
			if (!name || source.slice(name.from, name.to) !== "count" || !args)
				return;
			const children: SyntaxNode[] = [];
			for (let c = args.firstChild; c; c = c.nextSibling)
				if (c.name !== "(" && c.name !== ")") children.push(c);
			if (children.length !== 1 || children[0].name !== "Filtered") return;
			for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
				if (ancestor.name === "Filtered") return;
			}
			const argument = children[0];
			let base = argument;
			while (base.name === "Filtered" && base.firstChild)
				base = base.firstChild;
			const baseReference = references.find(
				(r) => r.from === base.from && r.to === base.to,
			);
			if (!baseReference?.uuid || baseReference.uuid === fieldUuid) return;
			const baseField = doc.fields[baseReference.uuid];
			if (!baseField || isContainer(baseField)) return;
			if (
				references.some(
					(r) =>
						r.from >= argument.from &&
						r.to <= argument.to &&
						r.uuid === fieldUuid,
				)
			)
				return;
			if (!safePredicateTree(argument, references)) return;
			const countSource = source.slice(node.from, node.to);
			let calculation = bySource.get(countSource);
			if (!calculation) {
				const syntheticName = `${RESERVED_XFORM_NODE_PREFIX}constraint_${doc.fields[fieldUuid].id}_${calculations.length}`;
				calculation = {
					name: syntheticName,
					path: path.parent().child(syntheticName).toXPath(),
					source: countSource,
				};
				calculations.push(calculation);
				bySource.set(countSource, calculation);
			}
			edits.push({
				from: node.from,
				to: node.to,
				replacement: calculation.path,
			});
			return false;
		},
	});
	for (const edit of edits.sort((a, b) => b.from - a.from))
		source =
			source.slice(0, edit.from) + edit.replacement + source.slice(edit.to);
	return { source, calculations };
}

/** No implicit outer/current context, positional functions, variables, or paths
 * that could reach the answer being validated. Typed references carry identity;
 * a predicate's dot reads only the explicitly selected other scalar field.
 */
function safePredicateTree(
	node: SyntaxNode,
	references: readonly ReferenceSpan[],
): boolean {
	if (references.some((r) => r.from === node.from && r.to === node.to))
		return true;
	if (
		[
			"Invoke",
			"ParentStep",
			"Child",
			"Descendant",
			"RootPath",
			"NameTest",
			"AttrSpecified",
			"AxisSpecified",
			"VariableReference",
			"HashtagRef",
		].includes(node.name)
	)
		return false;
	for (let child = node.firstChild; child; child = child.nextSibling)
		if (!safePredicateTree(child, references)) return false;
	return true;
}
