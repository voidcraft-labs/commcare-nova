import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/codemirror/xpath-parser";

// Pre-resolve node types for zero string comparisons at runtime
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => all.find((t) => t.name === name)!;
	const many = (name: string) => new Set(all.filter((t) => t.name === name));
	return {
		Children: many("Child"),
		Descendants: many("Descendant"),
		NameTest: one("NameTest"),
		RootPath: one("RootPath"),
		HashtagRef: one("HashtagRef"),
		Slash: one("/"),
		Error: one("⚠"),
	};
})();

/**
 * Extract all /data/... path references from an XPath expression.
 * Used by TriggerDAG to build dependency edges.
 *
 * - Collects absolute paths (/data/question_id, /data/group/child)
 * - Translates #form/question_id → /data/question_id
 * - Ignores #case/ and #user/ refs (external, don't change during form entry)
 */
export function extractPathRefs(expr: string): string[] {
	if (!expr) return [];

	const tree = parser.parse(expr);
	const refs = new Set<string>();

	// Collect hashtag refs
	tree.iterate({
		enter(node) {
			if (node.type === T.HashtagRef) {
				const text = expr.slice(node.from, node.to);
				if (text.startsWith("#form/")) {
					// #form/question_id → /data/question_id
					refs.add("/data/" + text.slice(6));
				}
				// #case/ and #user/ are external — skip
			}
		},
	});

	// Collect absolute paths by walking for path patterns starting with /
	// We look for Child or RootPath nodes that build /data/... paths
	function walkPaths(node: SyntaxNode) {
		// Try to build a full path from this node
		const path = tryBuildPath(node, expr);
		if (path && path.startsWith("/data/")) {
			refs.add(path);
		}

		// Recurse into children
		let child = node.firstChild;
		while (child) {
			walkPaths(child);
			child = child.nextSibling;
		}
	}

	walkPaths(tree.topNode);
	return Array.from(refs);
}

/** Try to build a path string from a node that represents a path expression. */
function tryBuildPath(node: SyntaxNode, source: string): string | null {
	// Only process Child (/) and Descendant (//) path nodes
	if (!T.Children.has(node.type) && !T.Descendants.has(node.type)) return null;

	const segments: string[] = [];
	collectPathSegments(node, source, segments);

	if (segments.length === 0) return null;
	const path = "/" + segments.join("/");
	return path;
}

function collectPathSegments(
	node: SyntaxNode,
	source: string,
	segments: string[],
): void {
	let child = node.firstChild;
	while (child) {
		if (T.Children.has(child.type) || T.Descendants.has(child.type)) {
			// Recurse into nested path
			collectPathSegments(child, source, segments);
		} else if (child.type === T.RootPath || child.type === T.Slash) {
			// Skip the slash tokens themselves
		} else if (child.type === T.NameTest) {
			// This is a path segment name
			segments.push(source.slice(child.from, child.to));
		} else if (!child.firstChild) {
			// Leaf node that's a step name
			const text = source.slice(child.from, child.to);
			if (text !== "/" && text !== "//") {
				segments.push(text);
			}
		}
		child = child.nextSibling;
	}
}
