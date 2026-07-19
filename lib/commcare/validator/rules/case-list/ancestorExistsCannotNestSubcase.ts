/**
 * Rule: no CSQL-emission-bound predicate carries a subcase-relation
 * walk nested inside the filter argument of an ancestor-relation
 * walk.
 *
 * CCHQ's runtime CSQL evaluator rejects the immediate-nested form:
 * the server-side validator at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::_validate_ancestor_exists_filter`
 * walks the filter argument of every `ancestor-exists(...)` call,
 * descending through the operator children in `OPERATOR_MAPPING` —
 * which is exactly `{'and': filters.AND, 'or': filters.OR}` per
 * `commcare-hq/corehq/apps/case_search/const.py::OPERATOR_MAPPING`.
 * On reaching a `FunctionCall(name='subcase-exists')` or
 * `FunctionCall(name='subcase-count')`, CCHQ raises
 * `CaseFilterError("subcase-exists is not supported with ancestor-exists")`.
 * The failure surfaces at search-execution time as an
 * `XPathFunctionException` — after the app uploads, after the
 * case-search screen opens. The author has no path back to the
 * broken predicate from the surfaced error.
 *
 * Nova rejects a stricter superset than CCHQ's static validator
 * does. The walker descends through `not` and `when-input-present`
 * in addition to `and` / `or`. CCHQ's static validator does not
 * descend into those — `not` and `when-input-present` lower to
 * `FunctionCall`s (not `op`-bearing nodes), so CCHQ's
 * `OPERATOR_MAPPING` check skips them. But the underlying runtime
 * semantics of a `subcase-exists` nested inside a `not` or a
 * `when-input-present` inside an `ancestor-exists` filter are
 * unspecified at the CCHQ wire boundary — even when the static
 * validator admits the shape, there is no documented runtime
 * contract for what it returns. Rejecting the stricter superset at
 * authoring time is the Nova-side defense against silent runtime
 * lossiness — caught when the author writes the predicate, not at
 * search-execution time.
 *
 * Nova's authoring AST is also more expressive than CCHQ's CSQL
 * grammar: the AST cleanly composes cross-direction relation walks
 * inside one another, but CCHQ has no wire form for that
 * composition. The lossiness has to surface to the author at
 * authoring time so they can choose a different predicate shape
 * (sibling top-level walks AND-composed, or moving one walk to a
 * separate `caseListConfig.searchInputs[i].predicate`).
 *
 * Walk the post-`liftPropertyVias` AST. `liftPropertyVias` is the
 * first stage of the CSQL hoist pipeline — it rewrites every
 * `prop(via)` reference into an enclosing `exists` envelope, so the
 * AST that reaches the CSQL emitter has every relation walk
 * structurally encoded as an envelope. Walking the authored AST
 * would miss the envelopes the lift synthesizes:
 *
 *   - `exists(ancestor, eq(prop(via=subcase), v))` lifts to
 *     `exists(ancestor, exists(subcase, eq(prop, v)))` — the
 *     synthesized subcase envelope is what trips CCHQ's filter
 *     validator.
 *   - `exists(ancestor, eq(prop(via=any-relation), v))` lifts to
 *     `exists(ancestor, or(exists(ancestor), exists(subcase)))` —
 *     the disjunction's subcase arm trips the same validator
 *     because CCHQ DOES descend through `or`.
 *
 * Slots in scope (verified by reading the CSQL wire emitters):
 *
 *   - `caseListConfig.filter` — composed into `_xpath_query` only when case
 *     search is enabled. An ordinary case list uses this predicate solely in
 *     on-device XPath and is not subject to CCHQ's server grammar restriction.
 *   - `caseListConfig.searchInputs[i].predicate` (advanced arm) —
 *     also composed into `_xpath_query`.
 *
 * Slots NOT in scope: `caseSearchConfig.searchButtonDisplayCondition`
 * compiles to on-device XPath only (not CSQL); same for
 * `caseSearchConfig.excludedOwnerIds`. Both run on the on-device
 * evaluator which has no equivalent restriction.
 */

