/**
 * Rule: no CSQL-emission-bound predicate carries a subcase-relation
 * walk nested inside the filter argument of an ancestor-relation
 * walk.
 *
 * CCHQ's runtime CSQL evaluator rejects exactly this shape. The
 * server-side validator at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::_validate_ancestor_exists_filter`
 * walks the filter argument of every `ancestor-exists(...)` call —
 * descending through `and` / `or` / `not` operator children per
 * `OPERATOR_MAPPING` — and raises `CaseFilterError("subcase-exists is
 * not supported with ancestor-exists")` whenever it finds a
 * `FunctionCall(name='subcase-exists')` or
 * `FunctionCall(name='subcase-count')` anywhere inside. The failure
 * surfaces at search-execution time on the CCHQ server as an
 * `XPathFunctionException` — after the app uploads, after the
 * case-search screen opens. The author has no path back to the
 * broken predicate from the surfaced error.
 *
 * Nova's authoring AST is more expressive than CCHQ's CSQL grammar
 * here: the AST cleanly composes cross-direction relation walks
 * inside one another, but CCHQ has no wire form for that composition.
 * The lossiness has to surface to the author at authoring time so
 * they can choose a different predicate shape (sibling top-level
 * walks AND-composed, or moving one walk to a separate
 * `caseListConfig.searchInputs[i].predicate`).
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
 *     the disjunction contains a subcase walk, also rejected per
 *     `OPERATOR_MAPPING`.
 *
 * Slots in scope (verified by reading the CSQL wire emitters):
 *
 *   - `caseListConfig.filter` — composed into `_xpath_query`.
 *   - `caseListConfig.searchInputs[i].predicate` (advanced arm) —
 *     also composed into `_xpath_query`.
 *
 * Slots NOT in scope: `caseSearchConfig.searchButtonDisplayCondition`
 * compiles to on-device XPath only (not CSQL); same for
 * `caseSearchConfig.excludedOwnerIds`. Both run on the on-device
 * evaluator which has no equivalent restriction.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "@/lib/domain/predicate";
import { liftPropertyVias } from "../../../predicate";
import { type ValidationError, validationError } from "../../errors";

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
	_doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const filter = mod.caseListConfig?.filter;
	if (filter !== undefined) {
		const findings = scanPredicate(filter);
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
		const findings = scanPredicate(input.predicate);
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
function scanPredicate(predicate: Predicate): NestedWalkFinding[] {
	const lifted = liftPropertyVias(predicate);
	const findings: NestedWalkFinding[] = [];
	walkOuter(lifted, findings);
	return findings;
}

/**
 * Outer walker — descends until it enters an ancestor `exists` /
 * `missing` envelope, then hands off to `walkInsideAncestor` to
 * scan the envelope's filter for subcase walks.
 */
function walkOuter(p: Predicate, findings: NestedWalkFinding[]): void {
	switch (p.kind) {
		case "exists":
		case "missing": {
			if (p.via.kind === "ancestor" && p.where !== undefined) {
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
 * `when-input-present` operator children (mirroring CCHQ's
 * `OPERATOR_MAPPING` traversal at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::_validate_ancestor_exists_filter`)
 * and records every subcase-direction `exists` / `missing` envelope
 * reached. Also walks operand ValueExpressions on comparison /
 * membership / absence predicates so a `count(via=subcase, ...)`
 * sitting in a comparison-LHS slot surfaces — CCHQ's filter
 * validator rejects `subcase-count` calls inside the ancestor
 * filter the same way it rejects `subcase-exists`. Re-enters
 * `walkOuter` on any nested ancestor envelope's filter so deeper
 * levels still surface their own findings.
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
 * `liftPropertyVias` expands `any-relation` into
 * `or(exists(ancestor), exists(subcase))`, so by the time the AST
 * reaches this walker every envelope's `via` is either `ancestor`,
 * `subcase`, or `self`. `self` envelopes have no wire form and never
 * reach the CSQL emitter — they're noise here.
 */
function isSubcaseDirection(via: RelationPath): boolean {
	return via.kind === "subcase";
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
		`Module "${mod.name}" has ${outerVerb} wrapping ${innerVerb} in ${slot}. CCHQ's CSQL evaluator rejects cross-direction relation walks nested inside an ancestor walk — when the search request runs, the server raises an XPath error rather than returning results. Open ${adviceSlotName} and either restructure the predicate so the ancestor and child walks are siblings rather than nested (AND-composed at the top level), or move one of the walks to a separate advanced search input so each walk lands in its own _xpath_query slot.`,
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
