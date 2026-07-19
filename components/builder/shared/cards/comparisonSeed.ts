// Shared valid-by-construction comparison seeds. This module has no React
// component imports, so structural cards can seed a friendly first condition
// without creating a component-registry cycle.

import { canonicalCasePropertyName, isOrdered } from "@/lib/domain";
import {
	type ComparisonKind,
	eq,
	gt,
	gte,
	lt,
	lte,
	neq,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";
import type { PredicateEditContext } from "../editorSchemas";
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

/** Build a type-valid comparison against the first applicable case property. */
export function comparisonDefault<K extends ComparisonKind>(
	kind: K,
	ctx: PredicateEditContext,
): ComparisonArm<K> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((candidate) =>
		ORDERED_KINDS.has(kind) ? isOrdered(candidate) : true,
	);
	const propName = canonicalCasePropertyName(property?.name ?? "");
	const builder = KIND_BUILDERS[kind] as (
		left: Parameters<typeof eq>[0],
		right: Parameters<typeof eq>[1],
	) => ComparisonArm<K>;
	return builder(
		prop(ctx.currentCaseType, propName),
		seedLiteralForProperty(property),
	);
}

/** The friendly initial state shared by every new-condition entry point. */
export function firstComparisonDefault(
	ctx: PredicateEditContext,
): ComparisonArm<"eq"> {
	return comparisonDefault("eq", ctx);
}
