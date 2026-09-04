// lib/commcare/xpath/expressionAst.ts
//
// The parser half of the expression round-trip pair: source text →
// stored `XPathExpression` (shape, printer, and walks live in
// `lib/domain/xpath`). The Lezer grammar locates the reference-shaped
// spans — hashtag refs and absolute `/data/...` chains — and
// everything between them is kept as verbatim text runs. Identity leaves print
// canonically; the migration separately rejects a legacy noncanonical absolute
// path instead of preserving separator bytes in the stored AST.
//
// Reference classification mirrors the long-standing extractor/rewriter
// rules exactly — an identity leaf is minted precisely where a rename
// would have rewritten text:
//
//   - `#form/<path>` with a FULL id-path resolution → `field-ref`.
//     Partial/failed resolution is reported as a parse issue.
//   - `/data/<path>` as a PURE step chain (only `/`-or-`//` separators
//     and plain name steps — a predicate, axis, or function call
//     breaks the chain, exactly as it broke segment collection before)
//     with a full resolution → canonical `path-ref { uuid }`.
//   - `#<type>/<prop>` (one segment, explicit namespace) → `case-ref`.
//     Case properties are name-keyed; the name pair IS the identity,
//     so no doc lookup gates this.
//   - `#user/<prop>` → `user-property-ref` when it names Nova-authored
//     worker information, otherwise the final raw `user-ref` form.
//   - Raw `#case/...`, multi-segment non-form shapes, and unknown namespaces
//     are reported as parse issues and cannot enter a stored expression.
//
// A source with any Lezer parse error stays ONE opaque text run: ref
// classification over a broken tree is unreliable, and the syntax
// diagnostic (computed from printed text, as ever) is the signal.
// Parsing is total — there is no failure path; the commit gate
// adjudicates the PRINTED text with the same validator findings it
// always used.

import type { SyntaxNode } from "@lezer/common";
import {
	asUuid,
	opaqueXPathExpression,
	type ResolveFieldPath,
	type ResolveSearchInputName,
	type ResolveUserPropertySlug,
	type XPathExpression,
	type XPathPart,
} from "@/lib/domain";
import { parser } from "./parser";

export type {
	ResolveFieldPath,
	ResolveSearchInputName,
	ResolveUserPropertySlug,
};

const NO_SEARCH_INPUTS: ResolveSearchInputName = () => undefined;

// Pre-resolved node types. The grammar emits TWO distinct `Child` /
// `Descendant` node types (root-step rule vs expression rule), so
// membership is a Set check — same pattern as the extractor/rewriters.
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Unknown node type: ${name}`);
		return found;
	};
	const many = (name: string) => new Set(all.filter((t) => t.name === name));
	return {
		Children: many("Child"),
		Descendants: many("Descendant"),
		NameTest: one("NameTest"),
		RootPath: one("RootPath"),
		HashtagRef: one("HashtagRef"),
		HashtagType: one("HashtagType"),
		HashtagSegment: one("HashtagSegment"),
		Slash: one("/"),
	};
})();

interface LeafSpan {
	from: number;
	to: number;
	part: XPathPart | XPathUnresolvedReference;
}

interface XPathUnresolvedReference {
	readonly kind: "unresolved-reference";
	readonly namespace: string;
	readonly segments: readonly string[];
}

export interface XPathParseIssue {
	readonly kind: "syntax" | "unresolved-reference";
	readonly source: string;
	readonly from: number;
	readonly to: number;
}

export interface XPathParseResult {
	readonly expression: XPathExpression;
	readonly issues: readonly XPathParseIssue[];
}

/**
 * Parse one expression source to its stored AST, resolving form-local
 * references through `resolveFieldPath` (build one with
 * `fieldPathResolver(doc, formUuid)` from `lib/domain`).
 */
export function parseXPathExpression(
	source: string,
	resolveFieldPath: ResolveFieldPath,
	resolveUserPropertySlug: ResolveUserPropertySlug,
	resolveSearchInputName: ResolveSearchInputName = NO_SEARCH_INPUTS,
): XPathExpression {
	return parseXPathExpressionWithIssues(
		source,
		resolveFieldPath,
		resolveUserPropertySlug,
		resolveSearchInputName,
	).expression;
}

/**
 * `resolveSearchInputName` binds `#search/<name>`; it defaults to binding
 * nothing, which is right everywhere but a no-matches registration form
 * (build one with `searchInputNameResolver(doc, formUuid)`).
 */
