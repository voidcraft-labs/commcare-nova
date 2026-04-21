import type { NodeType, SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

// --------------- Types ---------------

enum Layout {
	Space,
	NewLine,
	Tab,
}

type FormatNode = {
	type: NodeType | Layout;
	text?: string;
	children?: FormatNode[];
};

// --------------- Node Types ---------------

// Pre-resolved from the parser's nodeSet for typed comparisons
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Unknown node type: ${name}`);
		return found;
	};
	const many = (name: string) => new Set(all.filter((t) => t.name === name));

	return {
		// Composite
		ArgumentList: one("ArgumentList"),
		Filtered: one("Filtered"),
		AndExpr: one("AndExpr"),
		OrExpr: one("OrExpr"),
		AddExpr: one("AddExpr"),
		SubtractExpr: one("SubtractExpr"),
		MultiplyExpr: one("MultiplyExpr"),
		UnionExpr: one("UnionExpr"),
		EqualsExpr: one("EqualsExpr"),
		NotEqualsExpr: one("NotEqualsExpr"),
		LessThanExpr: one("LessThanExpr"),
		LessEqualExpr: one("LessEqualExpr"),
		GreaterThanExpr: one("GreaterThanExpr"),
		GreaterEqualExpr: one("GreaterEqualExpr"),
		DivideExpr: one("DivideExpr"),
		ModulusExpr: one("ModulusExpr"),
		// Tokens
		OpenParen: one("("),
		CloseParen: one(")"),
		OpenBracket: one("["),
		CloseBracket: one("]"),
		Comma: one(","),
		Plus: one("+"),
		Minus: one("-"),
		Star: one("*"),
		Pipe: one("|"),
		Gt: one(">"),
		Gte: one(">="),
		Lt: one("<"),
		Lte: one("<="),
		Eq: one("="),
		Neq: one("!="),
		Error: one("⚠"),
		// Multi-instance (Keyword appears once per binary expr type that uses it)
		Keywords: many("Keyword"),
	};
})();

const SPACED_PARENTS = new Set<NodeType>([
	T.AddExpr,
	T.SubtractExpr,
	T.MultiplyExpr,
	T.UnionExpr,
	T.EqualsExpr,
	T.NotEqualsExpr,
	T.LessThanExpr,
	T.LessEqualExpr,
	T.GreaterThanExpr,
	T.GreaterEqualExpr,
	T.AndExpr,
	T.OrExpr,
	T.DivideExpr,
	T.ModulusExpr,
]);

const OPERATORS = new Set<NodeType>([
	T.Plus,
	T.Minus,
	T.Star,
	T.Pipe,
	T.Gt,
	T.Gte,
	T.Lt,
	T.Lte,
	T.Eq,
	T.Neq,
	...T.Keywords,
]);

// --------------- Phase 1: Format ---------------

/** Should a Space be inserted between prev and curr inside this parent? */
function needsSpace(
	parent: SyntaxNode,
	prev: SyntaxNode,
	curr: SyntaxNode,
): boolean {
	if (SPACED_PARENTS.has(parent.type)) {
		if (OPERATORS.has(curr.type) || OPERATORS.has(prev.type)) return true;
		return false;
	}

	if (parent.type === T.ArgumentList && prev.type === T.Comma) return true;

	return false;
}

/** Walk the Lezer tree and produce a FormatNode tree with Layout tokens inserted. */
function format(node: SyntaxNode, source: string): FormatNode {
	// Leaf: source token
	if (!node.firstChild) {
		return { type: node.type, text: source.slice(node.from, node.to) };
	}

	// Composite: format children, insert Layout.Space where needed
	const result: FormatNode[] = [];
	let child: SyntaxNode | null = node.firstChild;

	while (child) {
		if (result.length > 0) {
			const last = result[result.length - 1];
			const prev = child.prevSibling;
			if (prev && last.type !== Layout.Space && needsSpace(node, prev, child)) {
				result.push({ type: Layout.Space });
			}
		}

		result.push(format(child, source));
		child = child.nextSibling;
	}

	return { type: node.type, children: result };
}

// --------------- Phase 2: Render ---------------

const LAYOUT_TEXT: Record<Layout, string> = {
	[Layout.Space]: " ",
	[Layout.NewLine]: "\n",
	[Layout.Tab]: "    ",
};

function render(node: FormatNode): string {
	if (typeof node.type === "number") return LAYOUT_TEXT[node.type];
	if (node.text !== undefined) return node.text;
	return node.children?.map(render).join("") ?? "";
}

// --------------- Public API ---------------

export function formatXPath(expr: string): string {
	const trimmed = expr.trim();
	if (!trimmed) return expr;

	const tree = parser.parse(trimmed);

	let hasError = false;
	tree.iterate({
		enter(n) {
			if (n.type === T.Error) hasError = true;
		},
	});
	if (hasError) return expr;

	return render(format(tree.topNode, trimmed));
}

// --------------- Pretty Print ---------------

const PRETTY_PRINT_THRESHOLD = 60;

/** Insert NewLine + N Tabs into a FormatNode array. */
function insertIndent(into: FormatNode[], depth: number) {
	into.push({ type: Layout.NewLine });
	for (let i = 0; i < depth; i++) into.push({ type: Layout.Tab });
}

/**
 * Walk the FormatNode tree and expand complex nodes across multiple lines:
 * - ArgumentList (function args) — after (, before ), after ,
 * - Filtered (predicates) — after [, before ]
 * - AndExpr / OrExpr (when inside an expanded context) — newline before keyword
 */
function prettyPrint(node: FormatNode, depth: number): FormatNode {
	// Layout tokens and leaf source tokens: pass through
	if (typeof node.type === "number") return node;
	if (node.text !== undefined) return node;

	const type = node.type;

	// Expand ArgumentList nodes that have args (more than just "(" and ")")
	if (type === T.ArgumentList && (node.children?.length ?? 0) > 2) {
		const innerDepth = depth + 1;
		const result: FormatNode[] = [];

		for (const child of node.children ?? []) {
			if (child.type === T.OpenParen) {
				result.push(child);
				insertIndent(result, innerDepth);
			} else if (child.type === T.CloseParen) {
				insertIndent(result, depth);
				result.push(child);
			} else if (child.type === T.Comma) {
				result.push(child);
				insertIndent(result, innerDepth);
			} else if (child.type === Layout.Space) {
			} else {
				result.push(prettyPrint(child, innerDepth));
			}
		}

		return { type, children: result };
	}

	// Expand Filtered (predicate) nodes — newline after [, before ]
	if (type === T.Filtered) {
		const innerDepth = depth + 1;
		const result: FormatNode[] = [];
		let insideBracket = false;

		for (const child of node.children ?? []) {
			if (child.type === T.OpenBracket) {
				result.push(child);
				insertIndent(result, innerDepth);
				insideBracket = true;
			} else if (child.type === T.CloseBracket) {
				insertIndent(result, depth);
				result.push(child);
				insideBracket = false;
			} else {
				result.push(prettyPrint(child, insideBracket ? innerDepth : depth));
			}
		}

		return { type, children: result };
	}

	// Break and/or onto new lines when inside an expanded context
	if ((type === T.AndExpr || type === T.OrExpr) && depth > 0) {
		const result: FormatNode[] = [];

		const children = node.children ?? [];
		for (let i = 0; i < children.length; i++) {
			const child = children[i];

			// Replace the Space before the keyword with NewLine + Tabs
			if (child.type === Layout.Space) {
				const next = children[i + 1];
				if (
					next &&
					typeof next.type !== "number" &&
					T.Keywords.has(next.type)
				) {
					insertIndent(result, depth);
					continue;
				}
			}

			result.push(prettyPrint(child, depth));
		}

		return { type, children: result };
	}

	// Default: recurse into children
	return {
		type,
		children: node.children?.map((child) => prettyPrint(child, depth)),
	};
}

/**
 * Format + pretty print. If the single-line formatted result exceeds the
 * threshold, expands function call argument lists across multiple lines.
 */
export function prettyPrintXPath(expr: string): string {
	const trimmed = expr.trim();
	if (!trimmed) return expr;

	const tree = parser.parse(trimmed);

	let hasError = false;
	tree.iterate({
		enter(n) {
			if (n.type === T.Error) hasError = true;
		},
	});
	if (hasError) return expr;

	const formatted = format(tree.topNode, trimmed);
	const singleLine = render(formatted);

	if (singleLine.length <= PRETTY_PRINT_THRESHOLD) return singleLine;

	return render(prettyPrint(formatted, 0));
}
