/**
 * Path-to-path xpath rewriter for moveField.
 *
 * `lib/preview/xpath/rewrite.ts` handles LEAF-RENAME (field kept in
 * place, last path segment changes). This helper handles PREFIX-SWAP or
 * FULL-PATH-SWAP: the field moves to a different location and its
 * absolute path segments change (possibly at any depth).
 *
 * The Lezer walk helpers are shared with that module (imported from it —
 * the mutation reducers already consume its rename rewriters, see
 * `fields.ts`): segment collection, the `#form/` prefix walker, and edit
 * application are one implementation, so a fix to segment matching lands
 * on the rename and move paths together. Only the absolute-path matcher
 * differs: a move replaces the ENTIRE matched segment sequence with
 * `[data, ...newSegments]` (depth can change), where a rename edits the
 * final NameTest in place.
 *
 * Hashtag refs re-anchor by segment PREFIX: a `#form/` ref whose leading
 * segments equal `oldSegments` has that prefix replaced with
 * `newSegments`, keeping any descendant tail — hashtag paths mirror the
 * form's group nesting, so a cross-depth move changes the ref's depth
 * with it (`#form/foo` → `#form/group/foo` and the reverse), and moving
 * a CONTAINER re-anchors refs to its descendants too (`#form/grp/child`
 * → `#form/outer/grp/child`), matching what the nested-CST recursion
 * already gives absolute paths for free.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";
import {
	applyEdits,
	collectSegmentsWithPositions,
	type SourceEdit,
	walkForFormHashtagPrefix,
} from "@/lib/preview/xpath/rewrite";

/**
 * Pre-resolved Lezer node types — cached at module load so the walker
 * avoids name-string lookups on every tree visit.
 */
const T = (() => {
	const all = parser.nodeSet.types;
	const many = (name: string) => new Set(all.filter((t) => t.name === name));
	return {
		Children: many("Child"),
		Descendants: many("Descendant"),
	};
})();

/**
 * Rewrite all references in `expr` that point at the moved field's old
 * location to the equivalent reference at its new location:
 *
 *   - absolute paths whose segments match `oldSegments` (below the `/data`
 *     root) — or have them as a PREFIX, for refs to a moved container's
 *     descendants — re-anchor onto the `newSegments` path, and
 *   - `#form/` hashtag refs whose leading segments match `oldSegments`
 *     re-anchor that prefix to `#form/<newSegments>` (descendant tails
 *     kept) — across any old/new depth.
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

	// Hashtag refs re-anchor by segment prefix: descendants of a moved
	// container keep their tail below the re-anchored prefix.
	walkForFormHashtagPrefix(tree.topNode, expr, oldSegments, newSegments, edits);

	return applyEdits(expr, edits);
}

// ── Tree walker ───────────────────────────────────────────────────────

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
