import type { ExpressionOfKind } from "@/lib/domain/expression";
// Structural-predicate classification for the focus-and-context
// predicate workbench: the connective / container kinds an author can
// focus into, as opposed to leaf conditions edited in place.

import type { Expression } from "@/lib/domain/expression";

export type StructuralPredicate = ExpressionOfKind<
	"and" | "or" | "not" | "when-input-present" | "exists" | "missing"
>;

export function isStructuralPredicate(
	value: Expression,
): value is StructuralPredicate {
	switch (value.kind) {
		case "and":
		case "or":
		case "not":
		case "when-input-present":
		case "exists":
		case "missing":
			return true;
		default:
			return false;
	}
}