export function parseXPathExpressionWithIssues(
	source: string,
	resolveFieldPath: ResolveFieldPath,
	resolveUserPropertySlug: ResolveUserPropertySlug,
	resolveSearchInputName: ResolveSearchInputName = NO_SEARCH_INPUTS,
): XPathParseResult {
	if (source.length === 0) return { expression: { parts: [] }, issues: [] };
	const tree = parser.parse(source);

	let hasError = false;
	tree.iterate({
		enter(node) {
			if (node.type.isError) {
				hasError = true;
				return false;
			}
			return undefined;
		},
	});
	if (hasError) {
		return {
			expression: opaqueXPathExpression(source),
			issues: [{ kind: "syntax", source, from: 0, to: source.length }],
		};
	}

	const spans: LeafSpan[] = [];
	collectLeafSpans(
		tree.topNode,
		source,
		resolveFieldPath,
		resolveUserPropertySlug,
		resolveSearchInputName,
		spans,
	);
	spans.sort((a, b) => a.from - b.from);

	const issues: XPathParseIssue[] = [];
	const identitySpans: Array<LeafSpan & { readonly part: XPathPart }> = [];
	for (const span of spans) {
		if (span.part.kind === "unresolved-reference") {
			issues.push({
				kind: "unresolved-reference",
				source: source.slice(span.from, span.to),
				from: span.from,
				to: span.to,
			});
		} else {
			identitySpans.push(span as LeafSpan & { readonly part: XPathPart });
		}
	}

	const parts: XPathPart[] = [];
	let cursor = 0;
	for (const span of identitySpans) {
		// Overlap guard — structurally unreachable (hashtags can't occur
		// inside a pure step chain, and path spans nest strictly), kept so
		// a grammar evolution degrades a span to text instead of
		// corrupting byte coverage.
		if (span.from < cursor) continue;
		if (span.from > cursor) {
			parts.push({ kind: "text", text: source.slice(cursor, span.from) });
		}
		parts.push(span.part);
		cursor = span.to;
	}
	if (cursor < source.length) {
		parts.push({ kind: "text", text: source.slice(cursor) });
	}
	return { expression: { parts }, issues };
}

function collectLeafSpans(
	node: SyntaxNode,
	source: string,
	resolveFieldPath: ResolveFieldPath,
	resolveUserPropertySlug: ResolveUserPropertySlug,
	resolveSearchInputName: ResolveSearchInputName,
	spans: LeafSpan[],
): void {
	if (node.type === T.HashtagRef) {
		const part = classifyHashtag(
			node,
			source,
			resolveFieldPath,
			resolveUserPropertySlug,
			resolveSearchInputName,
		);
		if (part !== undefined) {
			spans.push({ from: node.from, to: node.to, part });
		}
		return;
	}
	if (T.Children.has(node.type) || T.Descendants.has(node.type)) {
		const leaf = classifyDataPath(node, source, resolveFieldPath);
		if (leaf !== undefined) {
			spans.push(leaf);
			// The chain's nested nodes are its own prefixes — wholly owned
			// by this leaf. Nothing else can hide inside a pure chain.
			return;
		}
		// Not a claimable chain — nested sub-chains (e.g. a `/data/...`
		// prefix under a predicate step) may still claim, and predicate
		// bodies can hold further paths/hashtags. Keep recursing.
	}
	for (let child = node.firstChild; child; child = child.nextSibling) {
		collectLeafSpans(
			child,
			source,
			resolveFieldPath,
			resolveUserPropertySlug,
			resolveSearchInputName,
			spans,
		);
	}
}

