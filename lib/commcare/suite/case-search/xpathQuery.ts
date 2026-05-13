// lib/commcare/suite/case-search/xpathQuery.ts
//
// Shared `_xpath_query` composer. Two wire surfaces consume the
// composition: the suite-XML emitter at `searchSession.ts` (slots
// the result into a `<data key="_xpath_query">` element on
// `<query>`) and the HQ-JSON emitter at `lib/commcare/hqJson/caseList.ts`
// (slots the same result into
// `module.search_config.default_properties[]` per CCHQ's
// `DefaultCaseSearchProperty` shape). Both surfaces export the
// same authored content to CCHQ — keeping the AND-composition rule
// in one place makes drift between them structurally impossible.
//
// CCHQ accepts at most one `_xpath_query` per `<query>` (the
// runtime CSQL parser treats it as a single source); the AST-level
// `and(...)` reducer folds the unified `caseListConfig.filter`,
// every advanced-arm `searchInputs[i].predicate`, AND every
// simple-arm input with a non-self `via` (derived through
// `deriveSimpleArmPredicate`) into ONE Predicate before the CSQL
// emitter walks the result. The simple-arm-with-via routing is the
// only wire-correct shape for cross-case simple inputs: the bare
// `<prompt>` element binds one runtime value but carries no
// relation-walk metadata, so the relation walk must live in
// `_xpath_query` for the wire to honor the author's intent.
//
// Non-grammar value expressions (`if`, `switch`, `arith`, `concat`,
// `coalesce`, `format-date`, non-LHS `count`) inline as runtime
// on-device XPath fragments inside the `concat(...)` wrapper at the
// CSQL emitter — the canonical CCHQ pattern documented in
// `commcare-hq/docs/case_search_query_language.rst`. Both surfaces
// therefore carry exactly one slot per module: the `_xpath_query`
// slot. CCHQ's `RemoteQuerySessionManager` only threads `<prompt>`
// values into the `search-input:results` instance — sibling
// `<data>` slots would resolve to the empty string at evaluation
// time AND silently filter case data on the server, so the inline
// shape is the only wire-correct option.

import type { CaseListConfig } from "@/lib/domain";
import { and } from "@/lib/domain/predicate";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import { type CsqlEmissionResult, emitCsql } from "../../predicate";
import { getAdvancedArmPredicates } from "./searchPrompts";
import {
	deriveSimpleArmPredicate,
	simpleArmNeedsXPathQueryEmission,
} from "./simpleArmDerivation";

/**
 * Emission output. `wrapper` is the on-device XPath expression that
 * runtime-evaluates to the CSQL query string interpolated into the
 * `_xpath_query` slot. The shape mirrors `CsqlEmissionResult`
 * exactly; the type alias keeps the contract symmetric across both
 * consumers.
 */
export type ComposedXPathQuery = CsqlEmissionResult;

/**
 * Compose the unified `_xpath_query`. Returns `undefined` when the
 * AND-composition collapses to `match-all` (no filter authored, no
 * advanced-arm predicates, no cross-walk simple inputs) —
 * consumers omit the slot entirely rather than emitting
 * `_xpath_query = "true()"`, which CCHQ accepts but reads as noise.
 *
 * Reducer policy:
 *
 *   - Zero clauses → `undefined` (consumer omits the slot).
 *   - One clause → that clause, used directly (no `and(...)` envelope).
 *   - 2+ clauses → standard `and(...)` envelope; the reducer folds
 *     authored `match-all` clauses on the way through.
 *
 * Single-clause short-circuit also handles the `match-all` arm — a
 * lone authored `match-all` lands here and the explicit check below
 * routes it to `undefined`.
 *
 * `caseType` is the module's `caseType`; it threads to every
 * derived `prop(...)` reference for simple-arm inputs that need
 * `_xpath_query` routing. The validator rule
 * `caseSearchConfigRequiresCaseType` makes a `caseSearchConfig`
 * without a case type a structural validation error, so reaching
 * this helper with `caseType === undefined` is only possible from
 * call sites that compose without a `caseSearchConfig` (the HQ JSON
 * `default_properties` projection runs on every module with a
 * `caseListConfig`, regardless of search-config presence). The
 * defensive guard keeps the simple-arm derivation skipped in that
 * arm — the bare prompt slot still emits, and the filter alone (if
 * authored) still composes — without inventing a fictional case-type
 * qualifier for the lifted `prop(...)` references.
 */
