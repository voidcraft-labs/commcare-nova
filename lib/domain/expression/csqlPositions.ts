/**
 * Where each node of a CommCare search query (CSQL) slot is read.
 *
 * HQ's search compiler reads a CSQL string in four ways, and the device adds
 * a fifth (docs/plans/hq-round-trip/3-expressions/06-csql.md §2.1):
 *
 * - `query`: HQ builds a filter from it (`case_search/filter_dsl.py::build_filter_from_ast`):
 *   the slot root, `and`/`or` clauses, `not.clause`, an `exists`/`missing`
 *   or child-case `count` filter, `when-input-present.clause`, and the
 *   branches of a choice the device makes between clauses.
 * - `anchor`: the left side of a comparison, a case property, the record's
 *   case type or a child-case count (`xpath_functions/comparison.py::property_comparison_query`).
 * - `server-value`: HQ evaluates it (`dsl_utils.py::unwrap_value`): a
 *   comparison's other side, `in` values, `between` bounds, the value of
 *   `fuzzy` and `fuzzy-date`, and the operands of HQ's value functions.
 * - `raw`: HQ reads the argument as written (`query_functions.py::_selected_query`,
 *   `::starts_with`, `::phonetic_match`, `::within_distance`, `value_functions.py::unwrap_list`).
 * - `runtime`: Core evaluates it on the device inside the `_xpath_query`
 *   concat, before HQ sees the text.
 *
 * A node's position comes from its parent's, top down from the slot root,
 * which is `query`. Every descendant of a `runtime` node is `runtime`. Below
 * a `server-value` or `raw` position, the largest subtree that is neither a
 * literal nor (in `server-value` only) one of HQ's value functions is
 * `runtime`. `today` is `runtime` everywhere (the worker's day, decision 6).
 * A choice the device makes between clauses has a `runtime` condition, and a
 * query-position clause that reads no case row is `runtime` whole. An `if`
 * whose condition reads the row, and a `switch` whose selector does, are
 * HQ's own clauses instead.
 *
 * Positions are keyed by the node's checker path (`CheckPath`, the path
 * `children.ts::expressionChildren` gives each child) through
 * `csqlPositionKey`, the same `JSON.stringify` key spans and the checker's
 * child types use. A `term` expression and its term share one path, and so
 * one position. Comparisons are read by their query side, so a tree whose
 * anchor sits on the right (as authored) and the same tree with it swapped
 * left (as `lib/commcare/csql/representability.ts::normalizeCsqlPredicate`
 * writes it) get the same positions under their own paths.
 *
 * In a slot that is not CSQL no node has a position: callers ask only for a
 * CSQL slot's expression.
 */
import { expressionChildren } from "./children";
import type { CheckPath, Expression, Term } from "./types";
import { isConditionArm, isRelationPath } from "./types";

export type CsqlPosition =
	| "query"
	| "anchor"
	| "server-value"
	| "raw"
	| "runtime";

/** Positions by `csqlPositionKey(path)`. */
export type CsqlPositionMap = ReadonlyMap<string, CsqlPosition>;

/** One runtime subtree: a `runtime` node whose parent is not `runtime`. */
export interface CsqlRuntimeRoot {
	readonly path: CheckPath;
	readonly node: Expression | Term;
	/** The position the subtree sits in: `query` for a whole clause or a
	 * choice's condition, `server-value` or `raw` for a value. */
	readonly within: Exclude<CsqlPosition, "runtime">;
}

export function csqlPositionKey(path: CheckPath): string {
	return JSON.stringify(path);
}

/** The position of every node of a CSQL slot's expression, by path. */
export function csqlPositions(root: Expression): CsqlPositionMap {
	return analyse(root).positions;
}

/** The runtime subtrees of a CSQL slot's expression, in tree order. */
export function csqlRuntimeRoots(root: Expression): readonly CsqlRuntimeRoot[] {
	return analyse(root).runtimeRoots;
}

export function csqlPositionAt(
	positions: CsqlPositionMap,
	path: CheckPath,
): CsqlPosition | undefined {
	return positions.get(csqlPositionKey(path));
}

/** Whether `path` holds a runtime node whose parent is not runtime. The root
 * of the slot is never one: a slot root reading no row is a runtime clause,
 * and its parent is the slot. */
export function isRuntimeSubtreeRoot(
	positions: CsqlPositionMap,
	path: CheckPath,
): boolean {
	if (csqlPositionAt(positions, path) !== "runtime") return false;
	for (let length = path.length - 1; length >= 0; length--) {
		const parent = positions.get(csqlPositionKey(path.slice(0, length)));
		if (parent !== undefined) return parent !== "runtime";
	}
	return true;
}

