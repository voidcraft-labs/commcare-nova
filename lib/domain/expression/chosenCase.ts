/**
 * The case chosen in an earlier menu, as a record slot reads it.
 *
 * Its id is the `selected-case` datum of that menu's module. Its property is
 * the one `project` shape a record slot admits: the casedb row of the menu's
 * case type whose `case_id` is that datum, projected by a property of the same
 * type. The record dialect spells them `chosen-case('<menu>')` and
 * `chosen-case-property('<menu>', '<property>')`; the checker, the record
 * printer and the Postgres compiler all recognize the property read through
 * `readChosenCaseProperty`, so each reads exactly the shape `chosenCaseProperty`
 * builds and no other `cases` or `project` tree.
 */
import type { Uuid } from "../uuid";
import type { Expression, Term } from "./types";

export type ChosenCaseDatum = Extract<Term, { kind: "session-datum" }> & {
	readonly datum: { readonly kind: "selected-case"; readonly module: Uuid };
};

/** The read of one property of the case chosen in a menu. */
export interface ChosenCasePropertyRead {
	readonly datum: ChosenCaseDatum;
	/** The menu's module. */
	readonly module: Uuid;
	/** The menu's case type, which the property belongs to. */
	readonly caseType: string;
	readonly property: string;
}

/** The id of the case chosen in the menu `module`. */
export function chosenCaseId(
	module: Uuid,
): Extract<Expression, { kind: "term" }> {
	return {
		kind: "term",
		term: { kind: "session-datum", datum: { kind: "selected-case", module } },
	};
}

/** One property of the case chosen in the menu `module`, whose case type is
 *  `caseType`. */
export function chosenCaseProperty(
	module: Uuid,
	caseType: string,
	property: string,
): Extract<Expression, { kind: "project" }> {
	return {
		kind: "project",
		of: {
			kind: "cases",
			source: "casedb",
			where: [
				{
					kind: "eq",
					left: {
						kind: "term",
						term: { kind: "prop", caseType, property: "case_id" },
					},
					right: chosenCaseId(module),
				},
			],
		},
		value: { kind: "prop", caseType, property },
	};
}

/** The chosen case's id datum this term reads, if it reads one. */
export function readChosenCaseId(term: Term): ChosenCaseDatum | undefined {
	return term.kind === "session-datum" && term.datum.kind === "selected-case"
		? (term as ChosenCaseDatum)
		: undefined;
}

/**
 * The chosen-case property read this expression is, if it is exactly the
 * shape `chosenCaseProperty` builds: a casedb query with one condition,
 * `@case_id` of a case type equal to a `selected-case` datum, projected by a
 * property of that same case type, neither read through a relation.
 */
export function readChosenCaseProperty(
	expression: Expression,
): ChosenCasePropertyRead | undefined {
	if (expression.kind !== "project") return undefined;
	const { of, value } = expression;
	if (of.kind !== "cases" || of.source !== "casedb" || of.where.length !== 1)
		return undefined;
	const [condition] = of.where;
	if (condition.kind !== "eq") return undefined;
	const { left, right } = condition;
	if (left.kind !== "term" || right.kind !== "term") return undefined;
	const key = left.term;
	const datum = readChosenCaseId(right.term);
	if (
		datum === undefined ||
		key.kind !== "prop" ||
		key.property !== "case_id" ||
		key.via !== undefined ||
		key.caseType === undefined
	)
		return undefined;
	if (
		value.kind !== "prop" ||
		value.via !== undefined ||
		value.caseType !== key.caseType
	)
		return undefined;
	return {
		datum,
		module: datum.datum.module,
		caseType: key.caseType,
		property: value.property,
	};
}
