// lib/commcare/xpath/expressionAst.ts
//
// The parser half of the expression round-trip pair: source text →
// stored `XPathExpression` (shape, printer, and walks live in
// `lib/domain/xpath`). The Lezer grammar locates the reference-shaped
// spans — hashtag refs and absolute `/data/...` chains — and
// everything between them is kept as verbatim text runs, so
// `printXPath(parseXPathExpression(s, ctx), printCtx)` reproduces `s`
// byte-identically for EVERY input string over an unrenamed doc (the
// fuzz-pinned law that makes stored-expression migration provably
// byte-safe).
//
// Reference classification mirrors the long-standing extractor/rewriter
// rules exactly — an identity leaf is minted precisely where a rename
// would have rewritten text:
//
//   - `#form/<path>` with a FULL id-path resolution → `field-ref`.
//     Partial/failed resolution stays a `raw-ref` (it was dangling;
//     it keeps printing its original text).
//   - `/data/<path>` as a PURE step chain (only `/`-or-`//` separators
//     and plain name steps — a predicate, axis, or function call
//     breaks the chain, exactly as it broke segment collection before)
//     with a full resolution → `path-ref`, separators kept byte-exact.
//   - `#<type>/<prop>` (one segment, explicit namespace) → `case-ref`.
//     Case properties are name-keyed; the name pair IS the identity,
//     so no doc lookup gates this.
//   - `#user/<prop>` → `user-ref`.
//   - `#case/...` (contextual — follows the module's CURRENT type
//     rather than naming one), multi-segment non-form shapes, and
//     unknown namespaces → `raw-ref`, verbatim.
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
	type XPathExpression,
	type XPathPart,
} from "@/lib/domain";
import { parser } from "./parser";

export type { ResolveFieldPath };

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
	part: XPathPart;
}

/**
 * Parse one expression source to its stored AST, resolving form-local
 * references through `resolveFieldPath` (build one with
 * `fieldPathResolver(doc, formUuid)` from `lib/domain`).
 */
export function parseXPathExpression(
	source: string,
	resolveFieldPath: ResolveFieldPath,
): XPathExpression {
	if (source.length === 0) return { parts: [] };
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
	if (hasError) return opaqueXPathExpression(source);

	const spans: LeafSpan[] = [];
	collectLeafSpans(tree.topNode, source, resolveFieldPath, spans);
	spans.sort((a, b) => a.from - b.from);

	const parts: XPathPart[] = [];
	let cursor = 0;
	for (const span of spans) {
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
	return { parts };
}

function collectLeafSpans(
	node: SyntaxNode,
	source: string,
	resolveFieldPath: ResolveFieldPath,
	spans: LeafSpan[],
): void {
	if (node.type === T.HashtagRef) {
		const part = classifyHashtag(node, source, resolveFieldPath);
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
		collectLeafSpans(child, source, resolveFieldPath, spans);
	}
}

function classifyHashtag(
	node: SyntaxNode,
	source: string,
	resolveFieldPath: ResolveFieldPath,
): XPathPart | undefined {
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
		return { kind: "raw-ref", namespace, segments };
	}
	if (namespace === "user") {
		if (segments.length === 1) {
			return { kind: "user-ref", property: segments[0] };
		}
		return { kind: "raw-ref", namespace, segments };
	}
	if (namespace === "case") {
		// Contextual — follows the owning module's CURRENT case type
		// rather than naming one. Transitional authoring shape; stays raw
		// so a module retype changes what it MEANS without touching it.
		return { kind: "raw-ref", namespace, segments };
	}
	if (segments.length === 1) {
		return { kind: "case-ref", caseType: namespace, property: segments[0] };
	}
	return { kind: "raw-ref", namespace, segments };
}

/**
 * Claim an absolute `/data/...` step chain as a `path-ref` leaf. The
 * chain must be PURE — its whole span is exactly `/`-or-`//` separator
 * runs (whitespace allowed around them) interleaved with the collected
 * name steps, verified by reconstruction so a predicate, axis step,
 * wildcard, or function call anywhere in the chain disqualifies it —
 * and the id path after `data` must FULLY resolve.
 */
function classifyDataPath(
	node: SyntaxNode,
	source: string,
	resolveFieldPath: ResolveFieldPath,
): LeafSpan | undefined {
	const collected: Array<{ text: string; from: number; to: number }> = [];
	collectSegments(node, source, collected);
	if (collected.length < 2 || collected[0].text !== "data") return undefined;

	// Reconstruction check: every inter-segment run must be a single
	// `/` or `//` with only whitespace around it, the span must start
	// at its first separator, and end exactly at the last segment.
	const seps: string[] = [];
	let cursor = node.from;
	for (const segment of collected) {
		if (segment.from < cursor) return undefined;
		const sep = source.slice(cursor, segment.from);
		if (!/^\s*\/{1,2}\s*$/.test(sep)) return undefined;
		seps.push(sep);
		cursor = segment.to;
	}
	if (cursor !== node.to) return undefined;

	const uuid = resolveFieldPath(collected.slice(1).map((s) => s.text));
	if (uuid === undefined) return undefined;
	return {
		from: node.from,
		to: node.to,
		part: { kind: "path-ref", uuid: asUuid(uuid), seps },
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
