import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

/** A transient parse tree, never stored or executed. Uses the existing grammar. */
export type AuthoredExpression =
	| { kind: "literal"; value: string | number | boolean | null; decimal?: true }
	| { kind: "reference"; namespace: string; path: string[] }
	| { kind: "call"; name: string; args: AuthoredExpression[] }
	| {
			kind: "binary";
			operator: string;
			left: AuthoredExpression;
			right: AuthoredExpression;
	  }
	| { kind: "negative"; value: AuthoredExpression };

const operators: Record<string, string> = {
	MultiplyExpr: "*",
	DivideExpr: "div",
	ModulusExpr: "mod",
	AddExpr: "+",
	SubtractExpr: "-",
	GreaterThanExpr: ">",
	GreaterEqualExpr: ">=",
	LessThanExpr: "<",
	LessEqualExpr: "<=",
	EqualsExpr: "=",
	NotEqualsExpr: "!=",
	AndExpr: "and",
	OrExpr: "or",
};
const expressionNodes = new Set([
	...Object.keys(operators),
	"UnaryNegativeExpr",
	"StringLiteral",
	"NumberLiteral",
	"HashtagRef",
	"Invoke",
]);
const separators = new Set([
	...Object.values(operators),
	"(",
	")",
	",",
	"AndOp",
	"OrOp",
	"DivOp",
	"ModOp",
]);

export function parseAuthoringExpression(
	source: string | number | boolean,
): AuthoredExpression {
	if (typeof source !== "string") return { kind: "literal", value: source };
	const tree = parser.parse(source);
	let error: SyntaxNode | undefined;
	tree.iterate({
		enter(node) {
			if (node.type.isError) error ??= node.node;
		},
	});
	if (error)
		throw new Error(`Invalid expression near character ${error.from + 1}.`);
	const text = (node: SyntaxNode) => source.slice(node.from, node.to);
	function children(node: SyntaxNode) {
		const result: SyntaxNode[] = [];
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (expressionNodes.has(child.name)) result.push(child);
			else if (!separators.has(child.name)) {
				throw new Error(`Use a named reference for ${text(child)}.`);
			}
		}
		return result;
	}
	function visit(node: SyntaxNode): AuthoredExpression {
		if (node.name === "StringLiteral")
			return { kind: "literal", value: text(node).slice(1, -1) };
		if (node.name === "NumberLiteral")
			return {
				kind: "literal",
				value: Number(text(node)),
				...(text(node).includes(".") &&
					Number.isInteger(Number(text(node))) && { decimal: true }),
			};
		if (node.name === "HashtagRef") {
			const namespace = node.getChild("HashtagType");
			if (!namespace) throw new Error("A reference needs a namespace.");
			return {
				kind: "reference",
				namespace: text(namespace),
				path: node.getChildren("HashtagSegment").map(text),
			};
		}
		if (node.name === "Invoke") {
			const args = node.getChild("ArgumentList");
			const name = node.getChild("FunctionName");
			if (!args || !name) throw new Error("Incomplete expression function.");
			return {
				kind: "call",
				name: text(name),
				args: children(args).map(visit),
			};
		}
		const operands = children(node);
		if (node.name === "UnaryNegativeExpr" && operands.length === 1)
			return { kind: "negative", value: visit(operands[0]) };
		const operator = operators[node.name];
		if (operator && operands.length === 2)
			return {
				kind: "binary",
				operator,
				left: visit(operands[0]),
				right: visit(operands[1]),
			};
		throw new Error(`Unsupported expression: ${text(node)}.`);
	}
	const roots = children(tree.topNode);
	if (roots.length !== 1) throw new Error("Supply one complete expression.");
	return visit(roots[0]);
}

/** XPath string literals do not have backslash escapes. */
export function quoteAuthoringLiteral(value: string): string {
	if (!value.includes("'")) return `'${value}'`;
	if (!value.includes('"')) return `"${value}"`;
	return `concat(${value
		.split("'")
		.map((part) => `'${part}'`)
		.join(', "\'", ')})`;
}
