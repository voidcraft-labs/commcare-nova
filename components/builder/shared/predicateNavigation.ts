// Pure navigation and replacement helpers for focus-and-context predicate
// editors. Paths deliberately mirror the type checker's structural paths so
// the same absolute path locates both an authored node and its diagnostics.

import type { CaseType } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { EditorPath } from "./path";
import { resolveRelationDestination } from "./relationDestination";

export type StructuralPredicate = Extract<
	Predicate,
	{
		kind: "and" | "or" | "not" | "when-input-present" | "exists" | "missing";
	}
>;

export function isStructuralPredicate(
	value: Predicate,
): value is StructuralPredicate {
	switch (value.kind) {
		case "and":
		case "or":
		case "not":
		case "when-input-present":
		case "exists":
		case "missing":
			return true;
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
		case "match-all":
		case "match-none":
			return false;
	}
}

interface LocatedPredicate {
	readonly value: Predicate;
	readonly caseType: string;
}

function locatePredicate(
	value: Predicate,
	path: EditorPath,
	caseType: string,
	caseTypes: readonly CaseType[],
): LocatedPredicate | undefined {
	if (path.length === 0) return { value, caseType };
	const [kind, slot, ...rest] = path;
	if (kind !== value.kind) return undefined;

	switch (value.kind) {
		case "and":
		case "or": {
			if (typeof slot !== "number") return undefined;
			const child = value.clauses[slot];
			return child === undefined
				? undefined
				: locatePredicate(child, rest, caseType, caseTypes);
		}
		case "not":
		case "when-input-present":
			return slot === "clause"
				? locatePredicate(value.clause, rest, caseType, caseTypes)
				: undefined;
		case "exists":
		case "missing": {
			if (slot !== "where" || value.where === undefined) return undefined;
			const destination =
				caseTypes.length === 0
					? caseType
					: resolveRelationDestination(value.via, caseType, caseTypes);
			if (destination === undefined) return undefined;
			return locatePredicate(value.where, rest, destination, caseTypes);
		}
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
		case "match-all":
		case "match-none":
			return undefined;
	}
}

/** Resolve a predicate node by its absolute structural editor path. */
export function getPredicateAtPath(
	root: Predicate,
	path: EditorPath,
): Predicate | undefined {
	return locatePredicate(root, path, "", [])?.value;
}

/**
 * Return the deepest still-valid focus path. Canonical reductions can unwrap a
 * group after removing a row; walking upward keeps the workbench useful rather
 * than leaving it focused on a node that no longer exists.
 */
export function nearestPredicatePath(
	root: Predicate,
	path: EditorPath,
): EditorPath {
	let candidate = path;
	while (candidate.length > 0) {
		if (getPredicateAtPath(root, candidate) !== undefined) return candidate;
		candidate = parentPredicatePath(candidate);
	}
	return [];
}

/** Structural predicate descents always add exactly a kind + slot pair. */
export function parentPredicatePath(path: EditorPath): EditorPath {
	return path.length < 2 ? [] : path.slice(0, -2);
}

/** Every root-to-focus ancestor path, including root and the focus itself. */
export function predicateAncestorPaths(
	path: EditorPath,
): readonly EditorPath[] {
	const result: EditorPath[] = [[]];
	for (let end = 2; end <= path.length; end += 2) {
		result.push(path.slice(0, end));
	}
	return result;
}

/**
 * Replace exactly one predicate node without simplifying unrelated structure.
 * Invalid paths are programmer errors because every caller obtains paths from
 * the same AST immediately before dispatching the edit.
 */
export function replacePredicateAtPath(
	root: Predicate,
	path: EditorPath,
	next: Predicate,
): Predicate {
	if (path.length === 0) return next;
	const [kind, slot, ...rest] = path;
	if (kind !== root.kind) {
		throw new Error(
			`Predicate path expected ${String(kind)}, found ${root.kind}`,
		);
	}

	switch (root.kind) {
		case "and":
		case "or": {
			if (typeof slot !== "number" || root.clauses[slot] === undefined) {
				throw new Error("Predicate path points to a missing group row");
			}
			const clauses = root.clauses.map((clause, index) =>
				index === slot ? replacePredicateAtPath(clause, rest, next) : clause,
			) as [Predicate, ...Predicate[]];
			return { ...root, clauses };
		}
		case "not":
			if (slot !== "clause") {
				throw new Error("Predicate path expected the excluded condition");
			}
			return {
				...root,
				clause: replacePredicateAtPath(root.clause, rest, next),
			};
		case "when-input-present":
			if (slot !== "clause") {
				throw new Error("Predicate path expected the conditional rule");
			}
			return {
				...root,
				clause: replacePredicateAtPath(root.clause, rest, next),
			};
		case "exists":
		case "missing":
			if (slot !== "where" || root.where === undefined) {
				throw new Error("Predicate path expected a related-case condition");
			}
			return {
				...root,
				where: replacePredicateAtPath(root.where, rest, next),
			};
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
		case "match-all":
		case "match-none":
			throw new Error("Predicate path cannot descend through a condition");
	}
}

/** Case-type scope active at a focused predicate node. */
export function caseTypeAtPredicatePath(
	root: Predicate,
	path: EditorPath,
	rootCaseType: string,
	caseTypes: readonly CaseType[],
): string | undefined {
	return locatePredicate(root, path, rootCaseType, caseTypes)?.caseType;
}
