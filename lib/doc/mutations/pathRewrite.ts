/**
 * Path-to-path xpath rewriter for moveField.
 *
 * `lib/preview/xpath/rewrite.ts` handles LEAF-RENAME (field kept in
 * place, last path segment changes). This helper handles PREFIX-SWAP or
 * FULL-PATH-SWAP: the field moves to a different location and its
 * absolute path segments change (possibly at any depth).
 *
 * Implementation reuses the same Lezer walk used by `rewriteXPathRefs` —
 * we match absolute paths whose collected segments exactly equal
 * `[data, ...oldSegments]` and replace the entire segment sequence (not
 * just the final NameTest) with `[data, ...newSegments]`. Hashtag refs
 * re-anchor the same way: a ref whose full text is `#form/<oldSegments>`
 * becomes `#form/<newSegments>` — hashtag paths mirror the form's group
 * nesting, so a cross-depth move changes the ref's depth with it
 * (`#form/foo` → `#form/group/foo` and the reverse).
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

/**
 * Pre-resolved Lezer node types — cached at module load so the walker
 * avoids name-string lookups on every tree visit.
 */
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
		Slash: one("/"),
	};
})();

/** A positional edit in the source string. */
interface SourceEdit {
	from: number;
	to: number;
	text: string;
}

/** Apply edits in reverse position order to preserve offsets. */
function applyEdits(source: string, edits: SourceEdit[]): string {
	if (edits.length === 0) return source;
	edits.sort((a, b) => b.from - a.from);
	let result = source;
	for (const edit of edits) {
		result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
	}
	return result;
}

/**
 * Rewrite all references in `expr` that point at the moved field's old
 * location to the equivalent reference at its new location:
 *
 *   - absolute paths whose segments match `oldSegments` (below the `/data`
 *     root) become the `newSegments` path, and
 *   - `#form/` hashtag refs whose full segment path matches `oldSegments`
 *     re-anchor to `#form/<newSegments>` — across any old/new depth.
 *
 * @param expr           XPath expression to rewrite
 * @param oldSegments    Segments below `/data` in the field's old path
 * @param newSegments    Segments below `/data` in the field's new path
 * @returns              The rewritten expression.
 */
export function rewriteXPathOnMove(
	expr: string,
	oldSegments: string[],
	newSegments: string[],
): string {
	if (!expr) return expr;

	const tree = parser.parse(expr);
	const edits: SourceEdit[] = [];

	// Absolute paths start with `/data/…`, so the full target segment
	// sequence is `["data", ...oldSegments]`.
	const targetAbsOld = ["data", ...oldSegments];

	walkForAbsolutePaths(tree.topNode, expr, targetAbsOld, newSegments, edits);

	// Hashtag refs re-anchor whole: full-path match on the old location,
	// full replacement with the new one.
	walkForHashtags(
		tree.topNode,
		expr,
		`#form/${oldSegments.join("/")}`,
		`#form/${newSegments.join("/")}`,
		edits,
	);

	return applyEdits(expr, edits);
}

// ── Tree walkers ──────────────────────────────────────────────────────

/**
 * Walk the CST for absolute path expressions matching `targetSegments`.
 * When found, replace everything after `/data/` with the new segments
 * joined by `/`. This handles paths that change depth (e.g. a top-level
 * field moving into a group gains a prefix segment).
 */
function walkForAbsolutePaths(
	node: SyntaxNode,
	source: string,
	targetSegments: string[],
	newSegmentsBelowData: string[],
	edits: SourceEdit[],
): void {
	if (T.Children.has(node.type) || T.Descendants.has(node.type)) {
		const collected: Array<{ text: string; from: number; to: number }> = [];
		collectSegmentsWithPositions(node, source, collected);

		if (
			collected.length === targetSegments.length &&
			collected.every((seg, i) => seg.text === targetSegments[i])
		) {
			// Replace the entire span from the first segment after "data" through
			// the last segment with the new path. This correctly handles paths
			// that change depth (different number of old vs new segments).
			const firstAfterData = collected[1];
			const last = collected[collected.length - 1];
			const replacement = newSegmentsBelowData.join("/");
			edits.push({
				from: firstAfterData.from,
				to: last.to,
				text: replacement,
			});
			return; // Don't recurse into matched path's children.
		}
	}

	let child = node.firstChild;
	while (child) {
		walkForAbsolutePaths(
			child,
			source,
			targetSegments,
			newSegmentsBelowData,
			edits,
		);
		child = child.nextSibling;
	}
}

/**
 * Walk the CST for hashtag refs whose full text equals `oldRef` and record
 * an edit replacing the whole ref with `newRef`. Full-text matching keeps
 * the re-anchor path-exact: `#form/source` never matches a moved
 * `grp/source` (same leaf, different field).
 */
function walkForHashtags(
	node: SyntaxNode,
	source: string,
	oldRef: string,
	newRef: string,
	edits: SourceEdit[],
): void {
	if (node.type === T.HashtagRef) {
		const text = source.slice(node.from, node.to);
		if (text === oldRef) {
			edits.push({ from: node.from, to: node.to, text: newRef });
		}
		return;
	}

	let child = node.firstChild;
	while (child) {
		walkForHashtags(child, source, oldRef, newRef, edits);
		child = child.nextSibling;
	}
}

// ── Segment collection ────────────────────────────────────────────────

/**
 * Collect path segments with their source positions from a path node.
 * Mirrors the identically-named function in `lib/preview/xpath/rewrite.ts`
 * — duplicated intentionally so this module stands alone without coupling
 * to the preview layer.
 */
function collectSegmentsWithPositions(
	node: SyntaxNode,
	source: string,
	segments: Array<{ text: string; from: number; to: number }>,
): void {
	let child = node.firstChild;
	while (child) {
		if (T.Children.has(child.type) || T.Descendants.has(child.type)) {
			collectSegmentsWithPositions(child, source, segments);
		} else if (child.type === T.RootPath || child.type === T.Slash) {
			// Skip slash tokens.
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
		child = child.nextSibling;
	}
}
