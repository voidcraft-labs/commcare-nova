/**
 * Structural AST walkers over the `Predicate` and `ValueExpression`
 * discriminated unions.
 *
 * The type checker (`./typeChecker`) walks the same shapes for type
 * resolution and per-operator semantic rules; consumers that need
 * structural collection (validator rules looking for property
 * references / search-input references; reducers that count operator
 * occurrences; rewriters that rebuild trees) need a separate-purpose
 * walker that visits every leaf without doing the type-resolution
 * work. Hand-rolling the recursion at every consumer would duplicate
 * the operator-arm case shapes — every new arm added to either union
 * (or to a sub-schema like `existsSchema.where`) would force every
 * consumer to add a parallel branch, with silent-miscompilation
 * potential when the consumer forgets.
 *
 * The visitors below centralize the recursion into one canonical
 * site. Each operator arm is enumerated exactly once; the
 * exhaustiveness assertion at every `default:` forces a TypeScript
 * compile error when a new arm lands without a parallel branch here.
 *
 * ## Visitor contract
 *
 * `walkTerms` receives one callback that fires for every `Term`
 * leaf reached anywhere in the predicate tree. Term arms are the
 * leaf family (`prop` / `input` / `session-user` / `session-context`
 * / `literal`) — no further recursion happens once a Term is hit.
 * Sub-AST property references (the `property: PropertyRef` slot on
 * `within-distance` / `match` / `multi-select-contains`) surface to
 * the visitor as a `prop`-kinded Term so consumers don't have to
 * inspect non-Term slots separately.
 *
 * `walkPredicateNodes` follows the same cross-family recursion but
 * fires for every `Predicate` node, including predicates embedded in
 * `ValueExpression` carriers such as `if.cond` and `count.where`.
 * Keeping both visitor families on one dispatcher prevents a
 * validator from accidentally treating comparison operands as
 * predicate-free leaves.
 *
 * Visitors are invoked for side effects — they return `void`. Pure
 * (no I/O); the caller closes over its own accumulator.
 */

import type {
	Predicate,
	PropertyRef,
	SearchInputRef,
	Term,
	ValueExpression,
} from "./types";

/**
 * Visit every `Term` reached anywhere inside `predicate`. The
 * visitor fires once per Term leaf; ValueExpression operands and
 * nested Predicate clauses are recursed into without invoking the
 * visitor on the wrapper node itself.
 *
 * Each `PropertyRef` slot on `within-distance` / `match` /
 * `multi-select-contains` flows to the visitor as a `prop`-kinded
 * Term — structurally identical to the `prop()` Term constructed
 * via the builder. Consumers wanting "every property reference,
 * regardless of how it's spelled" filter the visitor to
 * `term.kind === "prop"` and read the result uniformly.
 */
export function walkTerms(
	predicate: Predicate,
	visit: (term: Term) => void,
): void {
	walkPredicate(predicate, { visitTerm: visit }, []);
}

/**
 * Visit every `Term` reached anywhere inside `expression`. Same
 * visitor contract as `walkTerms`, but rooted at a `ValueExpression`
 * instead of a `Predicate`. Used by consumers that walk
 * `ValueExpression`-rooted slots (e.g. the `excludedOwnerIds`
 * advanced-cluster slot, calculated columns) for the same
 * cross-family Term enumeration the predicate walker provides.
 */
export function walkExpressionTerms(
	expression: ValueExpression,
	visit: (term: Term) => void,
): void {
	walkValueExpression(expression, { visitTerm: visit }, []);
}

/**
 * Visit every `Predicate` node reachable from `predicate`, including
 * the root. Traversal crosses into every `ValueExpression` operand so
 * predicate-bearing expression arms (`if.cond`, `count.where`) are not
 * skipped. Nodes are visited pre-order.
 */
export function walkPredicateNodes(
	predicate: Predicate,
	visit: (predicate: Predicate) => void,
): void {
	walkPredicate(predicate, { visitPredicate: visit }, []);
}

