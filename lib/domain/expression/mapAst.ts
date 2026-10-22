/** Identity-sharing, pre-order expression mapping through the canonical edge table. */
import {
	type ExpressionChild,
	type ExpressionChildRole,
	type ExpressionNode,
	expressionChildren,
} from "./children";
import { DISTANCE_UNITS } from "./distance";
import {
	type CheckPath,
	type Expression,
	FORMAT_DATE_PRESETS,
	isExpression,
	isRelationPath,
	type RelationPath,
	type Term,
} from "./types";
export interface AstMapHooks {
	readonly mapExpression?: (
		expression: Expression,
		path: CheckPath,
	) => Expression | undefined;
	readonly mapTerm?: (term: Term, path: CheckPath) => Term | undefined;
	readonly mapRelation?: (
		relation: RelationPath,
		path: CheckPath,
	) => RelationPath | undefined;
}
/** Only a distinct replacement stops descent. Returning the input means keep walking. */
export function mapExpressionAst(
	expression: Expression,
	hooks: AstMapHooks,
	path: CheckPath = [],
): Expression {
	const replacement = hooks.mapExpression?.(expression, path);
	if (replacement !== undefined && replacement !== expression)
		return replacement;
	return mapChildren(expression, hooks, path) as Expression;
}
function mapTermAst(term: Term, hooks: AstMapHooks, path: CheckPath): Term {
	const replacement = hooks.mapTerm?.(term, path);
	if (replacement !== undefined && replacement !== term) return replacement;
	return mapChildren(term, hooks, path) as Term;
}
function mapChild(
	child: ExpressionChild,
	hooks: AstMapHooks,
): Expression | Term | RelationPath {
	switch (child.kind) {
		case "expression":
			return mapExpressionAst(child.value, hooks, child.path);
		case "term":
			return mapTermAst(child.value, hooks, child.path);
		case "relation":
			return hooks.mapRelation?.(child.value, child.path) ?? child.value;
	}
}
/** A subject slot that stores a case property as a bare reference and any
 * other value as an expression. */
