/**
 * Case-property rename over the `Predicate` / `ValueExpression` ASTs.
 *
 * When a field with a `case_property_on` is renamed, the case property
 * it writes is renamed with it (field id = case property name), and
 * every `PropertyRef` leaf that reads that property must follow. The
 * refs live inside module-level ASTs (case-list filters, calculated
 * column expressions, search-input predicates/defaults, search-button
 * display conditions, excluded-owner-id expressions) and are rewritten
 * STRUCTURALLY — the tree is walked via `walkTerms` and matching
 * `PropertyRef` nodes have their `property` slot renamed in place.
 * String surgery over a serialized form is never an option here: the
 * AST is the stored representation.
 *
 * ## Matching semantics
 *
 * A `PropertyRef` qualifies its property two ways (`types.ts::
 * propertyRefSchema`): `caseType` names the ORIGINATING scope (the
 * case type the predicate runs against), and the optional `via`
 * relation walk moves the read to a DESTINATION case type. The
 * property semantically lives on the destination, so the rename
 * matches on the destination, never the origin:
 *
 *   - absent `via` / `{ kind: "self" }` — destination IS the origin;
 *     match on `ref.caseType`.
 *   - `ancestor` — destination is the LAST step's `throughCaseType`
 *     hint (each hop re-anchors; the final hop is where the property
 *     is read).
 *   - `subcase` / `any-relation` — destination is `ofCaseType`.
 *
 * The hints are optional. A walk without one does not encode where it
 * lands, so the rewrite cannot prove the property is the renamed one —
 * those refs are deliberately LEFT ALONE rather than guessed at (a
 * wrong rewrite silently corrupts a working filter; a stale name is
 * at least visible to the validator's unknown-property checks).
 *
 * Both rewriters mutate the given tree in place (the callers hand in
 * an Immer draft) and return how many `PropertyRef` nodes were
 * renamed. No I/O; same purity contract as `walk.ts`.
 */

import type {
	Predicate,
	PropertyRef,
	RelationPath,
	ValueExpression,
} from "./types";
import { walkExpressionTerms, walkTerms } from "./walk";

/** One case-property rename: `(caseType, oldName)` → `newName`. */
export interface CasePropertyRename {
	readonly caseType: string;
	readonly oldName: string;
	readonly newName: string;
}

/**
 * The case type a relation walk lands on, given the originating scope
 * it starts from. Returns the origin for the no-traversal shapes
 * (absent / `self`), the explicit destination hint for walking shapes,
 * and `undefined` when the walk carries no hint — the destination is
 * simply not encoded in the AST and callers must treat it as unknown.
 */
export function relationDestinationCaseType(
	via: RelationPath | undefined,
	originCaseType: string | undefined,
): string | undefined {
	if (via === undefined || via.kind === "self") return originCaseType;
	if (via.kind === "ancestor") {
		return via.via[via.via.length - 1]?.throughCaseType;
	}
	// subcase | any-relation
	return via.ofCaseType;
}

/**
 * Does `ref` structurally read the renamed property? Destination-type
 * matching per the module header — origin-only matching would rename a
 * same-named property on a DIFFERENT type reached through a walk.
 */
function refMatches(ref: PropertyRef, rename: CasePropertyRename): boolean {
	if (ref.property !== rename.oldName) return false;
	return relationDestinationCaseType(ref.via, ref.caseType) === rename.caseType;
}

/**
 * Rename every matching `PropertyRef` reachable inside `predicate`,
 * in place. Returns the number of nodes renamed. The dedicated
 * `PropertyRef` slots on `within-distance` / `match` /
 * `multi-select-contains` surface through `walkTerms` as `prop` Terms,
 * so one visitor covers every spelling of a property read.
 */
export function renameCasePropertyInPredicate(
	predicate: Predicate,
	rename: CasePropertyRename,
): number {
	let renamed = 0;
	walkTerms(predicate, (term) => {
		if (term.kind !== "prop") return;
		if (!refMatches(term, rename)) return;
		term.property = rename.newName;
		renamed++;
	});
	return renamed;
}

/**
 * `renameCasePropertyInPredicate`, rooted at a `ValueExpression`
 * (calculated columns, search-input defaults, `excludedOwnerIds`).
 * Nested `Predicate` operands (`if.cond`, `count.where`) are reached
 * through the same walk.
 */
export function renameCasePropertyInExpression(
	expression: ValueExpression,
	rename: CasePropertyRename,
): number {
	let renamed = 0;
	walkExpressionTerms(expression, (term) => {
		if (term.kind !== "prop") return;
		if (!refMatches(term, rename)) return;
		term.property = rename.newName;
		renamed++;
	});
	return renamed;
}