/** HQ's value functions (`xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`)
 * that stay in a `server-value` position. `today` is not among them: Nova
 * sends the worker's day (decision 6). */
export function isCsqlServerValueFunction(expression: Expression): boolean {
	switch (expression.kind) {
		case "now":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "date-add":
		case "value-list":
			return true;
		default:
			return false;
	}
}

/** A comparison's query side: a case property, the record's case type, or a
 * child-case count. */
export function isCsqlQueryAnchor(expression: Expression): boolean {
	if (expression.kind === "term")
		return (
			expression.term.kind === "prop" ||
			expression.term.kind === "case-row-type"
		);
	return (
		expression.kind === "count" &&
		isRelationPath(expression.via) &&
		expression.via.kind === "subcase"
	);
}

/**
 * Whether a clause reads the case row the search tests: a case property,
 * the record's case type or an index of it, or a related case. A read inside
 * a query of its own (`cases`, `table-rows`, `locations`, a `project` over
 * one) reads that query's rows, not the search's.
 */
export function readsSearchRow(node: Expression | Term): boolean {
	switch (node.kind) {
		case "prop":
		case "case-row-type":
		case "case-index":
			return true;
		case "exists":
		case "missing":
			return true;
		case "count":
			if (isRelationPath(node.via)) return true;
			break;
		case "cases":
		case "table-rows":
		case "locations":
		case "project":
			return false;
		default:
			break;
	}
	return expressionChildren(node).some(
		(child) => child.kind !== "relation" && readsSearchRow(child.value),
	);
}

const COMPARISONS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
/** Clauses that combine clauses and stay HQ's whatever their clauses read. */
const LOGICAL = new Set(["and", "or", "not", "when-input-present"]);

interface Analysis {
	readonly positions: Map<string, CsqlPosition>;
	readonly runtimeRoots: CsqlRuntimeRoot[];
}

const cache = new WeakMap<Expression, Analysis>();

function analyse(root: Expression): Analysis {
	const cached = cache.get(root);
	if (cached !== undefined) return cached;
	const analysis: Analysis = { positions: new Map(), runtimeRoots: [] };
	query(root, [], analysis);
	cache.set(root, analysis);
	return analysis;
}

function set(
	analysis: Analysis,
	path: CheckPath,
	position: CsqlPosition,
): void {
	analysis.positions.set(csqlPositionKey(path), position);
}

function runtime(
	node: Expression | Term,
	path: CheckPath,
	within: Exclude<CsqlPosition, "runtime">,
	analysis: Analysis,
): void {
	analysis.runtimeRoots.push({ path, node, within });
	markRuntime(node, path, analysis);
}

function markRuntime(
	node: Expression | Term,
	path: CheckPath,
	analysis: Analysis,
): void {
	set(analysis, path, "runtime");
	for (const child of expressionChildren(node, path))
		if (child.kind !== "relation")
			markRuntime(child.value, child.path, analysis);
}

