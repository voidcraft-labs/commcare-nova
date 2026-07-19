// Structural-predicate classification for the focus-and-context
// predicate workbench: the connective / container kinds an author can
// focus into, as opposed to leaf conditions edited in place.

import type { Predicate } from "@/lib/domain/predicate";

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
