import type { SyntaxNode } from "@lezer/common";
import { parser } from "../xpath/parser";

type XPathEvidence = readonly (string | number | XPathEvidence)[];

/** Read operator/path structure independently of emitter whitespace and
 * redundant parentheses. Literal values and every named step remain visible. */
export function xpathEvidence(source: string): XPathEvidence {
	const read = (node: SyntaxNode): XPathEvidence | undefined => {
		if (node.type.isError) throw new Error(`Invalid emitted XPath: ${source}`);
		if (node.type.isAnonymous || node.name === "(" || node.name === ")")
			return undefined;
		if (node.name === "StringLiteral")
			return [node.name, source.slice(node.from + 1, node.to - 1)];
		if (node.name === "NumberLiteral")
			return [node.name, Number(source.slice(node.from, node.to))];
		const children: XPathEvidence[] = [];
		for (
			let child = node.firstChild;
			child !== null;
			child = child.nextSibling
		) {
			const evidence = read(child);
			if (evidence !== undefined) children.push(evidence);
		}
		return children.length === 0
			? [node.name, source.slice(node.from, node.to)]
			: [node.name, ...children];
	};
	const evidence = read(parser.parse(source).topNode);
	if (evidence === undefined)
		throw new Error("An XPath needs a parsed expression.");
	return evidence;
}

/** Whether the parsed expression holds this whole subtree, never a textual
 * prefix that could accidentally match a different property or literal. */
export function xpathContains(source: string, fragment: string): boolean {
	const expected = JSON.stringify(xpathEvidence(fragment)[1]);
	const visit = (node: XPathEvidence): boolean =>
		JSON.stringify(node) === expected ||
		node.some((child) => Array.isArray(child) && visit(child));
	return visit(xpathEvidence(source));
}
