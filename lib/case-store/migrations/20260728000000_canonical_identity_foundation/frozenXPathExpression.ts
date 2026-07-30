/**
 * Frozen Lezer-based XPath source classifier for the canonical identity
 * cutover. It locates reference spans structurally and delegates their
 * identity resolution to the frozen migration context. No regular expression
 * decides whether XPath text carries a reference.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "./frozenParser";

export type FrozenXPathPart =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "field-ref"; readonly uuid: string }
	| { readonly kind: "path-ref"; readonly uuid: string }
	| {
			readonly kind: "case-ref";
			readonly caseType: string;
			readonly property: string;
	  }
	| { readonly kind: "user-ref"; readonly property: string }
	| {
			readonly kind: "user-property-ref";
			readonly userPropertyUuid: string;
	  };

export interface FrozenXPathExpression {
	readonly parts: readonly FrozenXPathPart[];
}

export interface FrozenXPathResolver {
	readonly hashtag: (
		namespace: string,
		segments: readonly string[],
	) => Exclude<FrozenXPathPart, { kind: "text" | "path-ref" }> | undefined;
	readonly dataPath: (segments: readonly string[]) => string | undefined;
}

export interface FrozenXPathIssue {
	readonly code: "syntax" | "unresolved-reference" | "overlapping-reference";
	readonly from: number;
	readonly to: number;
}

export interface FrozenXPathParseResult {
	readonly expression: FrozenXPathExpression;
	readonly issues: readonly FrozenXPathIssue[];
}

interface Span {
	readonly from: number;
	readonly to: number;
	readonly part?: FrozenXPathPart;
	readonly issue?: FrozenXPathIssue;
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

function absoluteDataSpan(
	node: SyntaxNode,
	source: string,
	resolver: FrozenXPathResolver,
): Span | undefined {
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
			return {
				from: node.from,
				to: node.to,
				issue: {
					code: "unresolved-reference",
					from: node.from,
					to: node.to,
				},
			};
		}
		cursor = segment.to;
	}
	if (cursor !== node.to) {
		return {
			from: node.from,
			to: node.to,
			issue: {
				code: "unresolved-reference",
				from: node.from,
				to: node.to,
			},
		};
	}
	const uuid = resolver.dataPath(
		segments.slice(1).map((segment) => segment.text),
	);
	return uuid === undefined
		? {
				from: node.from,
				to: node.to,
				issue: {
					code: "unresolved-reference",
					from: node.from,
					to: node.to,
				},
			}
		: {
				from: node.from,
				to: node.to,
				part: { kind: "path-ref", uuid },
			};
}

function hashtagSpan(
	node: SyntaxNode,
	source: string,
	resolver: FrozenXPathResolver,
): Span {
	const namespaceNode = node.getChild(TYPES.hashtagType.name);
	const namespace =
		namespaceNode === null
			? ""
			: source.slice(namespaceNode.from, namespaceNode.to);
	const segments = node
		.getChildren(TYPES.hashtagSegment.name)
		.map((segment) => source.slice(segment.from, segment.to));
	const part = resolver.hashtag(namespace, segments);
	return part === undefined
		? {
				from: node.from,
				to: node.to,
				issue: {
					code: "unresolved-reference",
					from: node.from,
					to: node.to,
				},
			}
		: { from: node.from, to: node.to, part };
}

function collectSpans(
	node: SyntaxNode,
	source: string,
	resolver: FrozenXPathResolver,
	spans: Span[],
): void {
	if (node.type === TYPES.hashtagRef) {
		spans.push(hashtagSpan(node, source, resolver));
		return;
	}
	if (TYPES.children.has(node.type) || TYPES.descendants.has(node.type)) {
		const data = absoluteDataSpan(node, source, resolver);
		if (data !== undefined) {
			spans.push(data);
			return;
		}
	}
	for (let child = node.firstChild; child; child = child.nextSibling) {
		collectSpans(child, source, resolver, spans);
	}
}

export function parseFrozenXPathExpression(
	source: string,
	resolver: FrozenXPathResolver,
): FrozenXPathParseResult {
	if (source.length === 0) return { expression: { parts: [] }, issues: [] };
	const tree = parser.parse(source);
	let syntaxError = false;
	tree.iterate({
		enter(node) {
			if (!node.type.isError) return undefined;
			syntaxError = true;
			return false;
		},
	});
	if (syntaxError) {
		return {
			expression: { parts: [{ kind: "text", text: source }] },
			issues: [{ code: "syntax", from: 0, to: source.length }],
		};
	}

	const spans: Span[] = [];
	collectSpans(tree.topNode, source, resolver, spans);
	spans.sort((left, right) => left.from - right.from || left.to - right.to);
	const issues = spans.flatMap((span) =>
		span.issue === undefined ? [] : [span.issue],
	);
	if (issues.length > 0) {
		return {
			expression: { parts: [{ kind: "text", text: source }] },
			issues,
		};
	}

	const parts: FrozenXPathPart[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (span.part === undefined) continue;
		if (span.from < cursor) {
			issues.push({
				code: "overlapping-reference",
				from: span.from,
				to: span.to,
			});
			continue;
		}
		if (span.from > cursor) {
			parts.push({ kind: "text", text: source.slice(cursor, span.from) });
		}
		parts.push(span.part);
		cursor = span.to;
	}
	if (issues.length > 0) {
		return {
			expression: { parts: [{ kind: "text", text: source }] },
			issues,
		};
	}
	if (cursor < source.length) {
		parts.push({ kind: "text", text: source.slice(cursor) });
	}
	return { expression: { parts }, issues: [] };
}
