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
 * just the final NameTest) with `[data, ...newSegments]`. For hashtag
 * refs, we only rewrite when BOTH `oldSegments` and `newSegments` have
 * length 1 (top-level → top-level rename); every other case is a DROP —
 * a hashtag ref can't encode nested paths, so a cross-depth move makes
 * the reference dangling. The caller gets a count of how many of these
 * drops were detected so downstream UI can surface the loss.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/codemirror/xpath-parser";

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
 * Result of rewriting one expression on a move.
 *
 * `droppedHashtagRefs` counts hashtag refs that pointed at the moved
 * field's old id but could not be rewritten because either the old or
 * new path has depth > 1 (hashtag syntax only encodes a single top-level
 * name). Those refs are now dangling; the caller can surface the count
 * so users know something broke silently.
 */
export interface RewriteOnMoveResult {
	expr: string;
	droppedHashtagRefs: number;
}

/**
 * Rewrite all absolute path references in `expr` whose segments match
 * `oldSegments` (below the `/data` root) to the equivalent path with
 * `newSegments`. Top-level hashtag refs are rewritten only when both
 * segment sequences are length 1; otherwise they are counted as dropped.
 *
 * @param expr           XPath expression to rewrite
 * @param oldSegments    Segments below `/data` in the field's old path
 * @param newSegments    Segments below `/data` in the field's new path
 * @returns              Rewritten expression plus count of dropped hashtag
 *                       references (unreachable via hashtag syntax).
 */
export function rewriteXPathOnMove(
	expr: string,
	oldSegments: string[],
	newSegments: string[],
): RewriteOnMoveResult {
	if (!expr) return { expr, droppedHashtagRefs: 0 };

	const tree = parser.parse(expr);
	const edits: SourceEdit[] = [];

	// Absolute paths start with `/data/…`, so the full target segment
	// sequence is `["data", ...oldSegments]`.
	const targetAbsOld = ["data", ...oldSegments];

	walkForAbsolutePaths(tree.topNode, expr, targetAbsOld, newSegments, edits);

	// Hashtag refs (`#form/field_id`) only encode a single top-level field
	// name — they can't represent nested group paths.
	//   - Both sides top-level (length 1): rewrite the name.
	//   - Either side nested (length > 1): count matches as dropped.
	// The old-id leaf is the last `oldSegments` element in both cases —
	// that's what a hashtag would have pointed at before the move.
	const oldLeaf = oldSegments[oldSegments.length - 1] ?? "";
	const canRewriteHashtag =
		oldSegments.length === 1 && newSegments.length === 1;
	let droppedHashtagRefs = 0;
	if (oldLeaf) {
		if (canRewriteHashtag) {
			walkForHashtags(
				tree.topNode,
				expr,
				"#form/",
				oldLeaf,
				newSegments[0],
				edits,
			);
		} else {
			droppedHashtagRefs = countHashtagMatches(
				tree.topNode,
				expr,
				"#form/",
				oldLeaf,
			);
		}
	}

	return { expr: applyEdits(expr, edits), droppedHashtagRefs };
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
 * Walk the CST for hashtag refs matching `prefix + oldName`.
 * Records an edit on the name portion (after the prefix).
 */
function walkForHashtags(
	node: SyntaxNode,
	source: string,
	prefix: string,
	oldName: string,
	newName: string,
	edits: SourceEdit[],
): void {
	if (node.type === T.HashtagRef) {
		const text = source.slice(node.from, node.to);
		if (text === prefix + oldName) {
			const nameStart = node.from + prefix.length;
			edits.push({ from: nameStart, to: node.to, text: newName });
		}
		return;
	}

	let child = node.firstChild;
	while (child) {
		walkForHashtags(child, source, prefix, oldName, newName, edits);
		child = child.nextSibling;
	}
}

/**
 * Count hashtag refs matching `prefix + oldName` without rewriting them.
 * Used when the caller detected that a rewrite isn't possible (e.g. a
 * cross-depth move whose new path can't be expressed as a hashtag) and
 * just wants to know how many references were dropped.
 */
function countHashtagMatches(
	node: SyntaxNode,
	source: string,
	prefix: string,
	oldName: string,
): number {
	if (node.type === T.HashtagRef) {
		const text = source.slice(node.from, node.to);
		return text === prefix + oldName ? 1 : 0;
	}
	let count = 0;
	let child = node.firstChild;
	while (child) {
		count += countHashtagMatches(child, source, prefix, oldName);
		child = child.nextSibling;
	}
	return count;
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
