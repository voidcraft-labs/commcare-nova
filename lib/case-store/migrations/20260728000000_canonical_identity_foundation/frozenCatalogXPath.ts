/**
 * Frozen catalog-XPath classifier/printer for the canonical identity cutover.
 *
 * Catalog defaults have no form or Search-input scope. The enclosing case type
 * is their only identity context, so only an explicit one-segment reference to
 * that case type can become a canonical identity leaf. Every other reference
 * blocks for a separately reviewed repair.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "./frozenParser";

export type FrozenCatalogXPathPart =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "case-ref";
			readonly caseType: string;
			readonly property: string;
	  };

export interface FrozenCatalogXPathExpression {
	readonly parts: readonly FrozenCatalogXPathPart[];
}

export type FrozenCatalogXPathIssueCode =
	| "syntax"
	| "illegal-reference"
	| "printer-drift";

export interface FrozenCatalogXPathIssue {
	readonly code: FrozenCatalogXPathIssueCode;
	readonly from: number;
	readonly to: number;
}

export interface FrozenCatalogXPathResult {
	readonly expression: FrozenCatalogXPathExpression;
	readonly issues: readonly FrozenCatalogXPathIssue[];
}

interface Span {
	readonly from: number;
	readonly to: number;
	readonly part?: FrozenCatalogXPathPart;
	readonly issue?: FrozenCatalogXPathIssue;
}

const TYPES = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((type) => type.name === name);
		if (found === undefined)
			throw new Error(`Unknown frozen XPath node: ${name}`);
		return found;
	};
	const many = (name: string) =>
		new Set(all.filter((type) => type.name === name));
	return {
		children: many("Child"),
		descendants: many("Descendant"),
		hashtagRef: one("HashtagRef"),
		hashtagType: one("HashtagType"),
		hashtagSegment: one("HashtagSegment"),
		nameTest: one("NameTest"),
		rootPath: one("RootPath"),
		slash: one("/"),
	};
})();

function isWhitespace(charCode: number): boolean {
	return (
		charCode === 9 || charCode === 10 || charCode === 13 || charCode === 32
	);
}

function isOnlyPathSeparator(source: string): boolean {
	let slashCount = 0;
	for (let index = 0; index < source.length; index++) {
		const charCode = source.charCodeAt(index);
		if (isWhitespace(charCode)) continue;
		if (charCode !== 47 || slashCount === 2) return false;
		slashCount++;
	}
	return slashCount === 1 || slashCount === 2;
}

function collectPathSegments(
	node: SyntaxNode,
	source: string,
	segments: Array<{
		readonly text: string;
		readonly from: number;
		readonly to: number;
	}>,
): void {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (TYPES.children.has(child.type) || TYPES.descendants.has(child.type)) {
			collectPathSegments(child, source, segments);
		} else if (child.type === TYPES.rootPath || child.type === TYPES.slash) {
			// Reconstructed from source gaps below.
		} else if (child.type === TYPES.nameTest) {
			segments.push({
				text: source.slice(child.from, child.to),
				from: child.from,
				to: child.to,
			});
		} else if (!child.firstChild) {
			const text = source.slice(child.from, child.to);
			if (text !== "/" && text !== "//") {
				segments.push({ text, from: child.from, to: child.to });
			}
		}
	}
}

function absoluteDataSpan(node: SyntaxNode, source: string): Span | undefined {
	const segments: Array<{
		readonly text: string;
		readonly from: number;
		readonly to: number;
	}> = [];
	collectPathSegments(node, source, segments);
	if (segments.length < 2 || segments[0]?.text !== "data") return undefined;
	let cursor = node.from;
	for (const segment of segments) {
		if (
			segment.from < cursor ||
			!isOnlyPathSeparator(source.slice(cursor, segment.from))
		) {
			return undefined;
		}
		cursor = segment.to;
	}
	if (cursor !== node.to) return undefined;
	return {
		from: node.from,
		to: node.to,
		issue: {
			code: "illegal-reference",
			from: node.from,
			to: node.to,
		},
	};
}

function hashtagSpan(node: SyntaxNode, source: string, caseType: string): Span {
	const namespaceNode = node.getChild(TYPES.hashtagType.name);
	const namespace =
		namespaceNode === null
			? ""
			: source.slice(namespaceNode.from, namespaceNode.to);
	const segments = node
		.getChildren(TYPES.hashtagSegment.name)
		.map((segment) => source.slice(segment.from, segment.to));
	if (namespace === caseType && segments.length === 1) {
		return {
			from: node.from,
			to: node.to,
			part: {
				kind: "case-ref",
				caseType,
				property: segments[0] ?? "",
			},
		};
	}
	return {
		from: node.from,
		to: node.to,
		issue: {
			code: "illegal-reference",
			from: node.from,
			to: node.to,
		},
	};
}

function collectSpans(
	node: SyntaxNode,
	source: string,
	caseType: string,
	spans: Span[],
): void {
	if (node.type === TYPES.hashtagRef) {
		spans.push(hashtagSpan(node, source, caseType));
		return;
	}
	if (TYPES.children.has(node.type) || TYPES.descendants.has(node.type)) {
		const data = absoluteDataSpan(node, source);
		if (data !== undefined) {
			spans.push(data);
			return;
		}
	}
	for (let child = node.firstChild; child; child = child.nextSibling) {
		collectSpans(child, source, caseType, spans);
	}
}

function parseCore(source: string, caseType: string): FrozenCatalogXPathResult {
	if (source.length === 0) return { expression: { parts: [] }, issues: [] };
	const tree = parser.parse(source);
	let hasSyntaxError = false;
	tree.iterate({
		enter(node) {
			if (!node.type.isError) return undefined;
			hasSyntaxError = true;
			return false;
		},
	});
	if (hasSyntaxError) {
		return {
			expression: {
				parts: [{ kind: "text", text: source }],
			},
			issues: [{ code: "syntax", from: 0, to: source.length }],
		};
	}

	const spans: Span[] = [];
	collectSpans(tree.topNode, source, caseType, spans);
	spans.sort((left, right) => left.from - right.from || left.to - right.to);
	const issues = spans
		.flatMap((span) => (span.issue === undefined ? [] : [span.issue]))
		.sort((left, right) => left.from - right.from || left.to - right.to);
	if (issues.length > 0) {
		return {
			expression: {
				parts: [{ kind: "text", text: source }],
			},
			issues,
		};
	}

	const parts: FrozenCatalogXPathPart[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (span.part === undefined || span.from < cursor) continue;
		if (span.from > cursor) {
			parts.push({ kind: "text", text: source.slice(cursor, span.from) });
		}
		parts.push(span.part);
		cursor = span.to;
	}
	if (cursor < source.length) {
		parts.push({ kind: "text", text: source.slice(cursor) });
	}
	return { expression: { parts }, issues: [] };
}

export function printFrozenCatalogXPath(
	expression: FrozenCatalogXPathExpression,
): string {
	return expression.parts
		.map((part) =>
			part.kind === "text" ? part.text : `#${part.caseType}/${part.property}`,
		)
		.join("");
}

export function parseFrozenCatalogXPath(
	source: string,
	caseType: string,
): FrozenCatalogXPathResult {
	const parsed = parseCore(source, caseType);
	if (parsed.issues.length > 0) return parsed;
	const printed = printFrozenCatalogXPath(parsed.expression);
	if (printed !== source) {
		return {
			expression: parsed.expression,
			issues: [{ code: "printer-drift", from: 0, to: source.length }],
		};
	}
	const reparsed = parseCore(printed, caseType);
	if (
		reparsed.issues.length > 0 ||
		JSON.stringify(reparsed.expression) !== JSON.stringify(parsed.expression)
	) {
		return {
			expression: parsed.expression,
			issues: [{ code: "printer-drift", from: 0, to: source.length }],
		};
	}
	return parsed;
}