export function composeXPathQueryEmission(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
): ComposedXPathQuery | undefined {
	const clauses: Predicate[] = [];
	if (caseListConfig.filter !== undefined) {
		clauses.push(caseListConfig.filter);
	}
	for (const entry of getAdvancedArmPredicates(caseListConfig.searchInputs)) {
		clauses.push(entry.predicate);
	}
	// Simple-arm inputs with a non-self `via` derive an advanced-style
	// predicate at the wire boundary. Self-walk / absent-via simple
	// inputs ride on the bare `<prompt>` slot and contribute nothing
	// here — CCHQ's runtime evaluates their comparison directly
	// against the current case's property. The gate at
	// `simpleArmNeedsXPathQueryEmission` is the single contract; it
	// also returns `false` for blank-property inputs (transient editor
	// state), so the compile path stays clean while the validator's
	// `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY` surfaces the authoring
	// error to the user.
	if (caseType !== undefined) {
		for (const input of caseListConfig.searchInputs) {
			if (input.kind !== "simple") continue;
			if (!simpleArmNeedsXPathQueryEmission(input)) continue;
			clauses.push(deriveSimpleArmPredicate(input, caseType));
		}
	}
	if (clauses.length === 0) {
		return undefined;
	}

	// `and(...)` runs through `reduceAnd` at construction time —
	// flattens nested `and` clauses, drops `match-all` identity
	// clauses, short-circuits to `match-none` on any `match-none`
	// absorbing clause, and unwraps single-clause / empty results to
	// the wrapped predicate / sentinel. So `composed` is either a
	// sentinel (`match-all` / `match-none`), a single non-sentinel
	// clause, or a normalized `and` envelope with no nested `and` or
	// `match-all` arms inside it.
	const composed =
		clauses.length === 1
			? clauses[0]
			: and(clauses[0], clauses[1], ...clauses.slice(2));

	// `match-all` collapses to no `_xpath_query` slot at all — CCHQ's
	// default behavior matches every case, exactly what the identity
	// predicate means.
	if (composed.kind === "match-all") {
		return undefined;
	}

	// Defense in depth — the validator rule
	// `searchInputRefUsesWhenInputPresent` rejects every bare
	// `input(...)` ref outside a `when-input-present` envelope at
	// authoring time. CCHQ's CSQL runtime resolves an unset input
	// ref to the empty string, so a bare ref would silently match
	// cases whose property equals "" until the user types. This
	// walker throws if a bare ref survived to the wire boundary —
	// the validator should have caught it, and reaching this throw
	// means the validator was bypassed (an AST built at runtime, an
	// `as any` cast, or a partial discriminated-union widening).
	// Same shape as the defensive throw at
	// `lib/commcare/predicate/csqlEmitter.ts::emitComparisonOperandSegments`
	// for `count` arms the hoist pass should have lifted.
	assertNoBareSearchInputRefs(composed);

	return emitCsql(composed);
}

/**
 * Walk the composed predicate and throw if a search-input Term
 * appears outside a `when-input-present` envelope keyed to the same
 * input name. The walker maintains a set of input names "currently
 * gated" by an enclosing `when-input-present` and only flags refs
 * whose name is not in that set. Mirrors the validator rule
 * `searchInputRefUsesWhenInputPresent`'s walker contract; the throw
 * shape is a `compilerBugMessage` because reaching it means the
 * validator was bypassed at authoring time.
 */
function assertNoBareSearchInputRefs(predicate: Predicate): void {
	visitPredicate(predicate, new Set<string>());
}