function isWidenedPropertySlot(
	parent: ExpressionNode,
	role: ExpressionChildRole,
): boolean {
	return (
		role.kind === "operand" &&
		role.slot === "property" &&
		(parent.kind === "match" || parent.kind === "multi-select-contains")
	);
}
function guardDirectTerm(
	parent: ExpressionNode,
	role: ExpressionChildRole,
	value: Term,
): void {
	let valid = true;
	if (role.kind === "operand") {
		if (role.slot === "property" && parent.kind === "within-distance")
			valid = value.kind === "prop";
		if (isWidenedPropertySlot(parent, role)) valid = value.kind === "prop";
		if (role.slot === "input" && parent.kind === "when-input-present")
			valid = value.kind === "input";
		if (role.slot === "value" && parent.kind === "project")
			valid = [
				"prop",
				"case-row-type",
				"case-index",
				"table-column",
				"location-field",
			].includes(value.kind);
	} else if (
		(role.kind === "item" &&
			role.slot === "values" &&
			(parent.kind === "in" || parent.kind === "multi-select-contains")) ||
		(role.kind === "switch-case" && role.slot === "when")
	)
		valid = value.kind === "literal" || value.kind === "choice";
	if (!valid)
		throw new Error(
			`Cannot put a ${value.kind} term in ${parent.kind}'s ${role.kind} slot.`,
		);
}
/** Keep the one literal/property representation of widened slots, without losing annotations. */
function canonicalChild(
	parent: ExpressionNode,
	role: ExpressionChildRole,
	value: Expression | Term | RelationPath,
): Expression | Term | RelationPath | string | number {
	if (!isExpression(value) || value.kind !== "term") return value;
	if (isWidenedPropertySlot(parent, role) && value.term.kind === "prop")
		return value.term;
	if (
		role.kind === "item" &&
		role.slot === "values" &&
		parent.kind === "multi-select-contains" &&
		(value.term.kind === "literal" || value.term.kind === "choice")
	)
		return value.term;
	if (
		value.term.kind !== "literal" ||
		value.term.data_type !== undefined ||
		role.kind !== "operand"
	)
		return value;
	const literal = value.term.value;
	if (role.slot === "pattern" && typeof literal === "string") {
		if (parent.kind === "matches-pattern") return literal;
		if (
			parent.kind === "format-date" &&
			!(FORMAT_DATE_PRESETS as readonly string[]).includes(literal)
		)
			return literal;
	}
	if (parent.kind === "within-distance") {
		if (role.slot === "distance" && typeof literal === "number") return literal;
		if (
			role.slot === "unit" &&
			typeof literal === "string" &&
			(DISTANCE_UNITS as readonly string[]).includes(literal)
		)
			return literal;
	}
	return value;
}
function replaceChild(
	parent: ExpressionNode,
	role: ExpressionChildRole,
	value: Expression | Term | RelationPath | string | number,
): ExpressionNode {
	// Roles originate only in expressionChildren; this is the inverse of that typed edge table.
	const record = parent as unknown as Record<string, unknown>;
	switch (role.kind) {
		case "operand":
			return { ...parent, [role.slot]: value } as ExpressionNode;
		case "item": {
			const items = record[role.slot] as readonly unknown[];
			const next = items.slice();
			next[role.index] = value;
			return { ...parent, [role.slot]: next } as ExpressionNode;
		}
		case "switch-case": {
			if (parent.kind !== "switch")
				throw new Error("A switch branch needs a switch expression.");
			const cases = parent.cases.slice();
			cases[role.index] = {
				...cases[role.index],
				[role.slot]: value,
			} as (typeof cases)[number];
			return { ...parent, cases: cases as typeof parent.cases };
		}
		case "form-step-filter": {
			if (
				parent.kind !== "field" &&
				parent.kind !== "form-node" &&
				parent.kind !== "repeat-row"
			)
				throw new Error("A form path filter needs a form node.");
			if (parent.filters === undefined)
				throw new Error("The form path filter is missing.");
			const filters = parent.filters.slice();
			const filter = filters[role.filterIndex];
			const where = filter.where.slice();
			where[role.predicateIndex] = value as Expression;
			filters[role.filterIndex] = {
				...filter,
				where: where as typeof filter.where,
			};
			return { ...parent, filters: filters as typeof parent.filters };
		}
	}
}
function mapChildren(
	node: ExpressionNode,
	hooks: AstMapHooks,
	path: CheckPath,
): ExpressionNode {
	return mapExpressionChildren(node, (child) => mapChild(child, hooks), path);
}
/** Maps only immediate edges; scoped consumers choose the context for each descent. */
export function mapExpressionChildren<T extends ExpressionNode>(
	node: T,
	map: (child: ExpressionChild) => Expression | Term | RelationPath,
	path: CheckPath = [],
): T {
	let result: ExpressionNode = node;
	for (const child of expressionChildren(node, path)) {
		let replacement = map(child);
		if (replacement === child.value) continue;
		if (child.kind === "term") {
			// A widened subject slot takes any expression in place of its stored
			// property; any other term slot takes a term, written bare even when it
			// arrives wrapped as a term expression.
			if (
				isExpression(replacement) &&
				replacement.kind === "term" &&
				!isWidenedPropertySlot(node, child.role)
			)
				replacement = replacement.term;
			if (
				isRelationPath(replacement) ||
				(isExpression(replacement) && !isWidenedPropertySlot(node, child.role))
			)
				throw new Error("A term mapper must return a term.");
			if (!isExpression(replacement))
				guardDirectTerm(node, child.role, replacement);
		}
		const canonical = canonicalChild(node, child.role, replacement);
		if (canonical === child.value) continue;
		result = replaceChild(result, child.role, canonical);
	}
	return result as T;
}
