/**
 * XPath type checker — bottom-up type inference over the Lezer CST.
 *
 * Phase 1: Infer a type for every node (leaves → operators → root)
 * Phase 2: At each operator/function, check operand types against expectations
 *
 * XPath 1.0 is dynamically typed with implicit coercion. The type checker
 * flags provably-lossy coercions — specifically, non-numeric string literals
 * in numeric contexts (e.g. - 'hello', 'text' * 2, round('foo')).
 */

import type { SyntaxNode } from "@lezer/common";
import type { NodeType } from "@lezer/common";
import { parser } from "@/lib/codemirror/xpath-parser";
import { FUNCTION_REGISTRY, type XPathType } from "./functionRegistry";

export interface TypeError {
	code: "TYPE_ERROR";
	message: string;
	position: number;
}

// ── Node type resolution ────────────────────────────────────────────

const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => all.find((t) => t.name === name)!;
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
		// Arithmetic
		AddExpr: one("AddExpr"),
		SubtractExpr: one("SubtractExpr"),
		MultiplyExpr: one("MultiplyExpr"),
		DivideExpr: one("DivideExpr"),
		ModulusExpr: one("ModulusExpr"),
		UnaryNegativeExpr: one("UnaryNegativeExpr"),
		// Comparison
		EqualsExpr: one("EqualsExpr"),
		NotEqualsExpr: one("NotEqualsExpr"),
		LessThanExpr: one("LessThanExpr"),
		LessEqualExpr: one("LessEqualExpr"),
		GreaterThanExpr: one("GreaterThanExpr"),
		GreaterEqualExpr: one("GreaterEqualExpr"),
		// Logical
		AndExpr: one("AndExpr"),
		OrExpr: one("OrExpr"),
		// Set
		UnionExpr: one("UnionExpr"),
		// Tokens (skipped during inference)
		Comma: one(","),
		Error: one("⚠"),
	};
})();

// ── Operator type table ─────────────────────────────────────────────
// Declarative: each operator declares what it expects and what it returns.

interface OperatorConstraint {
	operands: XPathType;
	returns: XPathType;
}

const OPERATOR_TYPES = new Map<NodeType, OperatorConstraint>();

// Arithmetic: expects number, returns number
for (const op of [
	T.AddExpr,
	T.SubtractExpr,
	T.MultiplyExpr,
	T.DivideExpr,
	T.ModulusExpr,
	T.UnaryNegativeExpr,
]) {
	OPERATOR_TYPES.set(op, { operands: "number", returns: "number" });
}
// Relational comparison: expects number, returns boolean
for (const op of [
	T.LessThanExpr,
	T.LessEqualExpr,
	T.GreaterThanExpr,
	T.GreaterEqualExpr,
]) {
	OPERATOR_TYPES.set(op, { operands: "number", returns: "boolean" });
}
// Equality: accepts any (XPath spec — coercion rules are complex), returns boolean
for (const op of [T.EqualsExpr, T.NotEqualsExpr]) {
	OPERATOR_TYPES.set(op, { operands: "any", returns: "boolean" });
}
// Logical: expects boolean, returns boolean
for (const op of [T.AndExpr, T.OrExpr]) {
	OPERATOR_TYPES.set(op, { operands: "boolean", returns: "boolean" });
}
// Union: expects nodeset, returns nodeset
OPERATOR_TYPES.set(T.UnionExpr, { operands: "nodeset", returns: "nodeset" });

// ── Path node types (all infer to nodeset) ──────────────────────────

const PATH_TYPES = new Set<NodeType>([
	T.RootPath,
	T.SelfStep,
	T.ParentStep,
	T.NameTest,
	...T.Children,
	...T.Descendants,
]);

// ── Type inference ──────────────────────────────────────────────────

/** Infer the XPath type of a CST node (bottom-up). */
function inferType(node: SyntaxNode, source: string): XPathType {
	const type = node.type;

	// Literals
	if (type === T.NumberLiteral) return "number";
	if (type === T.StringLiteral) return "string";

	// References — resolve to string values at runtime
	if (type === T.HashtagRef) return "string";
	if (type === T.VariableReference) return "any";

	// Path expressions → nodeset
	if (PATH_TYPES.has(type)) return "nodeset";

	// Filtered expression → type of its base
	if (type === T.Filtered) {
		const base = node.firstChild;
		return base ? inferType(base, source) : "any";
	}

	// Operators → return type from table
	const constraint = OPERATOR_TYPES.get(type);
	if (constraint) return constraint.returns;

	// Function calls → return type from registry
	if (type === T.Invoke) {
		const nameNode = node.getChild(T.FunctionName.id);
		if (nameNode) {
			const funcName = source.slice(nameNode.from, nameNode.to);
			const spec = FUNCTION_REGISTRY.get(funcName);
			if (spec) return spec.returnType;
		}
		return "any";
	}

	// XPath root → type of its child
	if (type === T.XPath) {
		const child = node.firstChild;
		return child ? inferType(child, source) : "any";
	}

	// Parenthesized expression — find the actual expression child
	// (anonymous "(" and ")" tokens are children alongside the expr)
	let child = node.firstChild;
	while (child) {
		const name = child.type.name;
		if (name !== "(" && name !== ")") {
			return inferType(child, source);
		}
		child = child.nextSibling;
	}

	return "any";
}

