import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/codemirror/xpath-parser";

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
 * Rewrite question path references in an XPath expression.
 *
 * Uses the Lezer parser to find exact source positions of path segments
 * and hashtag references, then surgically replaces matching occurrences.
 *
 * Handles:
 * - Absolute paths: /data/old_id → /data/new_id (and /data/group/old_id → /data/group/new_id)
 * - Hashtag refs: #form/old_id → #form/new_id (top-level questions only)
 *
 * @param expr       The XPath expression to rewrite
 * @param oldPath    The old question path segments (e.g. 'old_id' or 'group/old_id')
 * @param newId      The new question ID (replaces the final segment)
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

	// Walk for hashtag refs (#form/old_id) — only for top-level questions
	if (oldSegments.length === 1) {
		walkForHashtags(tree.topNode, expr, "#form/", oldSegments[0], newId, edits);
	}

	return applyEdits(expr, edits);
}

/**
 * Rewrite hashtag references in an XPath expression.
 *
 * Uses the Lezer parser to find HashtagRef nodes matching the given prefix
 * (e.g. '#case/', '#form/') and surgically replaces the name portion.
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
	walkForHashtags(tree.topNode, expr, prefix, oldName, newName, edits);
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
				// Replace the final segment (the question ID)
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
 * Walk the CST for hashtag refs matching prefix + oldName.
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
			// Replace just the name portion after the prefix
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