/**
 * Visit every `Predicate` node reachable from an expression-rooted
 * AST. This is the expression-rooted counterpart to
 * `walkPredicateNodes`; it is useful for wire slots whose outer value
 * is a `ValueExpression` but whose descendants can still carry
 * predicates.
 */
export function walkExpressionPredicateNodes(
	expression: ValueExpression,
	visit: (predicate: Predicate) => void,
): void {
	walkValueExpression(expression, { visitPredicate: visit }, []);
}

/**
 * Visit every `ValueExpression` node reachable from `predicate`, including
 * expressions nested inside predicate operands and expressions reached again
 * through cross-family carriers such as `if.cond` and `count.where`. Nodes are
 * visited pre-order.
 *
 * This is the predicate-rooted counterpart to `walkExpressionNodes`. Wire
 * compatibility rules use it when an unsupported value operator can appear at
 * any depth inside a boolean slot.
 */
export function walkPredicateExpressionNodes(
	predicate: Predicate,
	visit: (expression: ValueExpression) => void,
): void {
	walkPredicate(predicate, { visitExpression: visit }, []);
}

/**
 * Visit every `ValueExpression` node reachable from `expression`, including
 * the root. Traversal crosses predicates carried by `if` and `count`, then
 * continues into any value operands nested inside those predicates. Nodes are
 * visited pre-order.
 */
export function walkExpressionNodes(
	expression: ValueExpression,
	visit: (expression: ValueExpression) => void,
): void {
	walkValueExpression(expression, { visitExpression: visit }, []);
}

/** Structural path shared with the type checker and predicate workbench. */
export type PredicateAstPath = readonly (string | number)[];

/** Visit every Search-input reference with its exact authoring path. */
export function walkInputRefsWithPaths(
	predicate: Predicate,
	visit: (ref: SearchInputRef, path: PredicateAstPath) => void,
): void {
	walkPredicate(
		predicate,
		{
			visitTerm: (term, path) => {
				if (term.kind === "input") visit(term, path);
			},
		},
		[],
	);
}

/** Expression-rooted counterpart to `walkInputRefsWithPaths`. */
export function walkExpressionInputRefsWithPaths(
	expression: ValueExpression,
	visit: (ref: SearchInputRef, path: PredicateAstPath) => void,
): void {
	walkValueExpression(
		expression,
		{
			visitTerm: (term, path) => {
				if (term.kind === "input") visit(term, path);
			},
		},
		[],
	);
}

/**
 * Convenience wrapper: visit every `SearchInputRef` (i.e. every
 * `input(...)` Term) reached anywhere inside `predicate`. Filters
 * `walkTerms` to `kind === "input"` so consumers that only care
 * about input-ref resolution don't need to write the kind guard
 * themselves.
 */
export function walkInputRefs(
	predicate: Predicate,
	visit: (ref: SearchInputRef) => void,
): void {
	walkTerms(predicate, (term) => {
		if (term.kind === "input") visit(term);
	});
}

/** Whether a predicate reads the named Search input anywhere in its AST. */
export function predicateReferencesSearchInput(
	predicate: Predicate,
	name: string,
): boolean {
	let found = false;
	walkInputRefs(predicate, (ref) => {
		if (ref.name === name) found = true;
	});
	return found;
}

/** Expression-rooted counterpart to `predicateReferencesSearchInput`. */
export function expressionReferencesSearchInput(
	expression: ValueExpression,
	name: string,
): boolean {
	let found = false;
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "input" && term.name === name) found = true;
	});
	return found;
}

/** Structurally rename every matching Search-input leaf in a predicate. */
export function renameSearchInputInPredicate(
	predicate: Predicate,
	oldName: string,
	newName: string,
): number {
	let changed = 0;
	walkInputRefs(predicate, (ref) => {
		if (ref.name !== oldName) return;
		ref.name = newName;
		changed++;
	});
	return changed;
}

/** Structurally rename every matching Search-input leaf in an expression. */
export function renameSearchInputInExpression(
	expression: ValueExpression,
	oldName: string,
	newName: string,
): number {
	let changed = 0;
	walkExpressionTerms(expression, (term) => {
		if (term.kind !== "input" || term.name !== oldName) return;
		term.name = newName;
		changed++;
	});
	return changed;
}