import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
	type Uuid,
} from "@/lib/domain";
import type {
	Predicate,
	RelationPath,
	TypeContext,
	ValueExpression,
} from "@/lib/domain/predicate";
import {
	normalizeRelationEvaluationScopes,
	RelationEvaluationScopeError,
} from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import { normalizeRelationPropertyReads as liftPropertyVias } from "@/lib/domain/predicate/normalizeRelationReads";
import { type ValidationError, validationError } from "../../errors";
import { moduleTypeContext } from "./shared";

type AncestorEnvelopeKind = "exists" | "missing";

interface NestedWalkFinding {
	readonly outerKind: AncestorEnvelopeKind;
	readonly innerDirection: "subcase";
	/**
	 * `envelope-exists` / `envelope-missing` — a subcase `exists` /
	 * `missing` predicate nested inside the ancestor filter.
	 * `count` — a `count(via=subcase, ...)` ValueExpression nested in
	 * a comparison operand inside the ancestor filter. CCHQ's
	 * `_validate_ancestor_exists_filter` rejects both shapes per its
	 * `FunctionCall(name='subcase-exists')` / `FunctionCall(name='subcase-count')`
	 * walk.
	 */
	readonly innerKind: "envelope-exists" | "envelope-missing" | "count";
}

export function ancestorExistsCannotNestSubcase(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const ctx = moduleTypeContext(mod, doc);
	if (effectiveCaseSearchConfig(mod) === undefined) return errors;

	const filter = mod.caseListConfig?.filter;
	if (filter !== undefined) {
		const findings = scanPredicate(filter, ctx);
		for (const finding of findings) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					finding,
					slot: "caseListConfig.filter",
					adviceSlotName: "the case list's always-on filter card",
				}),
			);
		}
	}

	const inputs = mod.caseListConfig?.searchInputs ?? [];
	for (let i = 0; i < inputs.length; i++) {
		const input = inputs[i];
		if (input.kind !== "advanced") continue;
		const findings = scanPredicate(input.predicate, ctx);
		for (const finding of findings) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					finding,
					slot: `caseListConfig.searchInputs[${i}].predicate`,
					adviceSlotName: `search input "${input.label || input.name}" (input #${i + 1})`,
				}),
			);
		}
	}

	return errors;
}

/**
 * Lift the predicate's property-vias into their `exists` envelopes,
 * then scan the lifted shape for ancestor envelopes whose inner
 * `where` filter contains a subcase walk anywhere — directly nested
 * or hidden inside `and` / `or` / `not` operators.
 *
 * The scan only walks INTO an ancestor envelope's `where` once it
 * has entered one — same boundary CCHQ's
 * `_validate_ancestor_exists_filter` applies. A subcase walk at top
 * level (sibling to an ancestor walk) is fine; only the nested case
 * trips the rule.
 */
function scanPredicate(
	predicate: Predicate,
	ctx: TypeContext,
): NestedWalkFinding[] {
	let normalized: Predicate;
	try {
		normalized = normalizeRelationEvaluationScopes(predicate, ctx);
	} catch (error) {
		// The on-device/relation-scope compatibility rule owns the friendlier
		// repair for mixed or unrebasable row scopes. Do not turn one authored
		// problem into a second, less-specific nested-CSQL finding.
		if (error instanceof RelationEvaluationScopeError) return [];
		throw error;
	}
	const lifted = liftPropertyVias(normalized, {
		caseTypes: ctx.caseTypes,
		unsupportedPropertyOperands: "throw",
	});
	const findings: NestedWalkFinding[] = [];
	walkOuter(lifted, findings);
	return findings;
}

/**
 * Outer walker — descends until it enters an ancestor-bearing `exists` /
 * `missing` envelope, then hands off to `walkInsideAncestor` to scan the
 * envelope's filter for subcase walks. Any `any-relation` that remains after
 * shared canonicalization counts as ancestor-bearing because the CSQL emitter
 * expands it to an ancestor arm OR a subcase arm. Canonical `parent` walks with
 * one graph-proven direction have already become `ancestor` or `subcase`, so
 * this does not reject a child-only predicate because of an impossible arm.
 */
