import type { SyntaxNode } from "@lezer/common";
import { parser } from "./parser";

interface Bounds {
	readonly from: number;
	readonly to: number;
}
export type FormSyntax = Bounds &
	(
		| { readonly kind: "string"; readonly value: string }
		| { readonly kind: "number"; readonly value: number }
		| {
				readonly kind: "name";
				readonly name: string;
				readonly wildcard: boolean;
		  }
		| {
				readonly kind: "hashtag";
				readonly namespace: string;
				readonly segments: readonly string[];
		  }
		| { readonly kind: "self" | "parent" | "root" }
		| { readonly kind: "variable"; readonly name: string }
		| { readonly kind: "group" | "negative"; readonly value: FormSyntax }
		| {
				readonly kind: "axis";
				readonly axis: string;
				readonly value: FormSyntax;
		  }
		| {
				readonly kind: "child";
				readonly left?: FormSyntax;
				readonly step: FormSyntax;
				readonly descendant: boolean;
		  }
		| {
				readonly kind: "filter";
				readonly base: FormSyntax;
				readonly where: FormSyntax;
		  }
		| {
				readonly kind: "binary";
				readonly op: string;
				readonly left: FormSyntax;
				readonly right: FormSyntax;
		  }
		| {
				readonly kind: "call";
				readonly name: string;
				readonly args: readonly FormSyntax[];
		  }
	);

export interface FormSyntaxIssue extends Bounds {
	readonly message: string;
}
export type FormSyntaxResult =
	| { readonly ok: true; readonly node: FormSyntax | undefined }
	| { readonly ok: false; readonly issues: readonly FormSyntaxIssue[] };

const BINARY_OPERATORS: Readonly<Record<string, string>> = {
	MultiplyExpr: "*",
	DivideExpr: "div",
	ModulusExpr: "mod",
	AddExpr: "+",
	SubtractExpr: "-",
	GreaterThanExpr: ">",
	GreaterEqualExpr: ">=",
	LessThanExpr: "<",
	LessEqualExpr: "<=",
	NotEqualsExpr: "!=",
	EqualsExpr: "=",
	AndExpr: "and",
	OrExpr: "or",
	UnionExpr: "|",
};

function children(node: SyntaxNode): SyntaxNode[] {
	const result: SyntaxNode[] = [];
	for (let child = node.firstChild; child !== null; child = child.nextSibling)
		result.push(child);
	return result;
}

/** One structural reading of the production Lezer grammar. Grouping is kept
 * here for semantic chain boundaries and occurrence matching, never stored. */
