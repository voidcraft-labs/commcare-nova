// components/builder/shared/relationDestination.ts
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
 *     type checker rejects `exists(via: self)` / `missing(via: self)`
 *     as meaningless quantifiers. `count(via: self)` and property
 *     refs via self are valid and remain in the current scope.
 *   - `ancestor` — multi-hop walk along `parent_type` chains. Each
 *     hop's `throughCaseType` qualifier is NOT consulted here; the
 *     type checker reports any structural mismatch and the editor
 *     falls back to the resolved parent so the where clause stays
 *     renderable.
 *   - `subcase` — the canonical `parent` index resolves through child types.
 *   - `any-relation` — the canonical `parent` index resolves through the
 *     union of the origin's parent and children.
 *   - custom index names — Nova has no relationship metadata to infer their
 *     direction, so only an explicit declared destination resolves.
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
			for (const step of via.via) {
				if (current === undefined) return undefined;
				if (step.identifier !== "parent") {
					if (
						step.throughCaseType === undefined ||
						!caseTypes.some(
							(candidate) => candidate.name === step.throughCaseType,
						)
					) {
						return undefined;
					}
					current = step.throughCaseType;
					continue;
				}
				const ct = caseTypes.find((c) => c.name === current);
				if (ct === undefined) return undefined;
				current = ct.parent_type;
			}
			return current;
		}
		case "subcase": {
			if (via.identifier !== "parent") {
				return via.ofCaseType !== undefined &&
					caseTypes.some((candidate) => candidate.name === via.ofCaseType)
					? via.ofCaseType
					: undefined;
			}
			const candidates = caseTypes.filter(
				(c) => c.parent_type === originCaseType,
			);
			if (via.ofCaseType !== undefined) {
				const named = candidates.find((c) => c.name === via.ofCaseType);
				return named?.name;
			}
			return candidates[0]?.name;
		}
		case "any-relation": {
			if (via.identifier !== "parent") {
				return via.ofCaseType !== undefined &&
					caseTypes.some((candidate) => candidate.name === via.ofCaseType)
					? via.ofCaseType
					: undefined;
			}
			const origin = caseTypes.find(
				(candidate) => candidate.name === originCaseType,
			);
			const candidateNames = [
				...(origin?.parent_type === undefined ? [] : [origin.parent_type]),
				...caseTypes
					.filter((candidate) => candidate.parent_type === originCaseType)
					.map((candidate) => candidate.name),
			].filter((candidate, index, all) => all.indexOf(candidate) === index);
			if (via.ofCaseType !== undefined) {
				return candidateNames.includes(via.ofCaseType)
					? via.ofCaseType
					: undefined;
			}
			return candidateNames[0];
		}
	}
}
