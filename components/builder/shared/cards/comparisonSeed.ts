import type { ExpressionOfKind } from "@/lib/domain/expression";
// Shared valid-by-construction comparison seeds. This module has no React
// component imports, so structural cards can seed a friendly first condition
// without creating a component-registry cycle.

import { isOrdered } from "@/lib/domain";
import {
	type ComparisonKind,
	compatibleTypesFor,
	dateLiteral,
	type Expression,
	eq,
	gt,
	gte,
	literal,
	lt,
	lte,
	neq,
	prop,
	sessionContext,
	tableColumn,
	today,
} from "@/lib/domain/expression";
import {
	caseDataInScope,
	globalPlaceholderTruth,
	type PredicateEditContext,
	tableRowInScope,
} from "../editorSchemas";
import { reseedLiteralForConstraint, seedLiteralForProperty } from "./reseed";

type ComparisonArm<K extends ComparisonKind> =
	ExpressionOfKind<ComparisonKind> & { kind: K };

export const KIND_BUILDERS: Record<
	ComparisonKind,
	(
		left: Parameters<typeof eq>[0],
		right: Parameters<typeof eq>[1],
	) => Expression
> = {
	eq,
	neq,
	gt,
	gte,
	lt,
	lte,
};

const ORDERED_KINDS = new Set<ComparisonKind>(["lt", "lte", "gt", "gte"]);

/** Whether the slot's placeholder must read nothing a device instance
 *  holds. The Search button's condition reads the worker or the session
 *  only where the case list already loads it (HQ's build never loads what
 *  the condition alone reads, `suite/case-search/buttonCondition.ts`), so a
 *  worker placeholder there is refused on most lists, and today's date,
 *  which reads nothing, is the subject every list admits. */
export function placeholderReadsNothing(ctx: PredicateEditContext): boolean {
	return ctx.expressionContext.slot.slot === "search_button_display_condition";
}

/** A date every running app's today is past. */
const PLACEHOLDER_DATE = "2000-01-01";

/** A global slot's seed subject and a value of its type: the worker's
 *  username against blank text, or, where the slot reads nothing a device
 *  instance holds, today's date against a fixed day. */
export function globalSeedSubject(ctx: PredicateEditContext): {
	readonly subject: Parameters<typeof eq>[0];
	readonly value: ReturnType<typeof literal>;
} {
	return placeholderReadsNothing(ctx)
		? { subject: today(), value: dateLiteral(PLACEHOLDER_DATE) }
		: { subject: sessionContext("username"), value: literal("") };
}

/** Build a type-valid comparison against the first applicable case property.
 *  A global slot has no case to read, so its seed compares the current
 *  user's username (a real, always-present session value: text, so
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
	if (tableRowInScope(ctx)) {
		const column = ctx.tableScope?.columns.find((candidate) =>
			ORDERED_KINDS.has(kind)
				? isOrdered({ data_type: candidate.dataType })
				: true,
		);
		if (ctx.tableScope !== undefined && column !== undefined) {
			return builder(
				tableColumn(ctx.tableScope.tableId, column.id),
				reseedLiteralForConstraint(
					literal(""),
					compatibleTypesFor(column.dataType),
				),
			);
		}
		/* The menu withholds this gesture when no active column exists. A direct
		 * caller reaching the factory anyway is a programming error; returning
		 * a session placeholder would commit a different rule than the
		 * table-row gesture promised. */
		throw new Error(
			"A table-row comparison requires one admitted active-table column",
		);
	}
	if (!caseDataInScope(ctx)) {
		const { subject, value } = globalSeedSubject(ctx);
		return builder(subject, value);
	}
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((candidate) =>
		ORDERED_KINDS.has(kind) ? isOrdered(candidate) : true,
	);
	const propName = property?.name ?? "";
	return builder(
		prop(ctx.currentCaseType, propName),
		seedLiteralForProperty(property),
	);
}

/** An unchosen global placeholder with a chosen truth value. The subject
 *  is the current user's username: a real, always-present text value:
 *  so the verb fully determines the truth: "username is not blank"
 *  always holds, "username is blank" never does. Where the slot reads
 *  nothing a device instance holds (`placeholderReadsNothing`), the
 *  subject is today's date, past a fixed day: "today is on or after it"
 *  always holds, "today is before it" never does. */
export function globalPlaceholder(
	holds: boolean,
	ctx?: PredicateEditContext,
):
	| ComparisonArm<"eq">
	| ComparisonArm<"neq">
	| ComparisonArm<"gte">
	| ComparisonArm<"lt"> {
	if (ctx !== undefined && placeholderReadsNothing(ctx))
		return holds
			? gte(today(), dateLiteral(PLACEHOLDER_DATE))
			: lt(today(), dateLiteral(PLACEHOLDER_DATE));
	return holds
		? neq(sessionContext("username"), literal(""))
		: eq(sessionContext("username"), literal(""));
}

/** The unchosen sibling minted when wrapping a condition into a group.
 *  In a global slot it is neutral for the combinator: `and(p, true)`
 *  and `or(p, false)` both keep `p`'s meaning, so grouping never
 *  changes what the rule decides (e.g. hides the Search action) before
 *  the author fills the new row. Per-case slots keep the friendly
 *  property comparison. */
export function wrapSiblingDefault(
	combinator: "and" | "or",
	ctx: PredicateEditContext,
): Expression {
	if (!caseDataInScope(ctx) && !tableRowInScope(ctx)) {
		return globalPlaceholder(combinator === "and", ctx);
	}
	return comparisonDefault("eq", ctx);
}

/** The friendly initial state shared by every new-condition entry point.
 *  A global slot's placeholder commits before the author edits it and
 *  gates a whole surface (the Search action), so it takes the truth
 *  value that leaves the rule's meaning unchanged (the context's
 *  placeholder polarity: true at the root, keeping the surface
 *  visible until a real rule replaces it). Per-case slots keep the
 *  friendly "is" seed. */
export function firstComparisonDefault(
	ctx: PredicateEditContext,
): ReturnType<typeof globalPlaceholder> {
	return caseDataInScope(ctx) || tableRowInScope(ctx)
		? comparisonDefault("eq", ctx)
		: globalPlaceholder(globalPlaceholderTruth(ctx), ctx);
}
