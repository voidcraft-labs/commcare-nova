/**
 * Bottom-up type inference for XPath expressions over a Lezer CST.
 *
 * Walks the syntax tree and assigns an {@link XPathType} to every node
 * via Lezer's {@link NodeWeakMap}, which keys by internal buffer
 * identity — no offset collisions, no string keys, survives
 * incremental reparses as long as the subtree is reused.
 *
 * ## Design notes
 *
 * - **Conservative**: unknown-typed operands propagate `unknown` upward.
 *   Passes should only act on nodes with a definite type.
 * - **Bottom-up only**: no control-flow or binding-type information.
 *   A form field's declared `xsd:date` type is invisible here — the
 *   inference reasons purely from the expression syntax.
 * - **Stateless**: the function is pure. Same tree + source → same map.
 * - **Extensible**: adding a new function's return type is a one-line
 *   entry in {@link FUNCTION_TYPES}.
 */

import type { SyntaxNode, Tree } from "@lezer/common";
import { NodeWeakMap } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

// ── Public types ────────────────────────────────────────────────────

/**
 * The types our inference engine tracks. Intentionally small — this is
 * about knowing enough to drive source transforms, not a full type checker.
 */
export type XPathType = "string" | "number" | "boolean" | "date" | "unknown";

/**
 * Per-node type map backed by Lezer's NodeWeakMap. Each CST node is
 * identified by its internal buffer position, so nested nodes that
 * share a start offset (e.g. `AddExpr` inside `GreaterThanExpr`)
 * get distinct entries.
 */
export type TypeMap = NodeWeakMap<XPathType>;

// ── Node type lookup (mirrors the evaluator's pattern) ──────────────

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
		OpenParen: one("("),
		CloseParen: one(")"),
		Comma: one(","),
		Error: one("⚠"),
	};
})();

/** Set of comparison node types — all produce boolean. */
const COMPARISON_TYPES = new Set([
	T.EqualsExpr,
	T.NotEqualsExpr,
	T.LessThanExpr,
	T.LessEqualExpr,
	T.GreaterThanExpr,
	T.GreaterEqualExpr,
]);

/** Set of purely-numeric arithmetic node types (not add/subtract). */
const NUMERIC_ARITHMETIC = new Set([
	T.MultiplyExpr,
	T.DivideExpr,
	T.ModulusExpr,
]);

// ── Function return types ───────────────────────────────────────────

/**
 * Known return types for XPath / CommCare functions. To teach the
 * inference engine about a new function, add a single entry here.
 */
