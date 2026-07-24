/**
 * Structure-preserving map over the `Predicate` / `ValueExpression` ASTs.
 *
 * The pure-rebuild twin of `rewrite.ts` (which mutates Immer drafts in
 * place): callers supply hooks that replace nodes, and the mapper
 * rebuilds only the envelopes on the path to a replacement — an
 * untouched subtree comes back as the SAME reference, so consumers can
 * cheaply detect "nothing changed" (`mapped === original`) and the
 * input AST stays observable to its other holders (doc store, zundo
 * history) unchanged.
 *
 * Hook contract: each hook fires BEFORE structural descent. Returning a
 * node replaces the original and STOPS descent — the hook owns the
 * subtree and re-enters `mapPredicateAst` / `mapExpressionAst` itself
 * when it wants its replacement's children mapped. Returning
 * `undefined` descends normally. `mapTerm` fires for every `Term` slot
 * (the `term` expression arm) and returns a full `ValueExpression`
 * because a term substitution may need an expression envelope (a typed
 * literal wrap); the slot-typed `PropertyRef` fields on
 * `within-distance` / `match` / `multi-select-contains` are not Term
 * slots and are deliberately not visited — use `rewrite.ts` for
 * property renames.
 *
 * Descent covers every recursive slot of both unions, including
 * `table-lookup.where` — a binding pass must reach the terms inside a
 * lookup's row filter (`table-column` terms simply pass through
 * whichever hook ignores them).
 */

import { unhandledKindMessage } from "./errors";
import type { Predicate, SwitchCase, Term, ValueExpression } from "./types";

export interface AstMapHooks {
	/** Replace a `Term` slot with a full expression; `undefined` keeps it. */
	readonly mapTerm?: (term: Term) => ValueExpression | undefined;
	/** Replace a whole expression node before descent; `undefined` descends. */
	readonly mapExpression?: (
		expr: ValueExpression,
	) => ValueExpression | undefined;
	/** Replace a whole predicate node before descent; `undefined` descends. */
	readonly mapPredicate?: (predicate: Predicate) => Predicate | undefined;
}

/** Map every element, sharing the original array when nothing changed. */
function mapShared<T>(
	items: readonly [T, ...T[]],
	map: (item: T) => T,
): [T, ...T[]] {
	let changed = false;
	const next = items.map((item) => {
		const mapped = map(item);
		if (mapped !== item) changed = true;
		return mapped;
	}) as [T, ...T[]];
	return changed ? next : (items as [T, ...T[]]);
}

export function mapPredicateAst(
	predicate: Predicate,
	hooks: AstMapHooks,
): Predicate {
	const replaced = hooks.mapPredicate?.(predicate);
	if (replaced !== undefined) return replaced;

	const mapExpr = (expr: ValueExpression) => mapExpressionAst(expr, hooks);
	const mapPred = (p: Predicate) => mapPredicateAst(p, hooks);

	switch (predicate.kind) {
		case "match-all":
		case "match-none":
		case "multi-select-contains":
			return predicate;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const left = mapExpr(predicate.left);
			const right = mapExpr(predicate.right);
			if (left === predicate.left && right === predicate.right) {
				return predicate;
			}
			return { kind: predicate.kind, left, right };
		}
		case "in": {
			const left = mapExpr(predicate.left);
			if (left === predicate.left) return predicate;
			return { kind: "in", left, values: predicate.values };
		}
		case "within-distance": {
			const center = mapExpr(predicate.center);
			if (center === predicate.center) return predicate;
			return { ...predicate, center };
		}
		case "match": {
			const value = mapExpr(predicate.value);
			if (value === predicate.value) return predicate;
			return { ...predicate, value };
		}
		case "between": {
			const left = mapExpr(predicate.left);
			const lower =
				predicate.lower === undefined ? undefined : mapExpr(predicate.lower);
			const upper =
				predicate.upper === undefined ? undefined : mapExpr(predicate.upper);
			if (
				left === predicate.left &&
				lower === predicate.lower &&
				upper === predicate.upper
			) {
				return predicate;
			}
			// Conditional-property-add preserves absent-not-undefined
			// (Zod's `.optional()` strips absent keys on parse).
			const next: Extract<Predicate, { kind: "between" }> = {
				kind: "between",
				left,
				lowerInclusive: predicate.lowerInclusive,
				upperInclusive: predicate.upperInclusive,
			};
			if (lower !== undefined) next.lower = lower;
			if (upper !== undefined) next.upper = upper;
			return next;
		}
		case "is-null":
		case "is-blank": {
			const left = mapExpr(predicate.left);
			if (left === predicate.left) return predicate;
			return { kind: predicate.kind, left };
		}
		case "and":
		case "or": {
			const clauses = mapShared(predicate.clauses, mapPred);
			if (clauses === predicate.clauses) return predicate;
			return { kind: predicate.kind, clauses };
		}
		case "not": {
			const clause = mapPred(predicate.clause);
			if (clause === predicate.clause) return predicate;
			return { kind: "not", clause };
		}
		case "when-input-present": {
			const clause = mapPred(predicate.clause);
			if (clause === predicate.clause) return predicate;
			return { kind: "when-input-present", input: predicate.input, clause };
		}
		case "exists":
		case "missing": {
			if (predicate.where === undefined) return predicate;
			const where = mapPred(predicate.where);
			if (where === predicate.where) return predicate;
			return { kind: predicate.kind, via: predicate.via, where };
		}
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				unhandledKindMessage({
					where: "mapPredicateAst",
					family: "Predicate",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"match-all",
						"match-none",
						"and",
						"or",
						"not",
						"eq",
						"neq",
						"gt",
						"gte",
						"lt",
						"lte",
						"in",
						"between",
						"multi-select-contains",
						"match",
						"within-distance",
						"is-null",
						"is-blank",
						"when-input-present",
						"exists",
						"missing",
					],
				}),
			);
		}
	}
}

