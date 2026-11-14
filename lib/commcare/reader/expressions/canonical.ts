/**
 * The canonical tree of a Nova document. Two trees can print the same bytes
 * in one slot (an `or` of equalities and an `in`, a read spelled absolute and
 * one with no spelling); the reader gives the folded one, so a read of Nova's
 * own export is compared with this form of the document, defined here
 * independently of the reader. Each row is a rewrite over the typed tree
 * between two trees that print the same bytes, which a test prints in a real
 * slot. Nothing here parses or prints.
 */
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { formNodeGraph } from "@/lib/domain/expression/formNodes";
import {
	comparisonOperands,
	comparisonPlan,
	type InstantOperand,
	instantTextOfMicros,
	literalInstantMicros,
	literalInstantText,
} from "@/lib/domain/expression/instantOperand";
import { mapExpressionChildren } from "@/lib/domain/expression/mapAst";
import {
	effectiveFilterForEmission,
	simplifyForEmission,
} from "@/lib/domain/expression/simplify";
import { expressionContextAtPath } from "@/lib/domain/expression/typeChecker";
import type {
	CheckPath,
	Expression,
	FormNodeRef,
	Literal,
	SwitchCase,
	Term,
} from "@/lib/domain/expression/types";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain/forms";
import type { FormNodeProjection } from "../../xpath/formNodeProjection";
import { crossesSourceRepeatInRowPredicate } from "../../xpath/wire/formReads";
import { literalArguments } from "../../xpath/wire/serialize";
import type { WireMode } from "../../xpath/wire/tree";
import { shapedLiteral as shapedLiteralText } from "./folds";

/** One row: a tree shape and the canonical tree that prints the same bytes
 *  in this slot. A row scoped to `root` applies to a slot's whole tree. */
export interface PrintCollision {
	readonly id: string;
	readonly scope?: "root";
	rewrite(node: Expression, context: ExpressionContext): Expression | undefined;
}

