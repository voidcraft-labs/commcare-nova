import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/codemirror/xpath-parser";
import {
	compareEqual,
	compareRelational,
	dateAwareAdd,
	dateAwareSubtract,
	toBoolean,
	toNumber,
} from "./coerce";
import { getFunction } from "./functions";
import type { EvalContext, XPathValue } from "./types";

// Pre-resolve all node types from the parser — zero string comparisons at runtime
// Child and Descendant appear twice in the grammar (rootStep vs expr), so use many().
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Unknown node type: ${name}`);
		return found;
	};
	const many = (name: string) => new Set(all.filter((t) => t.name === name));
	return {
		XPath: one("XPath"),
		NumberLiteral: one("NumberLiteral"),
		StringLiteral: one("StringLiteral"),
		HashtagRef: one("HashtagRef"),
		VariableReference: one("VariableReference"),
		// Two distinct Child/Descendant types (rootStep + expr)
		Children: many("Child"),
		Descendants: many("Descendant"),
		RootPath: one("RootPath"),
		SelfStep: one("SelfStep"),
		ParentStep: one("ParentStep"),
		NameTest: one("NameTest"),
		Invoke: one("Invoke"),
		FunctionName: one("FunctionName"),
		ArgumentList: one("ArgumentList"),
		Filtered: one("Filtered"),
		// Binary expressions
		AddExpr: one("AddExpr"),
		SubtractExpr: one("SubtractExpr"),
		MultiplyExpr: one("MultiplyExpr"),
		DivideExpr: one("DivideExpr"),
		ModulusExpr: one("ModulusExpr"),
		UnaryNegativeExpr: one("UnaryNegativeExpr"),
		EqualsExpr: one("EqualsExpr"),
		NotEqualsExpr: one("NotEqualsExpr"),
		LessThanExpr: one("LessThanExpr"),
		LessEqualExpr: one("LessEqualExpr"),
		GreaterThanExpr: one("GreaterThanExpr"),
		GreaterEqualExpr: one("GreaterEqualExpr"),
		AndExpr: one("AndExpr"),
		OrExpr: one("OrExpr"),
		UnionExpr: one("UnionExpr"),
		// Tokens
		OpenParen: one("("),
		CloseParen: one(")"),
		Slash: one("/"),
		Comma: one(","),
		Error: one("⚠"),
	};
})();

/**
 * Evaluate an XPath expression string and return a value.
 * Returns '' on parse error or empty expression (matches CommCare behavior).
 */
export function evaluate(expr: string, context: EvalContext): XPathValue {
	const trimmed = expr.trim();
	if (!trimmed) return "";

	const tree = parser.parse(trimmed);

	// Check for parse errors
	let hasError = false;
	tree.iterate({
		enter(n) {
			if (n.type === T.Error) hasError = true;
		},
	});
	if (hasError) return "";

	return evalNode(tree.topNode, trimmed, context);
}

/** Recursively evaluate a Lezer CST node. */
function evalNode(
	node: SyntaxNode,
	source: string,
	ctx: EvalContext,
): XPathValue {
	const type = node.type;

	// ── XPath root — evaluate its single child expression ──
	if (type === T.XPath) {
		const child = node.firstChild;
		return child ? evalNode(child, source, ctx) : "";
	}

	// ── Literals ──
	if (type === T.NumberLiteral) {
		return parseFloat(source.slice(node.from, node.to));
	}
	if (type === T.StringLiteral) {
		const raw = source.slice(node.from, node.to);
		// Strip surrounding quotes (single or double)
		return raw.slice(1, -1);
	}

	// ── Hashtag references (#case/prop, #form/id, #user/prop) ──
	if (type === T.HashtagRef) {
		const text = source.slice(node.from, node.to);
		return ctx.resolveHashtag(text);
	}

	// ── Variable references ($var) ──
	if (type === T.VariableReference) {
		return ""; // Variables not supported in preview
	}

	// ── Self step (.) ──
	if (type === T.SelfStep) {
		return ctx.getValue(ctx.contextPath) ?? "";
	}

	// ── Parent step (..) ──
	if (type === T.ParentStep) {
		const parentPath = ctx.contextPath.replace(/\/[^/]+$/, "");
		return ctx.getValue(parentPath) ?? "";
	}

	// ── NameTest (bare name like 'data' or 'question_id') ──
	if (type === T.NameTest) {
		const name = source.slice(node.from, node.to);
		// Try as a path relative to context
		const path = `${ctx.contextPath}/${name}`;
		return ctx.getValue(path) ?? "";
	}

	// ── Root path (bare /) ──
	if (type === T.RootPath) {
		return "";
	}

	// ── Path expressions (Child: expr/step, Descendant: expr//step) ──
	if (T.Children.has(type) || T.Descendants.has(type)) {
		const path = buildPath(node, source);
		if (path) return ctx.getValue(path) ?? "";
		return "";
	}

	// ── Parenthesized expression ──
	const first = node.firstChild;
	if (first && first.type === T.OpenParen) {
		// Find the expression between ( and )
		const inner = first.nextSibling;
		if (inner && inner.type !== T.CloseParen) {
			return evalNode(inner, source, ctx);
		}
		return "";
	}

	// ── Unary negative ──
	if (type === T.UnaryNegativeExpr) {
		const operand = getLastChild(node);
		return operand ? -toNumber(evalNode(operand, source, ctx)) : 0;
	}

	// ── Binary arithmetic ──
	if (type === T.AddExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return NaN;
		return dateAwareAdd(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
		);
	}
	if (type === T.SubtractExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return NaN;
		return dateAwareSubtract(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
		);
	}
	if (type === T.MultiplyExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return NaN;
		return (
			toNumber(evalNode(left, source, ctx)) *
			toNumber(evalNode(right, source, ctx))
		);
	}
	if (type === T.DivideExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return NaN;
		const divisor = toNumber(evalNode(right, source, ctx));
		if (divisor === 0) return NaN;
		return toNumber(evalNode(left, source, ctx)) / divisor;
	}
	if (type === T.ModulusExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return NaN;
		return (
			toNumber(evalNode(left, source, ctx)) %
			toNumber(evalNode(right, source, ctx))
		);
	}

	// ── Comparison ──
	if (type === T.EqualsExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return compareEqual(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
		);
	}
	if (type === T.NotEqualsExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return !compareEqual(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
		);
	}
	if (type === T.LessThanExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return compareRelational(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
			"<",
		);
	}
	if (type === T.LessEqualExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return compareRelational(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
			"<=",
		);
	}
	if (type === T.GreaterThanExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return compareRelational(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
			">",
		);
	}
	if (type === T.GreaterEqualExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return compareRelational(
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
			">=",
		);
	}

	// ── Logical (short-circuit) ──
	if (type === T.AndExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return (
			toBoolean(evalNode(left, source, ctx)) &&
			toBoolean(evalNode(right, source, ctx))
		);
	}
	if (type === T.OrExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return (
			toBoolean(evalNode(left, source, ctx)) ||
			toBoolean(evalNode(right, source, ctx))
		);
	}

	// ── Union ──
	if (type === T.UnionExpr) {
		// Union of nodesets — not meaningful for scalar preview, evaluate left
		const [left] = getBinaryOperands(node);
		return left ? evalNode(left, source, ctx) : "";
	}

	// ── Function invocation ──
	if (type === T.Invoke) {
		return evalInvoke(node, source, ctx);
	}

	// ── Filtered (predicate) — expr[pred] ──
	if (type === T.Filtered) {
		// In preview, predicates are simplified — evaluate the base expression
		const child = node.firstChild;
		return child ? evalNode(child, source, ctx) : "";
	}

	// ── Fallback: try to evaluate the first child ──
	if (first) {
		return evalNode(first, source, ctx);
	}

	return "";
}

/** Evaluate a function invocation node. */
function evalInvoke(
	node: SyntaxNode,
	source: string,
	ctx: EvalContext,
): XPathValue {
	let fnName = "";
	const args: XPathValue[] = [];

	let child = node.firstChild;
	while (child) {
		if (child.type === T.FunctionName) {
			fnName = source.slice(child.from, child.to);
		} else if (child.type === T.ArgumentList) {
			// Evaluate each argument expression
			let arg = child.firstChild;
			while (arg) {
				if (
					arg.type !== T.OpenParen &&
					arg.type !== T.CloseParen &&
					arg.type !== T.Comma
				) {
					args.push(evalNode(arg, source, ctx));
				}
				arg = arg.nextSibling;
			}
		}
		child = child.nextSibling;
	}

	// Handle position() and last() with context values
	if (fnName === "position") return ctx.position;
	if (fnName === "last") return ctx.size;

	const fn = getFunction(fnName);
	if (fn) return fn(args);

	// Unknown function — return empty string
	return "";
}

/**
 * Build an absolute path string from a path expression CST node.
 * Walks left-recursive Child/Descendant nodes to collect segments.
 */
function buildPath(node: SyntaxNode, source: string): string | null {
	const segments: string[] = [];
	collectSegments(node, source, segments);
	if (segments.length === 0) return null;
	return `/${segments.join("/")}`;
}

function collectSegments(
	node: SyntaxNode,
	source: string,
	segments: string[],
): void {
	let child = node.firstChild;
	while (child) {
		if (T.Children.has(child.type) || T.Descendants.has(child.type)) {
			collectSegments(child, source, segments);
		} else if (child.type === T.NameTest) {
			segments.push(source.slice(child.from, child.to));
		} else if (child.type === T.RootPath || child.type === T.Slash) {
			// Skip slash tokens
		}
		child = child.nextSibling;
	}
}

/** Get left and right operands of a binary expression (skipping operator tokens). */
function getBinaryOperands(
	node: SyntaxNode,
): [SyntaxNode | null, SyntaxNode | null] {
	const children: SyntaxNode[] = [];
	let child = node.firstChild;
	while (child) {
		// Skip operator tokens (they have no children and are single-char/keyword tokens)
		if (child.firstChild || isExpressionNode(child)) {
			children.push(child);
		}
		child = child.nextSibling;
	}
	return [children[0] ?? null, children[1] ?? null];
}

/** Check if a leaf node is an expression value (literal, ref, nametest, self, etc.) */
function isExpressionNode(node: SyntaxNode): boolean {
	return (
		node.type === T.NumberLiteral ||
		node.type === T.StringLiteral ||
		node.type === T.HashtagRef ||
		node.type === T.VariableReference ||
		node.type === T.NameTest ||
		node.type === T.SelfStep ||
		node.type === T.ParentStep ||
		node.type === T.RootPath ||
		T.Children.has(node.type) ||
		T.Descendants.has(node.type)
	);
}

/** Get the last child of a node. */
function getLastChild(node: SyntaxNode): SyntaxNode | null {
	let child = node.firstChild;
	let last: SyntaxNode | null = null;
	while (child) {
		last = child;
		child = child.nextSibling;
	}
	return last;
}
