/**
 * Preview's fold of a CSQL clause (06-csql.md §4).
 *
 * On a device, Core evaluates every runtime piece of an `_xpath_query` value
 * before HQ sees the text: each runtime segment's value, each choice between
 * clauses, and the obligations that send the whole value as `match-none()`.
 * Preview evaluates the same pieces in the browser (`csqlRuntimeReads` names
 * them) and sends the results; `foldCsqlRuntime` then rewrites the clause so
 * that it holds only what HQ itself reads:
 *
 * - each runtime subtree in a value position becomes a literal of its node's
 *   type (a `selected-any`/`selected-all` value its tokens, split on ASCII
 *   whitespace as HQ's analysed match splits them);
 * - each runtime choice becomes its chosen branch (`if` and `switch` between
 *   clauses, `when-input-present`, and a clause that reads no case row,
 *   which becomes `match-all` or `match-none`);
 * - a row whose obligations hold becomes `match-none`.
 *
 * Keys are the emitter's segment keys: checker paths (`csqlPositionKey`) in
 * the clause as `emitter.ts::prepareCsqlClause` prepares it, so the fold
 * prepares the clause the same way before it substitutes. A key the values
 * do not carry leaves its node as it is.
 */
import {
	type ExpressionChild,
	expressionChildPath,
	expressionChildren,
} from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import {
	type CsqlPositionMap,
	type CsqlRuntimeRoot,
	csqlPositionKey,
	csqlPositions,
	csqlRuntimeRoots,
} from "@/lib/domain/expression/csqlPositions";
import { DISTANCE_UNITS } from "@/lib/domain/expression/distance";
import { mapExpressionChildren } from "@/lib/domain/expression/mapAst";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import {
	expressionChildContext,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import type {
	CheckPath,
	Expression,
	Literal,
	Term,
} from "@/lib/domain/expression/types";
import type { WireExpr } from "../xpath/wire/tree";
import { type CsqlEmissionContext, prepareCsqlClause } from "./emitter";
import { csqlClauseWrapper } from "./print";
import type { RuntimeCsqlRejection } from "./segment";
import type { CsqlNode } from "./tree";

/** What Core gave each runtime piece of one `_xpath_query` row. */
export interface CsqlRuntimeValues {
	/** Each runtime segment's value, as text, by segment key. */
	readonly segments: Readonly<Record<string, string>>;
	/** Each runtime choice's condition, by its key. */
	readonly choices: Readonly<Record<string, boolean>>;
	/** The row's obligations hold: the device sends `match-none()`. */
	readonly rejected?: boolean;
}

/** The pieces of one row the device evaluates: the wire tree of each
 * runtime segment's value and of each choice's condition, by key. */
export interface CsqlRuntimeReads {
	readonly segments: readonly {
		readonly key: string;
		readonly value: WireExpr;
	}[];
	readonly choices: readonly {
		readonly key: string;
		readonly condition: WireExpr;
	}[];
}

/** One `_xpath_query` row: its CSQL tree, what the device evaluates in it,
 * and its obligations. */
export interface CsqlRuntimeRow {
	readonly reads: CsqlRuntimeReads;
	readonly rejections: readonly RuntimeCsqlRejection[];
}

/**
 * The runtime pieces of a CSQL tree, in tree order. A segment inside a
 * choice's branch is listed too: the device prints it only when the branch
 * is taken, and the fold reads it only then. A list item that reads several
 * nodes is read as the device splices it, its values joined by `","`.
 */
export function csqlRuntimeReads(tree: CsqlNode): CsqlRuntimeReads {
	const segments: { key: string; value: WireExpr }[] = [];
	const choices: { key: string; condition: WireExpr }[] = [];
	const visit = (node: CsqlNode): void => {
		switch (node.k) {
			case "cmp":
				visit(node.left);
				visit(node.right);
				return;
			case "and":
			case "or":
				for (const item of node.items) visit(item);
				return;
			case "not":
			case "group":
				visit(node.item);
				return;
			case "guarded":
				visit(node.item);
				return;
			case "query-call":
			case "value-call":
				for (const arg of node.args) visit(arg);
				return;
			case "step":
			case "literal":
			case "number":
				return;
			case "json-list":
				for (const item of node.items)
					if (item.k === "runtime")
						segments.push({
							key: item.hole.key,
							value: item.hole.print ?? item.hole.value,
						});
				return;
			case "runtime":
				segments.push({ key: node.hole.key, value: node.hole.value });
				return;
			case "choice":
				choices.push({ key: node.key, condition: node.condition });
				visit(node.then);
				visit(node.else);
				return;
			case "presence":
				choices.push({
					key: node.key,
					condition: { k: "call", fn: "count", args: [node.trigger] },
				});
				visit(node.clause);
				return;
			default: {
				const exhaustive: never = node;
				throw new Error(`Unknown CSQL node ${String(exhaustive)}.`);
			}
		}
	};
	visit(tree);
	return { segments, choices };
}

/** The runtime row of one tree: its reads and its wrapper's obligations. */
export function csqlRuntimeRow(tree: CsqlNode): CsqlRuntimeRow {
	return {
		reads: csqlRuntimeReads(tree),
		rejections: csqlClauseWrapper(tree).runtimeRejections ?? [],
	};
}

/** Fold one `_xpath_query` row with what Core gave its runtime pieces. */
export function foldCsqlRuntime(
	expression: Expression,
	values: CsqlRuntimeValues,
	context: Pick<CsqlEmissionContext, "types">,
): Expression {
	if (values.rejected === true) return { kind: "match-none" };
	const prepared = prepareCsqlClause(expression, context);
	const runtimeRoots = new Map(
		csqlRuntimeRoots(prepared).map(
			(root) => [csqlPositionKey(root.path), root] as const,
		),
	);
	return new Fold(values, csqlPositions(prepared), runtimeRoots).expression(
		prepared,
		[],
		context.types,
	);
}

class Fold {
	constructor(
		private readonly values: CsqlRuntimeValues,
		private readonly positions: CsqlPositionMap,
		private readonly runtimeRoots: ReadonlyMap<string, CsqlRuntimeRoot>,
	) {}

	private segment(path: CheckPath): string | undefined {
		return ownValue(this.values.segments, csqlPositionKey(path));
	}

	private choice(path: CheckPath): boolean | undefined {
		return ownValue(this.values.choices, csqlPositionKey(path));
	}

	expression(
		node: Expression,
		path: CheckPath,
		types: ExpressionContext,
	): Expression {
		const root = this.runtimeRoots.get(csqlPositionKey(path));
		if (root !== undefined) return this.runtimeRoot(node, path, root, types);
		switch (node.kind) {
			case "when-input-present": {
				const present = this.choice(path);
				const clausePath = operandPath(node, "clause", path);
				if (present === false) return { kind: "match-all" };
				const clause = this.expression(
					node.clause,
					clausePath,
					childTypes(node, "clause", types),
				);
				return present === true ? clause : { ...node, clause };
			}
			case "if": {
				if (
					!this.runtimeRoots.has(
						csqlPositionKey(operandPath(node, "cond", path)),
					)
				)
					break;
				const taken = this.choice(path);
				if (taken === undefined) break;
				const slot = taken ? "then" : "else";
				return this.expression(
					node[slot],
					operandPath(node, slot, path),
					childTypes(node, slot, types),
				);
			}
			case "switch": {
				if (this.positions.get(csqlPositionKey(path)) !== "query") break;
				const chosen = this.switchBranch(node, path, types);
				if (chosen !== undefined) return chosen;
				break;
			}
			case "multi-select-contains":
				return this.selection(node, path, types);
			case "within-distance":
				return this.distance(node, path, types);
			case "value-list":
				return this.valueList(node, path, types);
			default:
				break;
		}
		return this.children(node, path, types);
	}

	private children<T extends Expression>(
		node: T,
		path: CheckPath,
		types: ExpressionContext,
	): T {
		return mapExpressionChildren(
			node,
			(child) => this.child(node, child, types),
			path,
		);
	}

	private child(
		parent: Expression,
		child: ExpressionChild,
		types: ExpressionContext,
	): Expression | Term | ExpressionChild["value"] {
		if (child.kind !== "expression") return child.value;
		return this.expression(
			child.value,
			child.path,
			expressionChildContext(parent, child, types),
		);
	}

	private runtimeRoot(
		node: Expression,
		path: CheckPath,
		root: CsqlRuntimeRoot,
		types: ExpressionContext,
	): Expression {
		if (root.within === "query") {
			// A clause that reads no case row: the device chose `match-all()`
			// or `match-none()`.
			const holds = this.choice(path);
			if (holds === undefined) return node;
			return { kind: holds ? "match-all" : "match-none" };
		}
		const text = this.segment(path);
		if (text === undefined) return node;
		return { kind: "term", term: literalOf(text, node, types) };
	}

	/** The case a `switch` between clauses takes: the first whose `when` the
	 * device found equal, else the fallback once every case is decided. */
	private switchBranch(
		node: Extract<Expression, { kind: "switch" }>,
		path: CheckPath,
		types: ExpressionContext,
	): Expression | undefined {
		for (const [index, entry] of node.cases.entries()) {
			const whenPath = expressionChildPath(
				"switch",
				{ kind: "switch-case", index, slot: "when" },
				path,
			);
			const taken = this.choice(whenPath);
			if (taken === undefined) return undefined;
			if (!taken) continue;
			const thenPath = expressionChildPath(
				"switch",
				{ kind: "switch-case", index, slot: "then" },
				path,
			);
			return this.expression(
				entry.then,
				thenPath,
				switchCaseTypes(node, index, types),
			);
		}
		const fallbackPath = operandPath(node, "fallback", path);
		return this.expression(
			node.fallback,
			fallbackPath,
			childTypes(node, "fallback", types),
		);
	}

	/** A runtime `selected-any`/`selected-all` value becomes its tokens, as
	 * HQ's analysed match splits the text (`query_functions.py::_selected_query`). */
	private selection(
		node: Extract<Expression, { kind: "multi-select-contains" }>,
		path: CheckPath,
		types: ExpressionContext,
	): Expression {
		const values: (typeof node.values)[number][] = [];
		let changed = false;
		for (const [index, entry] of node.values.entries()) {
			if (entry.kind === "literal" || entry.kind === "choice") {
				values.push(entry);
				continue;
			}
			const entryPath = expressionChildPath(
				node.kind,
				{ kind: "item", slot: "values", index },
				path,
			);
			const text = this.runtimeRoots.has(csqlPositionKey(entryPath))
				? this.segment(entryPath)
				: undefined;
			if (text === undefined) {
				values.push(entry);
				continue;
			}
			changed = true;
			for (const token of asciiTokens(text))
				values.push({ kind: "literal", value: token });
		}
		if (!changed) return this.children(node, path, types);
		const [first, ...rest] = values;
		// No token at all: `selected-any(p, '')` and `selected-all(p, '')`
		// match no case, and the blank guard sends `match-none()`.
		if (first === undefined) return { kind: "match-none" };
		return { ...node, values: [first, ...rest] };
	}

	/** A runtime radius and unit become a number and one of HQ's nine units;
	 * a value that is neither stays text, which matches no case. */
	private distance(
		node: Extract<Expression, { kind: "within-distance" }>,
		path: CheckPath,
		types: ExpressionContext,
	): Expression {
		let result = this.children(node, path, types);
		if (typeof node.distance !== "number") {
			const text = this.segment(operandPath(node, "distance", path));
			if (text !== undefined) {
				const radius = Number(text.trim());
				result = {
					...result,
					distance:
						text.trim() !== "" && Number.isFinite(radius) && radius > 0
							? radius
							: { kind: "term", term: { kind: "literal", value: text } },
				};
			}
		}
		if (typeof node.unit !== "string") {
			const text = this.segment(operandPath(node, "unit", path));
			if (text !== undefined)
				result = {
					...result,
					unit: (DISTANCE_UNITS as readonly string[]).includes(text)
						? (text as (typeof DISTANCE_UNITS)[number])
						: { kind: "term", term: { kind: "literal", value: text } },
				};
		}
		return result;
	}

	/** A runtime list item becomes its text; one that reads several nodes
	 * becomes one item per node, as the device splices them `","`-joined
	 * (the `list-item` obligation keeps a `"` out of every value). A node-set
	 * that reads no node joins to `''`, so the device sends `[""]` there: one
	 * blank item, exactly as it does for one blank node. */
	private valueList(
		node: Extract<Expression, { kind: "value-list" }>,
		path: CheckPath,
		types: ExpressionContext,
	): Expression {
		const items: Expression[] = [];
		for (const [index, item] of node.items.entries()) {
			const itemPath = expressionChildPath(
				node.kind,
				{ kind: "item", slot: "items", index },
				path,
			);
			const text = this.runtimeRoots.has(csqlPositionKey(itemPath))
				? this.segment(itemPath)
				: undefined;
			if (text === undefined) {
				items.push(item);
				continue;
			}
			const data = typeOf(item, types)?.data;
			const many =
				typeof data === "object" &&
				data !== null &&
				data.cardinality === "many";
			if (!many) {
				items.push({ kind: "term", term: literalOf(text, item, types) });
				continue;
			}
			for (const value of text.split('","'))
				items.push({ kind: "term", term: { kind: "literal", value } });
		}
		// Every authored item gave at least one item above.
		const [first, ...rest] = items;
		if (first === undefined) return node;
		return { ...node, items: [first, ...rest] };
	}
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string) {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function operandPath(
	parent: Expression,
	slot: string,
	path: CheckPath,
): CheckPath {
	return expressionChildPath(parent.kind, { kind: "operand", slot }, path);
}

function childTypes(
	parent: Expression,
	slot: string,
	types: ExpressionContext,
): ExpressionContext {
	const child = expressionChildren(parent).find(
		(entry) => entry.role.kind === "operand" && entry.role.slot === slot,
	);
	return child === undefined
		? types
		: expressionChildContext(parent, child, types);
}

function switchCaseTypes(
	parent: Extract<Expression, { kind: "switch" }>,
	index: number,
	types: ExpressionContext,
): ExpressionContext {
	const child = expressionChildren(parent).find(
		(entry) =>
			entry.role.kind === "switch-case" &&
			entry.role.index === index &&
			entry.role.slot === "then",
	);
	return child === undefined
		? types
		: expressionChildContext(parent, child, types);
}

const ASCII_WHITESPACE = new Set([" ", "\t", "\n", "\f", "\r"]);

function asciiTokens(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	for (const char of text) {
		if (ASCII_WHITESPACE.has(char)) {
			if (current !== "") tokens.push(current);
			current = "";
		} else current += char;
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

/**
 * A runtime value as a literal of its node's type: a number for a numeric
 * node whose text is one, a typed date, date and time or time where the text
 * has that shape, and text otherwise, which is how HQ reads the spliced
 * value.
 */
function literalOf(
	text: string,
	node: Expression,
	types: ExpressionContext,
): Literal {
	const data = scalarDataType(typeOf(node, types)?.data);
	switch (data) {
		case "int":
		case "decimal": {
			const trimmed = text.trim();
			const number = Number(trimmed);
			return trimmed !== "" && Number.isFinite(number)
				? { kind: "literal", value: number, data_type: data }
				: { kind: "literal", value: text };
		}
		case "date":
		case "datetime":
		case "time": {
			const shape = literalShape(text)?.type;
			return shape === data
				? { kind: "literal", value: text, data_type: data }
				: { kind: "literal", value: text };
		}
		default:
			return { kind: "literal", value: text };
	}
}