/**
 * Structurally replace every Search-input dependency with its
 * "unanswered" reading: `when-input-present` envelopes collapse to
 * `match-all` (their clause only applies once the input is answered)
 * and bare `input(...)` Terms become the blank literal (CommCare
 * resolves an unanswered input to the empty string).
 *
 * Wire slots evaluated before any Search runs — the ordinary
 * case-list nodeset and its HQ-JSON projection — must not reference
 * `instance('search-input:results')` at all: on such an entry the
 * instance is declared but never loaded, and Core's
 * `XPathPathExpr.evalRaw` throws `XPathMissingInstanceException` for
 * a declared-but-unloaded instance BEFORE any enclosing guard
 * (`normalize-space(...) = ''`, `if(count(...))`) can evaluate.
 * Substituting the unanswered reading statically produces exactly the
 * semantics those runtime guards were written to provide, with no
 * instance reference left on the wire.
 *
 * Returns the given tree unchanged (same reference) when it reaches
 * no Search-input reference.
 */
export function substituteUnansweredSearchInputsInPredicate(
	predicate: Predicate,
): Predicate {
	if (!predicateReferencesAnySearchInput(predicate)) return predicate;
	const substituted = structuredClone(predicate);
	walkPredicateNodes(substituted, collapseWhenInputPresent);
	walkTerms(substituted, blankInputTerm);
	return substituted;
}

/** Expression-rooted counterpart to `substituteUnansweredSearchInputsInPredicate`. */
export function substituteUnansweredSearchInputsInExpression(
	expression: ValueExpression,
): ValueExpression {
	if (!expressionReferencesAnySearchInput(expression)) return expression;
	const substituted = structuredClone(expression);
	walkExpressionPredicateNodes(substituted, collapseWhenInputPresent);
	walkExpressionTerms(substituted, blankInputTerm);
	return substituted;
}

/** Whether a predicate reads ANY Search input anywhere in its AST. */
export function predicateReferencesAnySearchInput(
	predicate: Predicate,
): boolean {
	let found = false;
	walkTerms(predicate, (term) => {
		if (term.kind === "input") found = true;
	});
	return found;
}

/** Expression-rooted counterpart to `predicateReferencesAnySearchInput`. */
export function expressionReferencesAnySearchInput(
	expression: ValueExpression,
): boolean {
	let found = false;
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "input") found = true;
	});
	return found;
}

/**
 * In-place arm swap: `when-input-present` → `match-all`. Runs before
 * `blankInputTerm` so a collapsed envelope's clause (and its trigger
 * ref) is dropped wholesale rather than visited. Mutating `kind`
 * pre-order stops the walker from descending into the deleted clause.
 */
function collapseWhenInputPresent(predicate: Predicate): void {
	if (predicate.kind !== "when-input-present") return;
	const node = predicate as unknown as Record<string, unknown>;
	delete node.input;
	delete node.clause;
	node.kind = "match-all";
}

/** In-place arm swap: `input(...)` Term → the blank literal. */
function blankInputTerm(term: Term): void {
	if (term.kind !== "input") return;
	const node = term as unknown as Record<string, unknown>;
	delete node.name;
	node.kind = "literal";
	node.value = "";
}

/**
 * Convenience wrapper: visit every `PropertyRef` (i.e. every
 * `prop(...)` Term and every operator slot typed `PropertyRef`)
 * reached anywhere inside `predicate`. Filters `walkTerms` to
 * `kind === "prop"`.
 */
export function walkPropertyRefs(
	predicate: Predicate,
	visit: (ref: PropertyRef) => void,
): void {
	walkTerms(predicate, (term) => {
		if (term.kind === "prop") visit(term);
	});
}

