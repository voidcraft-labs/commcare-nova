import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

// Pre-resolve node types — same pattern as dependencies.ts
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
 * Rewrite field path references in an XPath expression.
 *
 * Uses the Lezer parser to find exact source positions of path segments
 * and hashtag references, then surgically replaces matching occurrences.
 *
 * Handles:
 * - Absolute paths: /data/old_id → /data/new_id (and /data/group/old_id → /data/group/new_id)
 * - Hashtag refs: #form/old_id → #form/new_id, at any depth
 *   (#form/group/old_id → #form/group/new_id). The FULL segment path must
 *   match — a cousin sharing the leaf id under a different group is never
 *   rewritten.
 *
 * @param expr       The XPath expression to rewrite
 * @param oldPath    The old field path segments (e.g. 'old_id' or 'group/old_id')
 * @param newId      The new field ID (replaces the final segment)
 */
export function rewriteXPathRefs(
	expr: string,
	oldPath: string,
	newId: string,
): string {
	if (!expr) return expr;

	const tree = parser.parse(expr);
	const edits: SourceEdit[] = [];

	const oldSegments = oldPath.split("/");
	const targetAbsSegments = ["data", ...oldSegments];

	// Walk for absolute paths (/data/...)
	walkForPaths(tree.topNode, expr, targetAbsSegments, newId, edits);

	// Walk for hashtag refs (#form/<oldPath>) — full-path match, leaf rewrite.
	const newSegments = [...oldSegments.slice(0, -1), newId];
	walkForHashtags(
		tree.topNode,
		expr,
		`#form/${oldPath}`,
		`#form/${newSegments.join("/")}`,
		edits,
	);

	return applyEdits(expr, edits);
}

/**
 * Rewrite hashtag references in an XPath expression.
 *
 * Uses the Lezer parser to find HashtagRef nodes whose full text equals
 * `prefix + oldName` (e.g. '#case/' + 'age') and surgically replaces each
 * with `prefix + newName`.
 *
 * @param expr       The XPath expression to rewrite
 * @param prefix     The hashtag prefix to match (e.g. '#case/', '#form/')
 * @param oldName    The old name after the prefix
 * @param newName    The new name to replace it with
 */
export function rewriteHashtagRefs(
	expr: string,
	prefix: string,
	oldName: string,
	newName: string,
): string {
	if (!expr) return expr;

	const tree = parser.parse(expr);
	const edits: SourceEdit[] = [];
	walkForHashtags(
		tree.topNode,
		expr,
		prefix + oldName,
		prefix + newName,
		edits,
	);
	return applyEdits(expr, edits);
}

// ── Tree walkers ──────────────────────────────────────────────────────

/**
 * Walk the CST for absolute path expressions matching targetSegments.
 * When found, record an edit on the final NameTest node.
 */
function walkForPaths(
	node: SyntaxNode,
	source: string,
	targetSegments: string[],
	newId: string,
	edits: SourceEdit[],
): void {
	// Try to match this node as a path expression
	if (T.Children.has(node.type) || T.Descendants.has(node.type)) {
		const collected: Array<{ text: string; from: number; to: number }> = [];
		collectSegmentsWithPositions(node, source, collected);

		if (collected.length === targetSegments.length) {
			const matches = collected.every(
				(seg, i) => seg.text === targetSegments[i],
			);
			if (matches) {
				// Replace the final segment (the field ID)
				const last = collected[collected.length - 1];
				edits.push({ from: last.from, to: last.to, text: newId });
				return; // Don't recurse into matched path's children
			}
		}
	}

	// Recurse
	let child = node.firstChild;
	while (child) {
		walkForPaths(child, source, targetSegments, newId, edits);
		child = child.nextSibling;
	}
}

/**
 * Walk the CST for hashtag refs whose full text equals `oldRef` and record
 * an edit replacing the whole ref with `newRef`. Full-text matching keeps
 * the rewrite path-exact: `#form/group/old` never matches `#form/old` or a
 * cousin's `#form/other/old`.
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
 * Mirrors collectPathSegments from dependencies.ts but retains positions.
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
			// Skip slash tokens
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