export function readFormSyntax(source: string): FormSyntaxResult {
	if (source.trim().length === 0) return { ok: true, node: undefined };
	const tree = parser.parse(source);
	const issues: FormSyntaxIssue[] = [];
	tree.iterate({
		enter(node) {
			if (node.type.isError)
				issues.push({
					from: node.from,
					to: node.to,
					message: `This expression can't be read near character ${node.from + 1}. A bracket, a quote or an operator may be missing there.`,
				});
		},
	});
	if (issues.length > 0) return { ok: false, issues };
	const text = (node: SyntaxNode) => source.slice(node.from, node.to);
	function sequence(nodes: readonly SyntaxNode[]): FormSyntax {
		const first = nodes[0];
		const last = nodes.at(-1);
		if (first === undefined || last === undefined)
			throw new Error("The XPath grammar produced an empty expression.");
		if (first.name === "(" && last.name === ")") {
			return {
				kind: "group",
				value: sequence(nodes.slice(1, -1)),
				from: first.from,
				to: last.to,
			};
		}
		if (nodes.length !== 1)
			throw new Error(
				`The XPath grammar produced an unclassified expression at ${first.from}.`,
			);
		return read(first);
	}
	function split(
		nodes: readonly SyntaxNode[],
		separator: string,
	): SyntaxNode[][] {
		const result: SyntaxNode[][] = [[]];
		let depth = 0;
		for (const node of nodes) {
			if (node.name === "(") depth++;
			if (node.name === ")") depth--;
			if (depth === 0 && (node.name === separator || text(node) === separator))
				result.push([]);
			else result[result.length - 1].push(node);
		}
		return result;
	}
	function read(node: SyntaxNode): FormSyntax {
		const bounds = { from: node.from, to: node.to };
		const nodes = children(node);
		const op = BINARY_OPERATORS[node.name];
		if (op !== undefined) {
			const [left, right] = split(nodes, op);
			if (left === undefined || right === undefined)
				throw new Error("The XPath grammar omitted a binary operand.");
			return {
				...bounds,
				kind: "binary",
				op,
				left: sequence(left),
				right: sequence(right),
			};
		}
		switch (node.name) {
			case "XPath":
				return sequence(nodes);
			case "StringLiteral":
				return { ...bounds, kind: "string", value: text(node).slice(1, -1) };
			case "NumberLiteral":
				return { ...bounds, kind: "number", value: Number(text(node)) };
			case "NameTest":
				return {
					...bounds,
					kind: "name",
					name: text(node),
					wildcard: nodes.some(
						(child) =>
							child.name === "Wildcard" || child.name === "QualifiedWildcard",
					),
				};
			case "HashtagRef":
				return {
					...bounds,
					kind: "hashtag",
					namespace: nodes
						.filter((child) => child.name === "HashtagType")
						.map(text)
						.join(""),
					segments: nodes
						.filter((child) => child.name === "HashtagSegment")
						.map(text),
				};
			case "SelfStep":
				return { ...bounds, kind: "self" };
			case "ParentStep":
				return { ...bounds, kind: "parent" };
			case "RootPath":
				return { ...bounds, kind: "root" };
			case "VariableReference":
				return { ...bounds, kind: "variable", name: text(node).slice(1) };
			case "UnaryNegativeExpr":
				return { ...bounds, kind: "negative", value: sequence(nodes.slice(1)) };
			case "AttrSpecified":
				return {
					...bounds,
					kind: "axis",
					axis: "attribute",
					value: sequence(nodes.slice(1)),
				};
			case "AxisSpecified":
				return {
					...bounds,
					kind: "axis",
					axis: text(nodes[0]),
					value: sequence(nodes.slice(2)),
				};
			case "Child":
			case "Descendant": {
				const separator = node.name === "Child" ? "/" : "//";
				const [left, right] = split(nodes, separator);
				if (right === undefined)
					throw new Error("The XPath grammar omitted a path step.");
				return {
					...bounds,
					kind: "child",
					...(left.length === 0 ? {} : { left: sequence(left) }),
					step: sequence(right),
					descendant: node.name === "Descendant",
				};
			}
			case "Filtered": {
				const delimiter = nodes.findIndex((child) => child.name === "[");
				return {
					...bounds,
					kind: "filter",
					base: sequence(nodes.slice(0, delimiter)),
					where: sequence(nodes.slice(delimiter + 1, -1)),
				};
			}
			case "Invoke": {
				const name = nodes.find((child) => child.name === "FunctionName");
				const argumentList = nodes.find(
					(child) => child.name === "ArgumentList",
				);
				if (name === undefined || argumentList === undefined)
					throw new Error(
						"The XPath grammar omitted a function name or arguments.",
					);
				const args = children(argumentList).slice(1, -1);
				return {
					...bounds,
					kind: "call",
					name: text(name),
					args: args.length === 0 ? [] : split(args, ",").map(sequence),
				};
			}
			default:
				throw new Error(
					`The XPath grammar produced an unsupported node ${node.name}.`,
				);
		}
	}
	return { ok: true, node: read(tree.topNode) };
}

