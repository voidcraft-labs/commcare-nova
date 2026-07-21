// Shared valid-by-construction comparison seeds. This module has no React
// component imports, so structural cards can seed a friendly first condition
// without creating a component-registry cycle.

import { canonicalCasePropertyName, isOrdered } from "@/lib/domain";
import {
	type ComparisonKind,
	eq,
	gt,
	gte,
	literal,
	lt,
	lte,
	neq,
	type Predicate,
	prop,
	sessionContext,
} from "@/lib/domain/predicate";
import { caseDataInScope, type PredicateEditContext } from "../editorSchemas";
import { seedLiteralForProperty } from "./reseed";

type ComparisonArm<K extends ComparisonKind> = Extract<
	Predicate,
	{ kind: ComparisonKind }
> & { kind: K };

export const KIND_BUILDERS: Record<
	ComparisonKind,
	(left: Parameters<typeof eq>[0], right: Parameters<typeof eq>[1]) => Predicate
> = {
	eq,
	neq,
	gt,
	gte,
	lt,
	lte,
};

const ORDERED_KINDS = new Set<ComparisonKind>(["lt", "lte", "gt", "gte"]);

/** Build a type-valid comparison against the first applicable case property.
 *  A global slot has no case to read, so its seed compares the current
 *  user's username (a real, always-present session value — text, so
 *  only the equality kinds are reachable there) against a value to
 *  fill in. */
export function comparisonDefault<K extends ComparisonKind>(
	kind: K,
	ctx: PredicateEditContext,
): ComparisonArm<K> {
	const builder = KIND_BUILDERS[kind] as (
		left: Parameters<typeof eq>[0],
		right: Parameters<typeof eq>[1],
	) => ComparisonArm<K>;
	if (!caseDataInScope(ctx)) {
		return builder(sessionContext("username"), literal(""));
	}
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((candidate) =>
		ORDERED_KINDS.has(kind) ? isOrdered(candidate) : true,
	);
	const propName = canonicalCasePropertyName(property?.name ?? "");
	return builder(
		prop(ctx.currentCaseType, propName),
		seedLiteralForProperty(property),
	);
}

/** The friendly initial state shared by every new-condition entry point.
 *  A global slot's placeholder commits before the author edits it and
 *  gates a whole surface (the Search action), so it must hold TRUE
 *  unedited — "username is not blank" always passes, keeping the surface
 *  visible until a real rule replaces it. Per-case slots keep the
 *  friendly "is" seed. */
export function firstComparisonDefault(
	ctx: PredicateEditContext,
): ComparisonArm<"eq"> | ComparisonArm<"neq"> {
	return caseDataInScope(ctx)
		? comparisonDefault("eq", ctx)
		: comparisonDefault("neq", ctx);
}