function visitPredicate(p: Predicate, gated: Set<string>): void {
	switch (p.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			visitExpression(p.left, gated);
			visitExpression(p.right, gated);
			return;
		case "in":
			visitExpression(p.left, gated);
			// `in.values` are Literals — they cannot syntactically carry
			// a search-input ref.
			return;
		case "between":
			visitExpression(p.left, gated);
			if (p.lower !== undefined) visitExpression(p.lower, gated);
			if (p.upper !== undefined) visitExpression(p.upper, gated);
			return;
		case "is-null":
		case "is-blank":
			visitExpression(p.left, gated);
			return;
		case "match":
			// `match.value` is a `ValueExpression` (per `matchSchema`),
			// not a bare literal — the type checker admits term-arm
			// shapes including `term(input(...))` / `term(session-*(...))`,
			// and the simple-arm derivation pipeline at
			// `simpleArmDerivation.ts` produces exactly that shape for
			// every non-`exact` mode. Walk the value to catch every
			// reachable input ref.
			visitExpression(p.value, gated);
			return;
		case "multi-select-contains":
			// `property` is a `PropertyRef`; `values` is `[Literal, ...]`.
			// No search-input refs reachable through this arm.
			return;
		case "within-distance":
			// `property` is a `PropertyRef`; `center` is a
			// `ValueExpression` that can carry a `term(input(...))` ref.
			visitExpression(p.center, gated);
			return;
		case "and":
		case "or":
			for (const clause of p.clauses) {
				visitPredicate(clause, gated);
			}
			return;
		case "not":
			visitPredicate(p.clause, gated);
			return;
		case "exists":
		case "missing":
			// The relation walk's outer context is the casedb root; the
			// optional inner `where` predicate's input refs gate against
			// the same enclosing envelope set.
			if (p.where !== undefined) visitPredicate(p.where, gated);
			return;
		case "when-input-present": {
			// Push the gate, recurse, pop — but ONLY pop if this
			// envelope was the one that added it. An outer envelope
			// that already gated the same input name still expects the
			// gate after the inner envelope exits; unconditionally
			// deleting would break a `whenInput("x", and(whenInput("x",
			// …), eq(other, input("x"))))` shape by removing the
			// outer's gate when the inner exits. Mirrors the validator
			// walker's `wasAlreadyGated` preserve at
			// `searchInputRefUsesWhenInputPresent.ts::visitPredicate`.
			const triggerName = p.input.name;
			const wasAlreadyGated = gated.has(triggerName);
			gated.add(triggerName);
			visitPredicate(p.clause, gated);
			if (!wasAlreadyGated) gated.delete(triggerName);
			return;
		}
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`composeXPathQueryEmission.assertNoBareSearchInputRefs: unhandled Predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

function visitExpression(expr: ValueExpression, gated: Set<string>): void {
	switch (expr.kind) {
		case "term":
			if (expr.term.kind === "input" && !gated.has(expr.term.name)) {
				throw new Error(
					compilerBugMessage({
						where: "composeXPathQueryEmission",
						invariant: `the composed _xpath_query predicate carries a bare search-input reference (\`input("${expr.term.name}")\`) outside any when-input-present envelope`,
						detail:
							"The validator rule `searchInputRefUsesWhenInputPresent` rejects this shape at authoring time. Reaching this throw means the validator was bypassed — typically through an AST constructed at runtime, an `as any` cast, or a partial discriminated-union widening. Run validation before invoking the compile pipeline; the validator surfaces the offending slot so the author can wrap the subtree in a `when-input-present` envelope or remove the input reference.",
					}),
				);
			}
			return;
		case "today":
		case "now":
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			visitExpression(expr.value, gated);
			return;
		case "arith":
			visitExpression(expr.left, gated);
			visitExpression(expr.right, gated);
			return;
		case "concat":
			for (const part of expr.parts) visitExpression(part, gated);
			return;
		case "coalesce":
			for (const value of expr.values) visitExpression(value, gated);
			return;
		case "if":
			visitPredicate(expr.cond, gated);
			visitExpression(expr.then, gated);
			visitExpression(expr.else, gated);
			return;
		case "switch":
			visitExpression(expr.on, gated);
			for (const c of expr.cases) {
				// `c.when` is a `Literal` per `switchCaseSchema` — no
				// search-input ref can reach this slot. Only the `then`
				// branch recurses into the value-expression walker.
				visitExpression(c.then, gated);
			}
			visitExpression(expr.fallback, gated);
			return;
		case "format-date":
			visitExpression(expr.date, gated);
			return;
		case "count":
			if (expr.where !== undefined) visitPredicate(expr.where, gated);
			return;
		case "date-add":
			visitExpression(expr.date, gated);
			visitExpression(expr.quantity, gated);
			return;
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`composeXPathQueryEmission.assertNoBareSearchInputRefs: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}