/**
 * Whether an expression needs a case row to evaluate faithfully.
 *
 * This is the shared semantic guard for slots resolved in a GLOBAL
 * context — before any case is selected: the assigned-case exclusion
 * (`caseSearchConfig.excludedOwnerIds`), a search input's starting
 * value (`searchInputs[].default`), and the search-button display
 * condition (predicate-rooted sibling below). Property terms read the
 * current or a related case directly; `count`, `exists`, and `missing`
 * read the relationship graph even when they carry no property term.
 * All other operators are pure compositions over their descendants and
 * remain available when those descendants are global values (literals,
 * session/current-user values, Search answers where the slot admits
 * them).
 */
export function expressionReadsCaseData(expression: ValueExpression): boolean {
	let readsCaseData = false;
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "prop") readsCaseData = true;
	});
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "count") readsCaseData = true;
	});
	walkExpressionPredicateNodes(expression, (predicate) => {
		if (predicate.kind === "exists" || predicate.kind === "missing") {
			readsCaseData = true;
		}
	});
	return readsCaseData;
}

/**
 * Predicate-rooted counterpart to `expressionReadsCaseData`. The
 * `PropertyRef` slots on `within-distance` / `match` /
 * `multi-select-contains` surface through `walkTerms` as prop-kinded
 * terms, so every spelling of a case read is covered by the same three
 * checks.
 */
export function predicateReadsCaseData(predicate: Predicate): boolean {
	let readsCaseData = false;
	walkTerms(predicate, (term) => {
		if (term.kind === "prop") readsCaseData = true;
	});
	walkPredicateExpressionNodes(predicate, (node) => {
		if (node.kind === "count") readsCaseData = true;
	});
	walkPredicateNodes(predicate, (node) => {
		if (node.kind === "exists" || node.kind === "missing") {
			readsCaseData = true;
		}
	});
	return readsCaseData;
}

// ── Internal recursion ────────────────────────────────────────────

interface AstVisitor {
	readonly visitTerm?: (term: Term, path: PredicateAstPath) => void;
	readonly visitPredicate?: (
		predicate: Predicate,
		path: PredicateAstPath,
	) => void;
	readonly visitExpression?: (
		expression: ValueExpression,
		path: PredicateAstPath,
	) => void;
}

/**
 * Recursive descent over the `Predicate` union. Every operator arm
 * either dispatches to its operand walks (`walkValueExpression` for
 * ValueExpression slots, `walkPredicate` for nested predicate
 * slots) or pushes its `PropertyRef` slot directly through the
 * visitor. The exhaustiveness assertion at `default:` forces every
 * new operator arm to either get its own branch here or be
 * explicitly forwarded.
 */
