// components/builder/case-list-config/relationDestination.ts
//
// Shared destination-case-type resolver for cards that mount an
// inner `where` predicate against a relation walk's destination
// scope. Used by every card whose AST shape is
// `{ via: RelationPath, where?: Predicate }` — `ExistsCard` (the
// boolean-side `exists` / `missing` cards) and `CountCard` (the
// expression-side `count` card). Future relational cards (subcase
// member-of operators, aggregation arms) pick this up for free.
//
// Mirrors the type checker's relation-walk semantics in
// `lib/domain/predicate/typeChecker.ts`'s `checkRelationPath`:
// returns the destination case-type name when the walk resolves
// against the schema, or `undefined` when the walk is structurally
// unresolvable. The unresolvable branch is the editor's "render
// the inline hint" signal — the surrounding card surfaces the
// type-checker error inline via the validity index.

import type { RelationPath } from "@/lib/domain/predicate";

/** A subset of `CaseType` shape — every consumer's `caseTypes`
 *  array satisfies it. Keeping the parameter type minimal means
 *  cards don't have to widen their imported `CaseType` shape just
 *  to pass it here. */
export interface RelationDestinationCaseType {
	readonly name: string;
	readonly parent_type?: string;
}

/**
 * Resolve the destination case-type name for a relation walk.
 *
 * Returns `undefined` when the walk is structurally unresolvable
 * against the current schema (the surrounding card surfaces the
 * error inline via the type checker's verdict). Branches:
 *
 *   - `self` — no traversal; the destination is the origin. The
 *     type checker rejects `exists(via: self)` / `count(via: self)`
 *     as meaningless top-level shapes, but the editor renders the
 *     where-clause against the origin so transient `self` picks
 *     don't blank the inner editor.
 *   - `ancestor` — multi-hop walk along `parent_type` chains. Each
 *     hop's `throughCaseType` qualifier is NOT consulted here; the
 *     type checker reports any structural mismatch and the editor
 *     falls back to the resolved parent so the where clause stays
 *     renderable.
 *   - `subcase` / `any-relation` — find a case type whose
 *     `parent_type` points back at the origin. When more than one
 *     matches, prefer `ofCaseType` when set; otherwise return the
 *     first match (the editor's inline error surfaces the
 *     disambiguation requirement).
 */
export function resolveRelationDestination(
	via: RelationPath,
	originCaseType: string,
	caseTypes: readonly RelationDestinationCaseType[],
): string | undefined {
	switch (via.kind) {
		case "self":
			return originCaseType;
		case "ancestor": {
			let current: string | undefined = originCaseType;
			for (const _step of via.via) {
				if (current === undefined) return undefined;
				const ct = caseTypes.find((c) => c.name === current);
				if (ct === undefined) return undefined;
				current = ct.parent_type;
			}
			return current;
		}
		case "subcase":
		case "any-relation": {
			const candidates = caseTypes.filter(
				(c) => c.parent_type === originCaseType,
			);
			if (via.ofCaseType !== undefined) {
				const named = candidates.find((c) => c.name === via.ofCaseType);
				return named?.name;
			}
			return candidates[0]?.name;
		}
	}
}
