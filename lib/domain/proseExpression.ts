// lib/domain/proseExpression.ts
//
// The one statement of what a prose part evaluates. A reference part lowers to
// one identity read; a calculated value is its own form-rule expression. The
// inverse, `proseReferenceOf`, is what keeps one meaning in one stored form:
// a value whose expression is exactly a reference's lowering is stored as
// that reference part.

import type { Expression, Term } from "./expression/types";
import type {
	ProseAtomPart,
	ProseReferencePart,
	ProseValuePart,
} from "./prose";

/** The expression a reference part lowers to. */
export function proseReferenceExpression(part: ProseReferencePart): Expression {
	switch (part.kind) {
		case "field-ref":
			return { kind: "term", term: { kind: "field", uuid: part.uuid } };
		case "case-ref":
			return {
				kind: "term",
				term: {
					kind: "form-case",
					caseType: part.caseType,
					property: part.property,
				},
			};
		case "user-property-ref":
			return {
				kind: "term",
				term: {
					kind: "session-user-property",
					userPropertyUuid: part.userPropertyUuid,
					source: "worker-record",
				},
			};
		case "user-ref":
			return {
				kind: "term",
				term: {
					kind: "session-user",
					field: part.property,
					source: "worker-record",
				},
			};
	}
}

/** The reference part an expression is the lowering of, or undefined. A
 *  question read spelled as an absolute path counts as its hashtag spelling:
 *  both print one path. A relative or `current()` read prints another path,
 *  and a filtered read or a query wrapper reads something else, so each stays
 *  a value. */
export function proseReferenceOf(
	expression: Expression,
): ProseReferencePart | undefined {
	if (expression.kind !== "term") return undefined;
	return referenceOfTerm(expression.term);
}

function referenceOfTerm(term: Term): ProseReferencePart | undefined {
	switch (term.kind) {
		case "field":
			if (term.role !== undefined || term.filters !== undefined)
				return undefined;
			if (term.spelling !== undefined && term.spelling !== "absolute")
				return undefined;
			return { kind: "field-ref", uuid: term.uuid };
		case "form-case":
			return {
				kind: "case-ref",
				caseType: term.caseType,
				property: term.property,
			};
		case "session-user-property":
			return term.source === "worker-record"
				? { kind: "user-property-ref", userPropertyUuid: term.userPropertyUuid }
				: undefined;
		case "session-user":
			return term.source === "worker-record"
				? { kind: "user-ref", property: term.field }
				: undefined;
		default:
			return undefined;
	}
}

/** The expression an atom part evaluates: a reference's lowering, or a
 *  value's own. */
export function proseAtomExpression(part: ProseAtomPart): Expression {
	return part.kind === "value"
		? part.expression
		: proseReferenceExpression(part);
}

/** A value part, or the reference part its expression is the lowering of.
 *  Every writer builds an atom through this, so a formula that only reads
 *  one reference is stored as that reference. */
export function canonicalProseAtom(expression: Expression): ProseAtomPart {
	return proseReferenceOf(expression) ?? valuePart(expression);
}

function valuePart(expression: Expression): ProseValuePart {
	return { kind: "value", expression };
}