// ── Compatibility check ─────────────────────────────────────────────

/**
 * Check if an operand's actual type is compatible with the expected type.
 * Returns true if compatible, false if provably incompatible.
 *
 * The only provably-lossy coercion: a string literal that is not a valid
 * number, used in a numeric context. All other coercions are either
 * lossless (number→string, boolean→number) or unknowable at static time
 * (nodeset, any, non-literal strings).
 */
function isCompatible(
	actual: XPathType,
	expected: XPathType,
	node: SyntaxNode,
	source: string,
): boolean {
	// 'any' is always compatible — type is unknowable
	if (actual === "any" || expected === "any") return true;

	// Same type — always compatible
	if (actual === expected) return true;

	// Nodeset coerces to string first, then to anything — unknowable at static time
	if (actual === "nodeset") return true;

	// number ↔ boolean: lossless (true=1, false=0; 0/NaN=false)
	if (actual === "boolean" && expected === "number") return true;
	if (actual === "number" && expected === "boolean") return true;

	// number → string: lossless
	if (actual === "number" && expected === "string") return true;

	// boolean → string: lossless ("true"/"false")
	if (actual === "boolean" && expected === "string") return true;

	// string → boolean: lossless (empty = false, non-empty = true)
	if (actual === "string" && expected === "boolean") return true;

	// string → number: check if the literal value is parseable
	if (actual === "string" && expected === "number") {
		if (node.type === T.StringLiteral) {
			const raw = source.slice(node.from, node.to);
			const inner = raw.slice(1, -1).trim();
			if (inner === "") return true; // empty string → NaN but might be intentional (conditional)
			return !Number.isNaN(Number(inner));
		}
		// Non-literal string (path, hashtag, function result) — unknowable
		return true;
	}

	// Anything else we haven't covered — allow it (conservative)
	return true;
}

// ── Expression operand extraction ───────────────────────────────────

/** Get the expression children of a node (skip tokens like operators, parens, commas). */
function getExprChildren(node: SyntaxNode): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	let child = node.firstChild;
	while (child) {
		// Skip operator tokens, parens, commas, and other anonymous tokens
		if (child.type.name.length > 1 || child.type === T.Error) {
			// Named node types have names longer than 1 char (operators are single chars)
			// Exception: ⚠ is multi-byte but is the error node
			if (child.type !== T.Comma && child.type !== T.Error) {
				children.push(child);
			}
		}
		child = child.nextSibling;
	}
	return children;
}

// ── Public API ──────────────────────────────────────────────────────

/** Run type checking on an XPath expression. Returns type errors found. */
export function checkTypes(expr: string): TypeError[] {
	if (!expr) return [];

	const tree = parser.parse(expr);
	const errors: TypeError[] = [];

	function walk(node: SyntaxNode): void {
		// Check operator constraints
		const constraint = OPERATOR_TYPES.get(node.type);
		if (constraint && constraint.operands !== "any") {
			const operands = getExprChildren(node);
			for (const operand of operands) {
				const actualType = inferType(operand, expr);
				if (!isCompatible(actualType, constraint.operands, operand, expr)) {
					const operandText = expr.slice(operand.from, operand.to);
					errors.push({
						code: "TYPE_ERROR",
						message: `Type mismatch: ${actualType} value ${truncate(operandText)} used where ${constraint.operands} is expected`,
						position: operand.from,
					});
				}
			}
		}

		// Check function parameter types
		if (node.type === T.Invoke) {
			checkFunctionParamTypes(node, expr, errors);
		}

		// Recurse into children
		let child = node.firstChild;
		while (child) {
			walk(child);
			child = child.nextSibling;
		}
	}

	walk(tree.topNode);
	return errors;
}

/** Check function argument types against declared paramTypes. */
function checkFunctionParamTypes(
	node: SyntaxNode,
	source: string,
	errors: TypeError[],
): void {
	const nameNode = node.getChild(T.FunctionName.id);
	if (!nameNode) return;

	const funcName = source.slice(nameNode.from, nameNode.to);
	const spec = FUNCTION_REGISTRY.get(funcName);
	if (!spec?.paramTypes) return;

	const argList = node.getChild(T.ArgumentList.id);
	if (!argList) return;

	// Collect argument expression nodes (skip parens and commas)
	const args: SyntaxNode[] = [];
	let child = argList.firstChild;
	while (child) {
		const name = child.type.name;
		if (name !== "(" && name !== ")" && child.type !== T.Comma) {
			args.push(child);
		}
		child = child.nextSibling;
	}

	for (let i = 0; i < args.length && i < spec.paramTypes.length; i++) {
		const expectedType = spec.paramTypes[i];
		if (expectedType === "any") continue;

		const actualType = inferType(args[i], source);
		if (!isCompatible(actualType, expectedType, args[i], source)) {
			const argText = source.slice(args[i].from, args[i].to);
			errors.push({
				code: "TYPE_ERROR",
				message: `${funcName}() argument ${i + 1}: ${actualType} value ${truncate(argText)} used where ${expectedType} is expected`,
				position: args[i].from,
			});
		}
	}
}

function truncate(s: string, max = 20): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}