function walkPredicate(
	predicate: Predicate,
	visitor: AstVisitor,
	path: PredicateAstPath,
): void {
	visitor.visitPredicate?.(predicate, path);
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			walkValueExpression(predicate.left, visitor, [...path, "left"]);
			walkValueExpression(predicate.right, visitor, [...path, "right"]);
			return;
		case "in":
			walkValueExpression(predicate.left, visitor, [...path, "left"]);
			// `in.values` is `[Literal, ...Literal[]]` — literal Terms
			// surface to the visitor uniformly with every other Term leaf.
			for (let i = 0; i < predicate.values.length; i++) {
				visitor.visitTerm?.(predicate.values[i], [...path, "values", i]);
			}
			return;
		case "within-distance":
			// `property` is a `PropertyRef` slot, structurally identical
			// to a `prop`-kinded Term — surface it through the same path.
			visitor.visitTerm?.(predicate.property, [...path, "property"]);
			walkValueExpression(predicate.center, visitor, [...path, "center"]);
			return;
		case "match":
			visitor.visitTerm?.(predicate.property, [...path, "property"]);
			// `match.value` is a `ValueExpression` (per `matchSchema`),
			// not a bare literal — the type checker admits term-arm
			// shapes including `term(input(...))` / `term(session-*(...))`,
			// and the simple-arm derivation pipeline at
			// `lib/commcare/suite/case-search/simpleArmDerivation.ts`
			// constructs exactly that shape for fuzzy / phonetic /
			// starts-with / fuzzy-date modes. Walking the value here
			// surfaces every Term ref a consumer (instance accumulator,
			// validator, defense-in-depth assertion) needs to see.
			walkValueExpression(predicate.value, visitor, [...path, "value"]);
			return;
		case "multi-select-contains":
			visitor.visitTerm?.(predicate.property, [...path, "property"]);
			for (let i = 0; i < predicate.values.length; i++) {
				visitor.visitTerm?.(predicate.values[i], [...path, "values", i]);
			}
			return;
		case "is-null":
		case "is-blank":
			walkValueExpression(predicate.left, visitor, [...path, "left"]);
			return;
		case "between":
			walkValueExpression(predicate.left, visitor, [...path, "left"]);
			if (predicate.lower !== undefined)
				walkValueExpression(predicate.lower, visitor, [...path, "lower"]);
			if (predicate.upper !== undefined)
				walkValueExpression(predicate.upper, visitor, [...path, "upper"]);
			return;
		case "and":
		case "or":
			for (let i = 0; i < predicate.clauses.length; i++) {
				walkPredicate(predicate.clauses[i], visitor, [
					...path,
					predicate.kind,
					i,
				]);
			}
			return;
		case "not":
			walkPredicate(predicate.clause, visitor, [
				...path,
				predicate.kind,
				"clause",
			]);
			return;
		case "when-input-present":
			// The trigger ref is itself a Term (specifically a
			// `SearchInputRef`); fire the visitor on it so consumers see
			// every input ref the predicate carries, including the
			// trigger.
			visitor.visitTerm?.(predicate.input, [...path, predicate.kind, "input"]);
			walkPredicate(predicate.clause, visitor, [
				...path,
				predicate.kind,
				"clause",
			]);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined)
				walkPredicate(predicate.where, visitor, [
					...path,
					predicate.kind,
					"where",
				]);
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`walkTerms: unhandled predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Recursive descent over the `ValueExpression` union. Each arm
 * either dispatches to its operand walks or terminates at a `term`
 * arm by firing the visitor on the wrapped Term.
 */
function walkValueExpression(
	expr: ValueExpression,
	visitor: AstVisitor,
	path: PredicateAstPath,
): void {
	visitor.visitExpression?.(expr, path);
	switch (expr.kind) {
		case "term":
			visitor.visitTerm?.(expr.term, path);
			return;
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "table-lookup":
			walkPredicate(expr.where, visitor, [...path, "table-lookup", "where"]);
			return;
		case "date-add":
			walkValueExpression(expr.date, visitor, [...path, "date"]);
			walkValueExpression(expr.quantity, visitor, [...path, "quantity"]);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			walkValueExpression(expr.value, visitor, [...path, "value"]);
			return;
		case "format-date":
			walkValueExpression(expr.date, visitor, [...path, "date"]);
			return;
		case "arith":
			walkValueExpression(expr.left, visitor, [...path, "left"]);
			walkValueExpression(expr.right, visitor, [...path, "right"]);
			return;
		case "concat":
			for (let i = 0; i < expr.parts.length; i++) {
				walkValueExpression(expr.parts[i], visitor, [...path, "parts", i]);
			}
			return;
		case "coalesce":
			for (let i = 0; i < expr.values.length; i++) {
				walkValueExpression(expr.values[i], visitor, [...path, "values", i]);
			}
			return;
		case "if":
			walkPredicate(expr.cond, visitor, [...path, "if", "cond"]);
			walkValueExpression(expr.then, visitor, [...path, "if", "then"]);
			walkValueExpression(expr.else, visitor, [...path, "if", "else"]);
			return;
		case "switch":
			walkValueExpression(expr.on, visitor, [...path, "switch", "on"]);
			for (let i = 0; i < expr.cases.length; i++) {
				walkValueExpression(expr.cases[i].then, visitor, [
					...path,
					"switch",
					"cases",
					i,
					"then",
				]);
			}
			walkValueExpression(expr.fallback, visitor, [
				...path,
				"switch",
				"fallback",
			]);
			return;
		case "count":
			if (expr.where !== undefined)
				walkPredicate(expr.where, visitor, [...path, "count", "where"]);
			return;
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`walkTerms: unhandled value expression kind ${String(_exhaustive)}`,
			);
		}
	}
}