export function mapExpressionAst(
	expression: ValueExpression,
	hooks: AstMapHooks,
): ValueExpression {
	const replaced = hooks.mapExpression?.(expression);
	if (replaced !== undefined) return replaced;

	const mapExpr = (expr: ValueExpression) => mapExpressionAst(expr, hooks);
	const mapPred = (p: Predicate) => mapPredicateAst(p, hooks);

	switch (expression.kind) {
		case "term": {
			const mapped = hooks.mapTerm?.(expression.term);
			return mapped ?? expression;
		}
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return expression;
		case "date-add": {
			const date = mapExpr(expression.date);
			const quantity = mapExpr(expression.quantity);
			if (date === expression.date && quantity === expression.quantity) {
				return expression;
			}
			return {
				kind: "date-add",
				date,
				interval: expression.interval,
				quantity,
			};
		}
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list": {
			const value = mapExpr(expression.value);
			if (value === expression.value) return expression;
			return { kind: expression.kind, value };
		}
		case "arith": {
			const left = mapExpr(expression.left);
			const right = mapExpr(expression.right);
			if (left === expression.left && right === expression.right) {
				return expression;
			}
			return { kind: "arith", op: expression.op, left, right };
		}
		case "concat": {
			const parts = mapShared(expression.parts, mapExpr);
			if (parts === expression.parts) return expression;
			return { kind: "concat", parts };
		}
		case "coalesce": {
			const values = mapShared(expression.values, mapExpr);
			if (values === expression.values) return expression;
			return { kind: "coalesce", values };
		}
		case "if": {
			const cond = mapPred(expression.cond);
			const then = mapExpr(expression.then);
			const elseValue = mapExpr(expression.else);
			if (
				cond === expression.cond &&
				then === expression.then &&
				elseValue === expression.else
			) {
				return expression;
			}
			return { kind: "if", cond, then, else: elseValue };
		}
		case "switch": {
			const on = mapExpr(expression.on);
			const cases = mapShared(expression.cases, (c): SwitchCase => {
				const then = mapExpr(c.then);
				return then === c.then ? c : { when: c.when, then };
			});
			const fallback = mapExpr(expression.fallback);
			if (
				on === expression.on &&
				cases === expression.cases &&
				fallback === expression.fallback
			) {
				return expression;
			}
			return { kind: "switch", on, cases, fallback };
		}
		case "count": {
			if (expression.where === undefined) return expression;
			const where = mapPred(expression.where);
			if (where === expression.where) return expression;
			return { kind: "count", via: expression.via, where };
		}
		case "format-date": {
			const date = mapExpr(expression.date);
			if (date === expression.date) return expression;
			return { kind: "format-date", date, pattern: expression.pattern };
		}
		case "table-lookup": {
			const where = mapPred(expression.where);
			if (where === expression.where) return expression;
			return {
				kind: "table-lookup",
				tableId: expression.tableId,
				resultColumnId: expression.resultColumnId,
				where,
			};
		}
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				unhandledKindMessage({
					where: "mapExpressionAst",
					family: "ValueExpression",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"term",
						"today",
						"now",
						"date-add",
						"date-coerce",
						"datetime-coerce",
						"double",
						"arith",
						"concat",
						"coalesce",
						"if",
						"switch",
						"count",
						"unwrap-list",
						"format-date",
						"table-lookup",
						"id-of",
						"acting-user",
						"unowned",
					],
				}),
			);
		}
	}
}