function query(node: Expression, path: CheckPath, analysis: Analysis): void {
	if (node.kind === "match-all" || node.kind === "match-none") {
		set(analysis, path, "query");
		return;
	}
	if (!LOGICAL.has(node.kind) && !readsSearchRow(node)) {
		runtime(node, path, "query", analysis);
		return;
	}
	set(analysis, path, "query");
	const children = expressionChildren(node, path);
	const operand = (slot: string) =>
		children.find(
			(child) => child.role.kind === "operand" && child.role.slot === slot,
		);
	if (!isConditionArm(node)) {
		if (node.kind === "if") {
			const cond = operand("cond");
			if (cond?.kind === "expression") {
				if (readsSearchRow(cond.value)) query(cond.value, cond.path, analysis);
				else runtime(cond.value, cond.path, "query", analysis);
			}
			for (const slot of ["then", "else"]) {
				const branch = operand(slot);
				if (branch?.kind === "expression")
					query(branch.value, branch.path, analysis);
			}
			return;
		}
		if (node.kind === "switch") {
			// Each case's condition is `on = when`. A selector that reads the row
			// makes the choice HQ's own, case by case, as `if` does: `on` is the
			// comparisons' query side and each `when` their value. Otherwise the
			// device decides every case.
			const native = readsSearchRow(node.on);
			for (const child of children) {
				if (child.kind === "relation") continue;
				const branch =
					(child.role.kind === "switch-case" && child.role.slot === "then") ||
					(child.role.kind === "operand" && child.role.slot === "fallback");
				if (branch && child.kind === "expression")
					query(child.value, child.path, analysis);
				else if (!native) runtime(child.value, child.path, "query", analysis);
				else if (child.role.kind === "operand" && child.role.slot === "on")
					anchor(child, analysis);
				else value(child, "server-value", analysis);
			}
			return;
		}
		// Any other value that reads the row is no clause HQ can build; it keeps
		// the query position and representability names it.
		for (const child of children) value(child, "server-value", analysis);
		return;
	}
	switch (node.kind) {
		case "and":
		case "or":
		case "not":
			for (const child of children)
				if (child.kind === "expression")
					query(child.value, child.path, analysis);
			return;
		case "when-input-present":
			for (const child of children) {
				if (child.kind === "relation") continue;
				if (child.role.kind === "operand" && child.role.slot === "clause") {
					if (child.kind === "expression")
						query(child.value, child.path, analysis);
				} else runtime(child.value, child.path, "query", analysis);
			}
			return;
		case "exists":
		case "missing":
			for (const child of children)
				if (child.kind === "expression")
					query(child.value, child.path, analysis);
			return;
		default:
			break;
	}
	if (COMPARISONS.has(node.kind) && "left" in node && "right" in node) {
		const left = operand("left");
		const right = operand("right");
		const swapped =
			!isCsqlQueryAnchor(node.left) && isCsqlQueryAnchor(node.right);
		const anchorSide = swapped ? right : left;
		const valueSide = swapped ? left : right;
		if (anchorSide !== undefined) anchor(anchorSide, analysis);
		if (valueSide !== undefined) value(valueSide, "server-value", analysis);
		return;
	}
	for (const child of children) {
		if (child.kind === "relation") continue;
		const slot =
			child.role.kind === "operand" || child.role.kind === "item"
				? child.role.slot
				: undefined;
		if (slot === "left" || slot === "property") {
			anchor(child, analysis);
			continue;
		}
		value(child, valuePosition(node, slot), analysis);
	}
}

/** The position a condition gives its non-anchor operand `slot`. */
function valuePosition(
	node: Expression,
	slot: string | undefined,
): "server-value" | "raw" {
	switch (node.kind) {
		case "match":
			return node.mode === "fuzzy" || node.mode === "fuzzy-date"
				? "server-value"
				: "raw";
		case "multi-select-contains":
		case "within-distance":
		case "matches-pattern":
			return "raw";
		default:
			// `in` values and `between` bounds.
			return slot === undefined ? "raw" : "server-value";
	}
}

type Child = ReturnType<typeof expressionChildren>[number];

function anchor(child: Child, analysis: Analysis): void {
	if (child.kind === "relation") return;
	set(analysis, child.path, "anchor");
	const node = child.value;
	if (node.kind !== "count" && node.kind !== "term") {
		// No anchor HQ reads; representability refuses the comparison. Its
		// parts are values the comparison would need from HQ.
		for (const part of expressionChildren(node, child.path))
			value(part, "server-value", analysis);
		return;
	}
	if (node.kind === "count")
		for (const part of expressionChildren(node, child.path))
			if (part.kind === "expression") query(part.value, part.path, analysis);
}

function value(
	child: Child,
	position: "server-value" | "raw",
	analysis: Analysis,
): void {
	if (child.kind === "relation") return;
	const node = child.value;
	const term = child.kind === "term" ? child.value : undefined;
	const expression = child.kind === "expression" ? child.value : undefined;
	const leaf =
		term ?? (expression?.kind === "term" ? expression.term : undefined);
	if (leaf !== undefined && staysInValuePosition(leaf)) {
		set(analysis, child.path, position);
		return;
	}
	if (
		position === "server-value" &&
		expression !== undefined &&
		isCsqlServerValueFunction(expression)
	) {
		set(analysis, child.path, position);
		for (const part of expressionChildren(expression, child.path))
			value(
				part,
				expression.kind === "value-list" ? "raw" : "server-value",
				analysis,
			);
		return;
	}
	runtime(node, child.path, position, analysis);
}

/** Leaves HQ reads as written: literals, and the reads it refuses on a value
 * side (`case-property-on-value-side`), which keep the value position so the
 * refusal names them. */
function staysInValuePosition(term: Term): boolean {
	switch (term.kind) {
		case "literal":
		case "choice":
		case "case-type":
		case "prop":
		case "case-row-type":
			return true;
		default:
			return false;
	}
}