function walkOuter(p: Predicate, findings: NestedWalkFinding[]): void {
	switch (p.kind) {
		case "exists":
		case "missing": {
			if (
				(p.via.kind === "ancestor" || p.via.kind === "any-relation") &&
				p.where !== undefined
			) {
				// Scan the filter for any subcase walk. Recurse into
				// nested ancestor envelopes too — a deeper level might
				// re-enter this branch and surface its own nested-walk
				// findings.
				walkInsideAncestor(p.where, p.kind, findings);
			}
			// Continue outer-walking the filter so nested ancestor
			// envelopes anywhere inside (including inside a `not` or
			// alongside the subcase walk) still get scanned.
			if (p.where !== undefined) walkOuter(p.where, findings);
			return;
		}
		case "and":
		case "or":
			for (const c of p.clauses) walkOuter(c, findings);
			return;
		case "not":
			walkOuter(p.clause, findings);
			return;
		case "when-input-present":
			walkOuter(p.clause, findings);
			return;
		// Leaf operators carry no nested predicates.
		case "match-all":
		case "match-none":
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "in":
		case "between":
		case "is-null":
		case "is-blank":
		case "match":
		case "multi-select-contains":
		case "within-distance":
			return;
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`ancestorExistsCannotNestSubcase: unhandled predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Inside-ancestor walker — recurses through `and` / `or` / `not` /
 * `when-input-present` operator children and records every
 * subcase-direction `exists` / `missing` envelope reached. Also
 * walks operand ValueExpressions on comparison / membership /
 * absence predicates so a `count(via=subcase, ...)` sitting in a
 * comparison-LHS slot surfaces — CCHQ's static filter validator
 * rejects the bare `subcase-count` call inside the ancestor filter
 * the same way it rejects `subcase-exists`. Re-enters `walkOuter`
 * on any nested ancestor envelope's filter so deeper levels still
 * surface their own findings.
 *
 * Nova's traversal descends through `not` and `when-input-present`
 * in addition to the `and` / `or` operators CCHQ's
 * `OPERATOR_MAPPING` covers. CCHQ's static validator does not
 * descend into `not` (it's a `FunctionCall` in CCHQ's AST, not an
 * `op`-bearing node) or `when-input-present`, but the runtime
 * semantics of those nestings are unspecified at the CCHQ wire
 * boundary — see the file-level comment for the Nova-side
 * rationale.
 */
function walkInsideAncestor(
	p: Predicate,
	outerKind: AncestorEnvelopeKind,
	findings: NestedWalkFinding[],
): void {
	switch (p.kind) {
		case "exists":
		case "missing":
			if (isSubcaseDirection(p.via)) {
				findings.push({
					outerKind,
					innerDirection: "subcase",
					innerKind:
						p.kind === "exists" ? "envelope-exists" : "envelope-missing",
				});
				// Don't recurse further into a flagged subcase envelope's
				// filter — the outer ancestor envelope gets ONE finding
				// per offending shape regardless of how deeply the
				// subcase walk nests further. Deeper subcase nestings
				// might trip their own findings if the user rewrites
				// the outer envelope.
				return;
			}
			// Nested ancestor envelope inside the outer ancestor's
			// filter — pass to the outer walker so its own filter gets
			// scanned independently. (Multi-hop ancestor chains live in
			// the outer envelope's `via` chain; a hand-authored nested
			// ancestor envelope is legal but its filter still has to be
			// scanned for subcase walks.)
			if (p.where !== undefined) {
				walkInsideAncestor(p.where, p.kind, findings);
				walkOuter(p.where, findings);
			}
			return;
		case "and":
		case "or":
			for (const c of p.clauses) walkInsideAncestor(c, outerKind, findings);
			return;
		case "not":
			walkInsideAncestor(p.clause, outerKind, findings);
			return;
		case "when-input-present":
			walkInsideAncestor(p.clause, outerKind, findings);
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			// Comparison operands carry ValueExpressions — a
			// `count(via=subcase, ...)` in LHS or RHS hits CCHQ's
			// `subcase-count` walk inside the ancestor filter.
			scanExpressionInsideAncestor(p.left, outerKind, findings);
			scanExpressionInsideAncestor(p.right, outerKind, findings);
			return;
		case "in":
			scanExpressionInsideAncestor(p.left, outerKind, findings);
			return;
		case "between":
			scanExpressionInsideAncestor(p.left, outerKind, findings);
			if (p.lower !== undefined)
				scanExpressionInsideAncestor(p.lower, outerKind, findings);
			if (p.upper !== undefined)
				scanExpressionInsideAncestor(p.upper, outerKind, findings);
			return;
		case "is-null":
		case "is-blank":
			scanExpressionInsideAncestor(p.left, outerKind, findings);
			return;
		case "within-distance":
			scanExpressionInsideAncestor(p.center, outerKind, findings);
			return;
		// Operators with no operand-side ValueExpression slot, or
		// operators whose ValueExpression slot is a closed
		// `literal`-only tuple (`multi-select-contains.values`) /
		// constrained shape (`match.value` is term-arm only per the
		// type checker, and any `count` inside would have been lifted
		// at the hoist pass) contribute no `count`-bearing operand to
		// scan.
		case "match-all":
		case "match-none":
		case "match":
		case "multi-select-contains":
			return;
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`ancestorExistsCannotNestSubcase: unhandled predicate kind in inner walk ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Scan a ValueExpression operand sitting inside an ancestor envelope
 * for a `count(via=subcase, ...)` shape. CCHQ's
 * `_validate_ancestor_exists_filter` rejects `subcase-count` calls
 * the same way it rejects `subcase-exists`. The CSQL emitter only
 * preserves `count(...)` in comparison-LHS / RHS position with
 * `via.kind === "subcase"` — every other shape lifts at the hoist
 * pass and reads as a synthetic input ref in the wire output
 * (which itself is fine inside an ancestor filter, because the
 * resolved string is just a literal value at CCHQ-evaluation time).
 *
 * The scan recurses into the `count`'s own `where` filter so a
 * nested subcase / ancestor envelope reached through a `count`
 * surfaces its own findings.
 */
function scanExpressionInsideAncestor(
	expr: ValueExpression,
	outerKind: AncestorEnvelopeKind,
	findings: NestedWalkFinding[],
): void {
	if (expr.kind !== "count") return;
	if (isSubcaseDirection(expr.via)) {
		findings.push({
			outerKind,
			innerDirection: "subcase",
			innerKind: "count",
		});
		// Don't descend further into the `count`'s `where` — one
		// finding per offending shape keeps the error coherent.
		return;
	}
	if (expr.where !== undefined) {
		walkInsideAncestor(expr.where, outerKind, findings);
	}
}

/**
 * CSQL expands `any-relation` into ancestor and subcase arms at emission time,
 * so it contains a forbidden subcase direction whenever it appears inside an
 * ancestor filter even though the domain AST still carries one envelope.
 */
function isSubcaseDirection(via: RelationPath): boolean {
	return via.kind === "subcase" || via.kind === "any-relation";
}

function buildError(args: {
	mod: Module;
	moduleUuid: Uuid;
	finding: NestedWalkFinding;
	slot: string;
	adviceSlotName: string;
}): ValidationError {
	const { mod, moduleUuid, finding, slot, adviceSlotName } = args;
	const outerVerb =
		finding.outerKind === "exists"
			? "an `exists` walk to an ancestor case"
			: "a `missing` walk to an ancestor case";
	const innerVerb = innerVerbFor(finding.innerKind);
	return validationError(
		"CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK",
		"module",
		`Module "${mod.name}" has ${outerVerb} wrapping ${innerVerb} in ${slot}. CommCare's server cannot run a child-case lookup from inside an ancestor lookup. Open ${adviceSlotName} and make the ancestor and child checks separate top-level conditions when that matches your intent. If the child truly belongs to the ancestor, save the needed value on the listed case during data collection and filter that value directly.`,
		{ moduleUuid, moduleName: mod.name },
		{
			slot,
			outerEnvelope: finding.outerKind,
			innerDirection: finding.innerDirection,
			innerShape: finding.innerKind,
		},
	);
}

function innerVerbFor(innerKind: NestedWalkFinding["innerKind"]): string {
	switch (innerKind) {
		case "envelope-exists":
			return "an `exists` walk to a child case";
		case "envelope-missing":
			return "a `missing` walk to a child case";
		case "count":
			return "a `count` of related child cases";
		default: {
			const _exhaustive: never = innerKind;
			throw new Error(
				`ancestorExistsCannotNestSubcase: unhandled inner kind ${String(_exhaustive)}`,
			);
		}
	}
}