/** Grouping may affect an and/or chain's stored shape, so keys retain it. */
export function formSyntaxKey(node: FormSyntax): string {
	switch (node.kind) {
		case "string":
		case "number":
			return JSON.stringify([node.kind, node.value]);
		case "name":
			return JSON.stringify([node.kind, node.name, node.wildcard]);
		case "hashtag":
			return JSON.stringify([node.kind, node.namespace, node.segments]);
		case "self":
		case "parent":
		case "root":
			return node.kind;
		case "variable":
			return JSON.stringify([node.kind, node.name]);
		case "group":
		case "negative":
			return JSON.stringify([node.kind, formSyntaxKey(node.value)]);
		case "axis":
			return JSON.stringify([node.kind, node.axis, formSyntaxKey(node.value)]);
		case "child":
			return JSON.stringify([
				node.kind,
				node.left === undefined ? null : formSyntaxKey(node.left),
				formSyntaxKey(node.step),
				node.descendant,
			]);
		case "filter":
			return JSON.stringify([
				node.kind,
				formSyntaxKey(node.base),
				formSyntaxKey(node.where),
			]);
		case "binary":
			return JSON.stringify([
				node.kind,
				node.op,
				formSyntaxKey(node.left),
				formSyntaxKey(node.right),
			]);
		case "call":
			return JSON.stringify([
				node.kind,
				node.name,
				node.args.map(formSyntaxKey),
			]);
	}
}

/** Match only observable structural occurrences. Changed repeated array
 * members deliberately receive no hint instead of borrowing a neighbour's identity. */
export function matchFormSyntax(
	before: FormSyntax,
	after: FormSyntax,
	matched: (before: FormSyntax, after: FormSyntax) => void,
): void {
	if (before.kind !== after.kind) return;
	matched(before, after);
	function arrays(
		left: readonly FormSyntax[],
		right: readonly FormSyntax[],
	): void {
		const leftKeys = left.map(formSyntaxKey);
		const rightKeys = right.map(formSyntaxKey);
		if (
			leftKeys.length === rightKeys.length &&
			leftKeys.every((key, index) => key === rightKeys[index])
		) {
			left.forEach((item, index) => {
				matchFormSyntax(item, right[index], matched);
			});
			return;
		}
		let previous = -1;
		for (const [index, key] of leftKeys.entries()) {
			if (
				leftKeys.indexOf(key) !== index ||
				leftKeys.lastIndexOf(key) !== index
			)
				continue;
			const target = rightKeys.indexOf(key);
			if (
				target <= previous ||
				target === -1 ||
				rightKeys.lastIndexOf(key) !== target
			)
				continue;
			previous = target;
			matchFormSyntax(left[index], right[target], matched);
		}
	}
	switch (before.kind) {
		case "group":
		case "negative":
			if (after.kind === before.kind)
				matchFormSyntax(before.value, after.value, matched);
			break;
		case "axis":
			if (after.kind === "axis" && before.axis === after.axis)
				matchFormSyntax(before.value, after.value, matched);
			break;
		case "child":
			if (after.kind === "child" && before.descendant === after.descendant) {
				if (before.left !== undefined && after.left !== undefined)
					matchFormSyntax(before.left, after.left, matched);
				matchFormSyntax(before.step, after.step, matched);
			}
			break;
		case "filter":
			if (after.kind === "filter") {
				const collect = (
					node: FormSyntax,
				): { base: FormSyntax; where: FormSyntax[] } => {
					if (node.kind !== "filter") return { base: node, where: [] };
					const nested = collect(node.base);
					return { base: nested.base, where: [...nested.where, node.where] };
				};
				const left = collect(before);
				const right = collect(after);
				matchFormSyntax(left.base, right.base, matched);
				arrays(left.where, right.where);
			}
			break;
		case "binary":
			if (after.kind === "binary" && before.op === after.op) {
				if (before.op === "and" || before.op === "or") {
					const collect = (node: FormSyntax): FormSyntax[] =>
						node.kind === "binary" && node.op === before.op
							? [...collect(node.left), ...collect(node.right)]
							: [node];
					arrays(collect(before), collect(after));
				} else {
					matchFormSyntax(before.left, after.left, matched);
					matchFormSyntax(before.right, after.right, matched);
				}
			}
			break;
		case "call":
			if (after.kind === "call" && before.name === after.name)
				arrays(before.args, after.args);
			break;
	}
}