const FUNCTION_TYPES: Record<string, XPathType> = {
	/* Date producers */
	today: "date",
	now: "date",
	date: "date",

	/* Boolean producers */
	true: "boolean",
	false: "boolean",
	not: "boolean",
	boolean: "boolean",
	contains: "boolean",
	"starts-with": "boolean",
	selected: "boolean",
	regex: "boolean",

	/* Number producers */
	number: "number",
	int: "number",
	round: "number",
	floor: "number",
	ceiling: "number",
	abs: "number",
	pow: "number",
	min: "number",
	max: "number",
	count: "number",
	sum: "number",
	"count-selected": "number",
	"string-length": "number",
	position: "number",
	last: "number",

	/* String producers */
	string: "string",
	concat: "string",
	substr: "string",
	"normalize-space": "string",
	translate: "string",
	join: "string",
	"format-date": "string",
	uuid: "string",
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Infer types for every expression node in a parsed XPath tree.
 *
 * @param tree  Lezer parse tree (from `parser.parse(source)`)
 * @param source  The original expression string
 * @returns NodeWeakMap from CST node → inferred type
 */
export function inferTypes(tree: Tree, source: string): TypeMap {
	const types = new NodeWeakMap<XPathType>();
	infer(tree.topNode, source, types);
	return types;
}

// ── Recursive inference ─────────────────────────────────────────────

function infer(node: SyntaxNode, source: string, types: TypeMap): XPathType {
	const type = node.type;

	/* Root wrapper — delegate to child */
	if (type === T.XPath) {
		const child = node.firstChild;
		const t = child ? infer(child, source, types) : "unknown";
		types.set(node, t);
		return t;
	}

	/* ── Literals ── */
	if (type === T.NumberLiteral) {
		types.set(node, "number");
		return "number";
	}
	if (type === T.StringLiteral) {
		types.set(node, "string");
		return "string";
	}

	/* ── References — all resolve to strings from the data instance ── */
	if (
		type === T.HashtagRef ||
		type === T.VariableReference ||
		type === T.SelfStep ||
		type === T.ParentStep ||
		type === T.NameTest ||
		type === T.RootPath ||
		T.Children.has(type) ||
		T.Descendants.has(type)
	) {
		types.set(node, "string");
		return "string";
	}

	/* ── Parenthesized expression — inherit child type ── */
	const first = node.firstChild;
	if (first && first.type === T.OpenParen) {
		const inner = first.nextSibling;
		const t =
			inner && inner.type !== T.CloseParen
				? infer(inner, source, types)
				: "unknown";
		types.set(node, t);
		return t;
	}

	/* ── Unary negative — always numeric ── */
	if (type === T.UnaryNegativeExpr) {
		inferChildren(node, source, types);
		types.set(node, "number");
		return "number";
	}

	/* ── Add / Subtract — date-aware ── */
	if (type === T.AddExpr || type === T.SubtractExpr) {
		const [leftType, rightType] = inferBinaryOperands(node, source, types);
		const t = inferDateArithmetic(type === T.AddExpr, leftType, rightType);
		types.set(node, t);
		return t;
	}

	/* ── Multiply / Divide / Mod — always numeric ── */
	if (NUMERIC_ARITHMETIC.has(type)) {
		inferChildren(node, source, types);
		types.set(node, "number");
		return "number";
	}

	/* ── Comparisons — always boolean ── */
	if (COMPARISON_TYPES.has(type)) {
		inferChildren(node, source, types);
		types.set(node, "boolean");
		return "boolean";
	}

	/* ── Logical and/or — always boolean ── */
	if (type === T.AndExpr || type === T.OrExpr) {
		inferChildren(node, source, types);
		types.set(node, "boolean");
		return "boolean";
	}

	/* ── Union — unknown (nodeset semantics) ── */
	if (type === T.UnionExpr) {
		inferChildren(node, source, types);
		types.set(node, "unknown");
		return "unknown";
	}

	/* ── Function invocation ── */
	if (type === T.Invoke) {
		const t = inferInvoke(node, source, types);
		types.set(node, t);
		return t;
	}

	/* ── Filtered (predicate) — inherit base type ── */
	if (type === T.Filtered) {
		const child = node.firstChild;
		const t = child ? infer(child, source, types) : "unknown";
		types.set(node, t);
		return t;
	}

	/* ── Fallback: recurse into first child ── */
	if (first) {
		const t = infer(first, source, types);
		types.set(node, t);
		return t;
	}

	types.set(node, "unknown");
	return "unknown";
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Infer all children (for side-effect of populating the type map). */
function inferChildren(node: SyntaxNode, source: string, types: TypeMap): void {
	let child = node.firstChild;
	while (child) {
		infer(child, source, types);
		child = child.nextSibling;
	}
}

/**
 * Infer the two operand types of a binary expression, skipping
 * operator tokens. Returns `['unknown', 'unknown']` if operands are
 * missing — never throws.
 */
function inferBinaryOperands(
	node: SyntaxNode,
	source: string,
	types: TypeMap,
): [XPathType, XPathType] {
	const operandTypes: XPathType[] = [];
	let child = node.firstChild;
	while (child) {
		if (child.firstChild || isExpressionLeaf(child)) {
			operandTypes.push(infer(child, source, types));
		}
		child = child.nextSibling;
	}
	return [operandTypes[0] ?? "unknown", operandTypes[1] ?? "unknown"];
}

/**
 * Determine the result type of date-aware add/subtract, mirroring the
 * runtime semantics in `coerce.ts`.
 *
 * - date ± number → date (shift)
 * - number + date → date (commutative add)
 * - date - date   → number (difference)
 * - otherwise     → number
 */
function inferDateArithmetic(
	isAdd: boolean,
	left: XPathType,
	right: XPathType,
): XPathType {
	const leftIsDate = left === "date";
	const rightIsDate = right === "date";
	if (!leftIsDate && !rightIsDate) return "number";
	if (isAdd) {
		/* date + date → number (unusual); date + non-date → date */
		return leftIsDate !== rightIsDate ? "date" : "number";
	}
	/* Subtraction: date - date → number; date - other → date */
	if (leftIsDate && rightIsDate) return "number";
	if (leftIsDate) return "date";
	return "number";
}

/** Infer the return type of a function call. */
function inferInvoke(
	node: SyntaxNode,
	source: string,
	types: TypeMap,
): XPathType {
	let fnName = "";
	let child = node.firstChild;
	while (child) {
		if (child.type === T.FunctionName) {
			fnName = source.slice(child.from, child.to);
		} else if (child.type === T.ArgumentList) {
			/* Infer argument types (populates the map for downstream passes) */
			let arg = child.firstChild;
			while (arg) {
				if (
					arg.type !== T.OpenParen &&
					arg.type !== T.CloseParen &&
					arg.type !== T.Comma
				) {
					infer(arg, source, types);
				}
				arg = arg.nextSibling;
			}
		}
		child = child.nextSibling;
	}

	/*
	 * Special case: `if(cond, then, else)` — result type is the common
	 * type of the then/else branches. If they differ, fall back to unknown.
	 */
	if (fnName === "if") {
		return inferIfReturnType(node, types);
	}

	/* `coalesce(a, b, ...)` — common type of all arguments */
	if (fnName === "coalesce") {
		return inferCoalesceReturnType(node, types);
	}

	return FUNCTION_TYPES[fnName] ?? "unknown";
}

/** Infer the return type of `if(cond, then, else)` from its branches. */
function inferIfReturnType(node: SyntaxNode, types: TypeMap): XPathType {
	const argTypes = collectArgTypes(node, types);
	const thenType = argTypes[1] ?? "unknown";
	const elseType = argTypes[2] ?? "unknown";
	if (thenType === elseType) return thenType;
	return "unknown";
}

/** Infer the return type of `coalesce(a, b, ...)` — common type. */
function inferCoalesceReturnType(node: SyntaxNode, types: TypeMap): XPathType {
	const argTypes = collectArgTypes(node, types);
	if (argTypes.length === 0) return "unknown";
	const first = argTypes[0];
	return argTypes.every((t) => t === first) ? first : "unknown";
}

/** Collect inferred types for all arguments of a function call. */
function collectArgTypes(invokeNode: SyntaxNode, types: TypeMap): XPathType[] {
	const result: XPathType[] = [];
	let child = invokeNode.firstChild;
	while (child) {
		if (child.type === T.ArgumentList) {
			let arg = child.firstChild;
			while (arg) {
				if (
					arg.type !== T.OpenParen &&
					arg.type !== T.CloseParen &&
					arg.type !== T.Comma
				) {
					result.push(types.get(arg) ?? "unknown");
				}
				arg = arg.nextSibling;
			}
		}
		child = child.nextSibling;
	}
	return result;
}

/** Check if a leaf node is an expression value (not an operator token). */
function isExpressionLeaf(node: SyntaxNode): boolean {
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
