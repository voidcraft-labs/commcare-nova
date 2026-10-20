// components/builder/shared/matchSubjectModel.ts
//
// What a text match may compare. On the device the subject is any value of
// a type the mode reads; CommCare's server search spells a match as a
// function of one case property (`starts-with(name, …)`, `fuzzy-match(…)`),
// so a slot CommCare's server search evaluates keeps a property subject.

import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	type Expression,
	type ExpressionContext,
	MATCH_PROPERTY_TYPES_BY_MODE,
	type MatchMode,
	match,
	type PropertyRef,
	type SlotConstraint,
	term,
} from "@/lib/domain/expression";

export type MatchPredicate = ExpressionOfKind<"match">;

/** Whether the subject may be any value: no server search evaluates the
 *  slot, so no search query needs a property in its place. */
export function matchSubjectCalculable(context: ExpressionContext): boolean {
	return !context.profile.targets.has("CS");
}

/** The subject's types: the ones the mode reads. */
export function matchSubjectConstraint(mode: MatchMode): SlotConstraint {
	return { accepts: MATCH_PROPERTY_TYPES_BY_MODE[mode] };
}

/** The subject as the expression editor shows it. */
export function matchSubjectExpression(
	property: PropertyRef | Expression,
): Expression {
	return property.kind === "prop" ? term(property) : property;
}

/** The subject as the document stores it: a property is written directly,
 *  as the schema requires, and anything else is kept as the expression. */
export function matchSubjectFromExpression(
	next: Expression,
): PropertyRef | Expression {
	return next.kind === "term" && next.term.kind === "prop" ? next.term : next;
}

/** The match with a new subject; the value and mode stay, since the value's
 *  types follow the mode alone. */
export function replaceMatchSubject(
	value: MatchPredicate,
	next: Expression,
): MatchPredicate {
	return match(matchSubjectFromExpression(next), value.value, value.mode);
}