function classifyHashtag(
	node: SyntaxNode,
	source: string,
	resolveFieldPath: ResolveFieldPath,
	resolveUserPropertySlug: ResolveUserPropertySlug,
	resolveSearchInputName: ResolveSearchInputName,
): XPathPart | XPathUnresolvedReference | undefined {
	const nsNode = node.getChild(T.HashtagType.name);
	if (!nsNode) return undefined;
	const namespace = source.slice(nsNode.from, nsNode.to);
	const segments = node
		.getChildren(T.HashtagSegment.name)
		.map((segment) => source.slice(segment.from, segment.to));
	if (segments.length === 0) return undefined;

	if (namespace === "form") {
		const uuid = resolveFieldPath(segments);
		if (uuid !== undefined) return { kind: "field-ref", uuid: asUuid(uuid) };
		return { kind: "unresolved-reference", namespace, segments };
	}
	if (namespace === "user") {
		if (segments.length === 1) {
			const uuid = resolveUserPropertySlug(segments[0]);
			return uuid === undefined
				? { kind: "user-ref", property: segments[0] }
				: {
						kind: "user-property-ref",
						userPropertyUuid: asUuid(uuid),
					};
		}
		return { kind: "unresolved-reference", namespace, segments };
	}
	if (namespace === "case") {
		// CommCare-private projection vocabulary, not a canonical
		// `(caseType, property)` identity. It cannot enter authored storage.
		return { kind: "unresolved-reference", namespace, segments };
	}
	if (namespace === "search") {
		// A search answer carried into a no-matches registration form. The
		// namespace is reserved (`RESERVED_CASE_TYPE_NAMES`), so it never
		// falls through to the case-ref arm below.
		if (segments.length === 1) {
			const uuid = resolveSearchInputName(segments[0]);
			if (uuid !== undefined) {
				return { kind: "search-answer-ref", searchInputUuid: asUuid(uuid) };
			}
		}
		return { kind: "unresolved-reference", namespace, segments };
	}
	if (segments.length === 1) {
		return { kind: "case-ref", caseType: namespace, property: segments[0] };
	}
	return { kind: "unresolved-reference", namespace, segments };
}

/**
 * Claim an absolute `/data/...` step chain as a `path-ref` leaf. The
 * chain must be PURE — its whole span is exactly `/`-or-`//` separator
 * runs (whitespace allowed around them) interleaved with the collected
 * name steps, verified by reconstruction so a predicate, axis step,
 * wildcard, or function call anywhere in the chain disqualifies it —
 * and the id path after `data` must FULLY resolve. Separator spellings are
 * accepted by the human text parser but never stored; printing is canonical.
 */
function classifyDataPath(
	node: SyntaxNode,
	source: string,
	resolveFieldPath: ResolveFieldPath,
): LeafSpan | undefined {
	const collected: Array<{ text: string; from: number; to: number }> = [];
	collectSegments(node, source, collected);
	if (collected.length < 2 || collected[0].text !== "data") return undefined;
	const unresolved = (): LeafSpan => ({
		from: node.from,
		to: node.to,
		part: {
			kind: "unresolved-reference",
			namespace: "data",
			segments: collected.slice(1).map((segment) => segment.text),
		},
	});

	// Reconstruction check: every inter-segment run must be a single
	// `/` or `//` with only whitespace around it, the span must start
	// at its first separator, and end exactly at the last segment.
	let cursor = node.from;
	for (const segment of collected) {
		if (segment.from < cursor) return unresolved();
		const sep = source.slice(cursor, segment.from);
		if (!/^\s*\/\s*$/.test(sep)) return unresolved();
		cursor = segment.to;
	}
	if (cursor !== node.to) return unresolved();

	const uuid = resolveFieldPath(collected.slice(1).map((s) => s.text));
	if (uuid === undefined) return unresolved();
	return {
		from: node.from,
		to: node.to,
		part: { kind: "path-ref", uuid: asUuid(uuid) },
	};
}

/** Collect plain name steps with positions from a path chain —
 *  the extractor/rewriters' collection rule: recurse nested
 *  Child/Descendant nodes, take `NameTest`s and bare leaf tokens,
 *  skip slashes; compound steps (predicates, axes, calls) contribute
 *  nothing and are caught by the reconstruction check above. */
function collectSegments(
	node: SyntaxNode,
	source: string,
	segments: Array<{ text: string; from: number; to: number }>,
): void {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (T.Children.has(child.type) || T.Descendants.has(child.type)) {
			collectSegments(child, source, segments);
		} else if (child.type === T.RootPath || child.type === T.Slash) {
			// Separators — reconstructed from source slices, not collected.
		} else if (child.type === T.NameTest) {
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
