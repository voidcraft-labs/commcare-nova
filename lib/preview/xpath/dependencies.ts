import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

// Pre-resolve node types for zero string comparisons at runtime
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
		Error: one("⚠"),
	};
})();

/**
 * Extract all /data/... path references from an XPath expression.
 * Used by TriggerDAG to build dependency edges.
 *
 * - Collects absolute paths (/data/question_id, /data/group/child)
 * - Translates #form/question_id → /data/question_id
 * - Ignores typed case refs, #user/, and #search/ refs (external during form entry)
 */
export function extractPathRefs(expr: string, originPath?: string): string[] {
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
					refs.add(`/data/${text.slice(6)}`);
				}
				// Typed case refs, #user/, and #search/ are external — skip.
			}
		},
	});

	// Collect absolute paths by walking for path patterns starting with /
	// We look for Child or RootPath nodes that build /data/... paths
	function walkPaths(node: SyntaxNode) {
		// current() retains the evaluating question's context inside predicates.
		// Query-row attributes are real dependencies, even though they are not
		// authored questions. Resolve the parsed path, never its printed text.
		const currentPath =
			originPath === undefined
				? undefined
				: resolveCurrentPath(node, expr, originPath);
		if (currentPath?.startsWith("/data/")) refs.add(currentPath);
		// Try to build a full path from this node
		const path = tryBuildPath(node, expr);
		if (path?.startsWith("/data/")) {
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

/**
 * The positions of every read of the form's root alone: a path whose steps
 * are the one name `data` from the root (`/data`, `count(/data)`,
 * `/data[1]`), read through Nova's XPath grammar. A path that goes on below
 * the root (`/data/a`, `/data/@name`, `/data[1]/a`) is a read of what is
 * under it, and `//data`, `../data`, `current()/data` and `/database` are
 * not rooted at the form. The root is the whole form, never a question, a
 * number of rows or a list of ids.
 */
export function formRootReadPositions(expr: string): number[] {
	if (!expr) return [];
	const positions: number[] = [];
	parser.parse(expr).iterate({
		enter(node) {
			if (!T.Children.has(node.type)) return;
			const slash = node.node.firstChild;
			const name = slash?.nextSibling;
			if (
				slash?.type !== T.Slash ||
				name?.type !== T.NameTest ||
				name.nextSibling !== null ||
				expr.slice(name.from, name.to) !== "data"
			)
				return;
			if (continuesBelow(node.node)) return;
			positions.push(node.from);
		},
	});
	return positions;
}

/** Whether `path` is the left part of a longer path, through any filter
 * that wraps it (`/data[1]/a`). */
function continuesBelow(path: SyntaxNode): boolean {
	let left = path;
	let parent = left.parent;
	while (
		parent !== null &&
		parent.name === "Filtered" &&
		parent.firstChild?.from === left.from &&
		parent.firstChild.to === left.to
	) {
		left = parent;
		parent = left.parent;
	}
	if (parent === null) return false;
	if (!T.Children.has(parent.type) && !T.Descendants.has(parent.type))
		return false;
	return (
		parent.firstChild?.from === left.from && parent.firstChild.to === left.to
	);
}

function resolveCurrentPath(
	node: SyntaxNode,
	source: string,
	origin: string,
): string | undefined {
	if (node.name === "Invoke") {
		const name = node.getChild("FunctionName");
		return name && source.slice(name.from, name.to) === "current"
			? origin
			: undefined;
	}
	if (!T.Children.has(node.type)) return undefined;
	const left = node.firstChild;
	const right = node.lastChild;
	if (!left || !right || left === right) return undefined;
	const base = resolveCurrentPath(left, source, origin);
	if (base === undefined) return undefined;
	if (right.name === "ParentStep") return base.slice(0, base.lastIndexOf("/"));
	if (right.name === "SelfStep") return base;
	if (right.type === T.NameTest)
		return `${base}/${source.slice(right.from, right.to)}`;
	if (right.name === "AttrSpecified") {
		const name = right.getChild("NameTest");
		if (name) return `${base}/@${source.slice(name.from, name.to)}`;
	}
	return undefined;
}

/** Try to build a path string from a node that represents a path expression. */
function tryBuildPath(node: SyntaxNode, source: string): string | null {
	// Only process Child (/) and Descendant (//) path nodes
	if (!T.Children.has(node.type) && !T.Descendants.has(node.type)) return null;

	const segments: string[] = [];
	collectPathSegments(node, source, segments);

	if (segments.length === 0) return null;
	const path = `/${segments.join("/")}`;
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