const COMPARISON_KINDS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
type Comparison = Extract<
	Expression,
	{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
>;
function isComparison(node: Expression): node is Comparison {
	return COMPARISON_KINDS.has(node.kind);
}

function termOf(node: Expression): Term | undefined {
	return node.kind === "term" ? node.term : undefined;
}

/** Two subtrees equal as stored data. */
function sameTree(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function stringLiteral(node: Expression | undefined): string | undefined {
	const term = node === undefined ? undefined : termOf(node);
	return term?.kind === "literal" && typeof term.value === "string"
		? term.value
		: undefined;
}

function numberLiteral(node: Expression | undefined): number | undefined {
	const term = node === undefined ? undefined : termOf(node);
	return term?.kind === "literal" && typeof term.value === "number"
		? term.value
		: undefined;
}

function isCall(
	node: Expression | undefined,
	fn: string,
	arity?: number,
): node is Extract<Expression, { kind: "call" }> {
	return (
		node?.kind === "call" &&
		node.fn === fn &&
		(arity === undefined || node.args.length === arity)
	);
}

/** The slot's own form-node graph, as the read relocation reads it. */
function graphProjection(
	context: ExpressionContext,
): FormNodeProjection | undefined {
	if (context.form === undefined) return undefined;
	return {
		graph: formNodeGraph(context.form),
		step: () => undefined,
		path: () => undefined,
	};
}

type FormRead = Extract<Term, { kind: "field" | "repeat-row" }>;
function formRead(node: Expression): FormRead | undefined {
	const term = termOf(node);
	return term?.kind === "field" || term?.kind === "repeat-row"
		? term
		: undefined;
}

/** Whether a question read sits at one of the two relocation sites, and
 *  which: a `default_value` slot, or a row predicate crossing a repeat the
 *  slot is in. */
function relocationSite(
	read: FormRead,
	context: ExpressionContext,
): "default" | "row-predicate" | undefined {
	const projection = graphProjection(context);
	const target: FormNodeRef =
		read.kind === "field"
			? {
					kind: "field",
					uuid: read.uuid,
					...(read.role === undefined ? {} : { role: read.role }),
				}
			: { kind: "repeat-row", repeat: read.repeat, attribute: read.attribute };
	const coordinates = projection?.graph.path(target);
	if (
		projection !== undefined &&
		coordinates !== undefined &&
		crossesSourceRepeatInRowPredicate(coordinates, context, projection)
	)
		return "row-predicate";
	return context.slot.entity === "field" &&
		context.slot.slot === "default_value"
		? "default"
		: undefined;
}

function withSpelling(
	read: FormRead,
	spelling: "current" | undefined,
): Expression {
	const { spelling: _old, ...rest } = read;
	return {
		kind: "term",
		term: (spelling === undefined ? rest : { ...rest, spelling }) as Term,
	};
}

/** A literal typed by its own shape where it stands against a date or a
 *  date and time, or in an ordering against a value of no known type. */
function shapedLiteral(
	literal: Literal,
	opposite: Expression | undefined,
	context: ExpressionContext,
	ordering: boolean,
): Literal {
	if (literal.data_type !== undefined || typeof literal.value !== "string")
		return literal;
	const typed = shapedLiteralText(literal.value, opposite, context, ordering);
	return typed.data_type === undefined
		? literal
		: { ...literal, data_type: typed.data_type };
}

/** The mode the slot prints in, from its context: a validation condition,
 *  another XForm attribute, or an HQ JSON slot under its interpolation. */
function modeOf(context: ExpressionContext): WireMode {
	const slot = context.slot;
	if (slot.entity === "field")
		return { target: "xform", constraint: slot.slot === "validate" };
	if (slot.entity === "form") {
		if (slot.slot === "form_display_condition")
			return {
				target: "hq-json",
				interpolation:
					context.form !== undefined &&
					CASE_LOADING_FORM_TYPES.has(context.form.type)
						? "case"
						: "no-case",
			};
		if (
			slot.slot === "form_link_condition" ||
			slot.slot === "form_link_datum_xpath"
		)
			return { target: "hq-json", interpolation: "none" };
		return { target: "xform", constraint: false };
	}
	switch (slot.slot) {
		case "module_display_condition":
		case "search_input_required_when":
			return { target: "hq-json", interpolation: "no-case" };
		case "case_list_filter":
			return { target: "hq-json", interpolation: "case" };
		case "search_input_validation_rule":
			return { target: "hq-json", interpolation: "no-dots" };
		default:
			return { target: "hq-json", interpolation: "none" };
	}
}

/** The slots whose emission drops boolean identities. */
function simplifiedSlot(context: ExpressionContext): boolean {
	const slot = context.slot;
	if (slot.entity === "field") return slot.slot === "lookup_options_source";
	if (slot.entity !== "module") return false;
	return (
		slot.slot === "case_list_filter" ||
		slot.slot === "search_button_display_condition" ||
		slot.slot === "search_input_predicate" ||
		slot.slot === "search_input_options"
	);
}

function instantLiteralBranches(
	operand: InstantOperand,
	rewrite: (literal: Expression) => Expression,
	node: Expression,
): Expression {
	switch (operand.kind) {
		case "leaf":
			return stringLiteral(node) === undefined ? node : rewrite(node);
		case "if":
			if (node.kind !== "if") return node;
			return {
				...node,
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: instantLiteralBranches(operand.whenTrue, rewrite, node.then),
				else: instantLiteralBranches(operand.whenFalse, rewrite, node.else),
			};
		case "coalesce": {
			if (node.kind !== "coalesce") return node;
			const values = node.values.map((value, index) => {
				const inner = operand.values[index];
				return inner === undefined
					? value
					: instantLiteralBranches(inner, rewrite, value);
			});
			return { ...node, values: values as typeof node.values };
		}
		case "switch":
			return node;
	}
}

function relitText(node: Expression, text: string | undefined): Expression {
	const term = termOf(node);
	if (text === undefined || term?.kind !== "literal") return node;
	return text === term.value
		? node
		: { kind: "term", term: { ...term, value: text } };
}

/** The texts of the arguments a literal prints as inside a `concat`. */
function literalTexts(value: string, mode: WireMode): string[] {
	return literalArguments(value, mode, true).map((arg) => arg.text);
}

/** Every row, in the order of the table. */
export const PRINT_COLLISIONS: readonly PrintCollision[] = [
	{
		id: "field-spelling",
		rewrite(node, context) {
			const read = formRead(node);
			if (read?.spelling !== "absolute") return undefined;
			return relocationSite(read, context) === undefined
				? withSpelling(read, undefined)
				: undefined;
		},
	},
	{
		id: "default-current",
		rewrite(node, context) {
			const read = formRead(node);
			if (read === undefined || read.spelling === "current") return undefined;
			if (read.spelling === "relative") return undefined;
			return relocationSite(read, context) === "default"
				? withSpelling(read, "current")
				: undefined;
		},
	},
	{
		id: "row-predicate-current",
		rewrite(node, context) {
			const read = formRead(node);
			if (read === undefined || read.spelling === "current") return undefined;
			if (read.spelling === "relative") return undefined;
			return relocationSite(read, context) === "row-predicate"
				? withSpelling(read, "current")
				: undefined;
		},
	},
	{
		id: "literal-type",
		rewrite(node, context) {
			if (context.ruleSet !== "record") return undefined;
			if (isComparison(node)) {
				const ordering = node.kind !== "eq" && node.kind !== "neq";
				const left = termOf(node.left);
				const right = termOf(node.right);
				if (left?.kind === "literal") {
					const typed = shapedLiteral(left, node.right, context, ordering);
					if (typed !== left)
						return { ...node, left: { kind: "term", term: typed } };
				}
				if (right?.kind === "literal") {
					const typed = shapedLiteral(right, node.left, context, ordering);
					if (typed !== right)
						return { ...node, right: { kind: "term", term: typed } };
				}
				return undefined;
			}
			if (node.kind === "in") {
				const values = node.values.map((value) =>
					value.kind === "literal"
						? shapedLiteral(value, node.left, context, false)
						: value,
				);
				return values.some((value, index) => value !== node.values[index])
					? { ...node, values: values as typeof node.values }
					: undefined;
			}
			if (node.kind === "between") {
				const bound = (side: Expression | undefined) => {
					const term = side === undefined ? undefined : termOf(side);
					if (term?.kind !== "literal") return side;
					const typed = shapedLiteral(term, node.left, context, true);
					return typed === term
						? side
						: ({ kind: "term", term: typed } as const);
				};
				const lower = bound(node.lower);
				const upper = bound(node.upper);
				return lower === node.lower && upper === node.upper
					? undefined
					: {
							...node,
							...(lower === undefined ? {} : { lower }),
							...(upper === undefined ? {} : { upper }),
						};
			}
			if (node.kind === "switch") {
				const cases = node.cases.map(
					(entry): SwitchCase =>
						entry.when.kind === "literal"
							? {
									...entry,
									when: shapedLiteral(entry.when, node.on, context, false),
								}
							: entry,
				);
				return cases.some(
					(entry, index) => entry.when !== node.cases[index]?.when,
				)
					? { ...node, cases: cases as typeof node.cases }
					: undefined;
			}
			return undefined;
		},
	},
	{
		id: "instant-literal",
		rewrite(node, context) {
			if (!isComparison(node)) return undefined;
			const operands = comparisonOperands(node, context);
			if (
				comparisonPlan(node.kind, operands.left, operands.right) !== "lowered"
			)
				return undefined;
			const direct = (
				side: Expression,
				operand: InstantOperand,
			): Expression => {
				if (operand.kind === "leaf") {
					const text = stringLiteral(side);
					if (text === undefined) return side;
					const micros = literalInstantMicros(text);
					return relitText(
						side,
						micros === undefined ? undefined : instantTextOfMicros(micros),
					);
				}
				return instantLiteralBranches(
					operand,
					(literal) => {
						const text = stringLiteral(literal);
						return relitText(
							literal,
							text === undefined ? undefined : literalInstantText(text),
						);
					},
					side,
				);
			};
			const left = direct(node.left, operands.left);
			const right = direct(node.right, operands.right);
			return left === node.left && right === node.right
				? undefined
				: { ...node, left, right };
		},
	},
	{
		id: "consumer-in-branches",
		rewrite(node) {
			if (!isCall(node, "sum", 1)) return undefined;
			const [arg] = node.args;
			if (arg?.kind === "if")
				return {
					kind: "if",
					cond: arg.cond,
					// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
					then: { kind: "call", fn: "sum", args: [arg.then] },
					else: { kind: "call", fn: "sum", args: [arg.else] },
				};
			if (isCall(arg, "cond") && arg.args.length % 2 === 1)
				return {
					kind: "call",
					fn: "cond",
					args: arg.args.map((value, index) =>
						index % 2 === 1 || index === arg.args.length - 1
							? { kind: "call", fn: "sum", args: [value] }
							: value,
					),
				};
			return undefined;
		},
	},
	{
		id: "filter-identities",
		scope: "root",
		rewrite(node, context) {
			if (!simplifiedSlot(context)) return undefined;
			const slot = context.slot;
			const simplified =
				slot.entity === "module" && slot.slot === "case_list_filter"
					? (effectiveFilterForEmission(node) ?? { kind: "match-all" })
					: simplifyForEmission(node);
			return sameTree(simplified, node) ? undefined : simplified;
		},
	},
	{
		id: "table-lookup-identities",
		rewrite(node) {
			if (node.kind !== "table-lookup") return undefined;
			const where = simplifyForEmission(node.where);
			return sameTree(where, node.where) ? undefined : { ...node, where };
		},
	},
	{
		// `and(and(a, b), c)` prints `a and b and c`: the printer groups only a
		// later operand of the same precedence, so a first clause of the same
		// junction prints as that many clauses of the outer one.
		id: "junction-first-clause",
		rewrite(node) {
			if (node.kind !== "and" && node.kind !== "or") return undefined;
			const [first, ...rest] = node.clauses;
			if (first?.kind !== node.kind) return undefined;
			const [head, ...more] = first.clauses;
			return { kind: node.kind, clauses: [head, ...more, ...rest] };
		},
	},
	{
		id: "membership",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "or") return undefined;
			if (node.clauses.length < 2) return undefined;
			const first = node.clauses[0];
			if (first?.kind !== "eq") return undefined;
			const values: Literal[] = [];
			for (const clause of node.clauses) {
				if (clause.kind !== "eq" || !sameTree(clause.left, first.left))
					return undefined;
				const literal = termOf(clause.right);
				if (literal?.kind !== "literal") return undefined;
				values.push(literal);
			}
			const [head, ...rest] = values;
			return head === undefined
				? undefined
				: { kind: "in", left: first.left, values: [head, ...rest] };
		},
	},
	{
		id: "range",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "and") return undefined;
			if (node.clauses.length !== 2) return undefined;
			const [lower, upper] = node.clauses;
			if (
				(lower?.kind !== "gte" && lower?.kind !== "gt") ||
				(upper?.kind !== "lte" && upper?.kind !== "lt") ||
				!sameTree(lower.left, upper.left)
			)
				return undefined;
			return {
				kind: "between",
				left: lower.left,
				lower: lower.right,
				upper: upper.right,
				lowerInclusive: lower.kind === "gte",
				upperInclusive: upper.kind === "lte",
			};
		},
	},
	{
		id: "switch",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "if") return undefined;
			const cases: SwitchCase[] = [];
			let on: Expression | undefined;
			let at: Expression = node;
			while (at.kind === "if" && at.cond.kind === "eq") {
				const when = termOf(at.cond.right);
				if (when?.kind !== "literal") break;
				if (on === undefined) on = at.cond.left;
				else if (!sameTree(on, at.cond.left)) break;
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				cases.push({ when, then: at.then });
				at = at.else;
			}
			const [head, ...rest] = cases;
			if (on === undefined || head === undefined || rest.length === 0)
				return undefined;
			return { kind: "switch", on, cases: [head, ...rest], fallback: at };
		},
	},
	{
		id: "blank",
		rewrite(node) {
			if (node.kind !== "eq" || numberLiteral(node.right) !== 0)
				return undefined;
			if (!isCall(node.left, "string-length", 1)) return undefined;
			const inner = node.left.args[0];
			if (!isCall(inner, "string", 1)) return undefined;
			const value = inner.args[0];
			return value === undefined
				? undefined
				: { kind: "is-blank", left: value };
		},
	},
	{
		id: "normalize-space",
		rewrite(node) {
			if (!isCall(node, "replace", 3)) return undefined;
			const inner = node.args[0];
			if (
				!isCall(inner, "replace", 3) ||
				stringLiteral(inner.args[1]) !== "[ \\t\\r\\n]+" ||
				stringLiteral(inner.args[2]) !== " " ||
				stringLiteral(node.args[1]) !== "^ | $" ||
				stringLiteral(node.args[2]) !== ""
			)
				return undefined;
			const value = inner.args[0];
			return value === undefined
				? undefined
				: { kind: "call", fn: "normalize-space", args: [value] };
		},
	},
	{
		id: "quotient",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "if") return undefined;
			const zero = node.cond;
			const division = node.then;
			if (
				zero.kind !== "eq" ||
				numberLiteral(zero.right) !== 0 ||
				division.kind !== "arith" ||
				division.op !== "div" ||
				!sameTree(zero.left, division.right)
			)
				return undefined;
			const whole = node.else;
			const remainder =
				whole.kind === "arith" && whole.op === "div" ? whole.left : undefined;
			if (
				remainder?.kind !== "arith" ||
				remainder.op !== "-" ||
				!sameTree(remainder.left, division.left) ||
				remainder.right.kind !== "arith" ||
				remainder.right.op !== "mod"
			)
				return undefined;
			return {
				kind: "arith",
				op: "quotient",
				left: division.left,
				right: division.right,
			};
		},
	},
	{
		id: "rows-guard",
		rewrite(node) {
			if (node.kind !== "if") return undefined;
			const counted = node.cond;
			const empty = node.else;
			if (
				counted.kind !== "gt" ||
				numberLiteral(counted.right) !== 0 ||
				counted.left.kind !== "count" ||
				(stringLiteral(empty) !== "" && numberLiteral(empty) !== 0)
			)
				return undefined;
			const rows = counted.left.via;
			if (
				typeof rows !== "object" ||
				!("kind" in rows) ||
				(rows.kind !== "table-rows" &&
					rows.kind !== "locations" &&
					rows.kind !== "selected-cases")
			)
				return undefined;
			return node.then;
		},
	},
	{
		id: "literal-pieces",
		rewrite(node, context) {
			if (node.kind !== "concat") return undefined;
			const mode = modeOf(context);
			if (mode.target !== "xform" && mode.target !== "hq-json")
				return undefined;
			const pieces: Expression[] = [];
			for (const part of node.parts) {
				const text = stringLiteral(part);
				if (text === undefined) {
					pieces.push(part);
					continue;
				}
				for (const piece of literalTexts(text, mode))
					pieces.push({
						kind: "term",
						term: { kind: "literal", value: piece },
					});
			}
			const parts: Expression[] = [];
			let index = 0;
			while (index < pieces.length) {
				let end = index;
				while (end < pieces.length && stringLiteral(pieces[end]) !== undefined)
					end++;
				if (end === index) {
					parts.push(pieces[index] as Expression);
					index++;
					continue;
				}
				const run = pieces
					.slice(index, end)
					.map((piece) => stringLiteral(piece) as string);
				const joined = run.join("");
				const split = literalTexts(joined, mode);
				if (
					split.length === run.length &&
					split.every((piece, at) => piece === run[at])
				)
					parts.push({
						kind: "term",
						term: { kind: "literal", value: joined },
					});
				else
					for (const piece of run)
						parts.push({
							kind: "term",
							term: { kind: "literal", value: piece },
						});
				index = end;
			}
			const [only, ...more] = parts;
			if (only === undefined) return undefined;
			const result: Expression =
				more.length === 0 ? only : { kind: "concat", parts: [only, ...more] };
			return sameTree(result, node) ? undefined : result;
		},
	},
	{
		id: "input-presence",
		rewrite(node, context) {
			if (context.ruleSet !== "record" || node.kind !== "if") return undefined;
			if (node.else.kind !== "match-all" || node.cond.kind !== "count")
				return undefined;
			const via = node.cond.via;
			const input =
				typeof via === "object" && "kind" in via && via.kind === "term"
					? via.term
					: undefined;
			if (input?.kind !== "input") return undefined;
			return { kind: "when-input-present", input, clause: node.then };
		},
	},
];

/** Every collision applied bottom-up until none applies. It never parses and
 *  never prints. */
export function canonicalExpression(
	expression: Expression,
	context: ExpressionContext,
): Expression {
	const contextAt = (path: CheckPath): ExpressionContext =>
		path.length === 0
			? context
			: expressionContextAtPath(expression, context, path);
	const settle = (
		node: Expression,
		at: ExpressionContext,
		root: boolean,
	): Expression => {
		let current = node;
		for (let turn = 0; turn < PRINT_COLLISIONS.length * 4; turn++) {
			let next: Expression | undefined;
			for (const row of PRINT_COLLISIONS) {
				if (row.scope === "root" && !root) continue;
				next = row.rewrite(current, at);
				if (next !== undefined && next !== current) break;
				next = undefined;
			}
			if (next === undefined) return current;
			current = next;
		}
		return current;
	};
	const visit = (node: Expression, path: CheckPath): Expression => {
		const children = mapExpressionChildren(
			node,
			(child) =>
				child.kind === "expression"
					? visit(child.value, child.path)
					: child.value,
			path,
		);
		return settle(children, contextAt(path), path.length === 0);
	};
	return visit(expression, []);
}
