// components/builder/shared/choiceValueModel.ts
//
// "A choice of this question": the value opposite a form answer from a select
// whose choices are written in the form. The value is picked from that
// question's choices by label and stored as a `choice`, which names the option
// by UUID, so editing the choice's value keeps every comparison connected
// (the print follows the option). A select whose choices come from a data
// table or from cases has no written choices, so it offers none.
//
// Pure: the cards read these with their own slot context.

import type { Uuid } from "@/lib/domain";
import {
	type Choice,
	type Expression,
	type ExpressionContext,
	type Literal,
	literal,
} from "@/lib/domain/expression";

export const CHOICE_SOURCE_LABEL = "A choice of this question";

/** One written choice of a select, by identity and saved value. */
export interface StaticSelectOption {
	readonly uuid: Uuid;
	readonly value: string;
}

/** A select question whose choices are written in the form. */
export interface StaticSelectSubject {
	readonly field: Uuid;
	readonly options: readonly StaticSelectOption[];
}

/** The written choices of a question in the slot's form, if it has them. */
export function staticSelectOf(
	field: Uuid,
	context: ExpressionContext,
): StaticSelectSubject | undefined {
	const declared = context.form?.fields.get(field);
	if (
		declared === undefined ||
		(declared.kind !== "single_select" && declared.kind !== "multi_select") ||
		declared.choices?.kind !== "inline"
	)
		return undefined;
	return { field, options: declared.choices.options };
}

/** The question a value is compared with, when it is a form answer from a
 * select with written choices. */
export function staticSelectSubject(
	subject: Expression | undefined,
	context: ExpressionContext,
): StaticSelectSubject | undefined {
	if (subject?.kind !== "term" || subject.term.kind !== "field")
		return undefined;
	return staticSelectOf(subject.term.uuid, context);
}

export function choiceOf(field: Uuid, option: Uuid): Choice {
	return { kind: "choice", field, options: [option] };
}

/** The value a selection value stands for: a literal's own text, a choice's
 * current option value. Undefined for a choice whose option is gone. */
function valueText(
	item: Literal | Choice,
	context: ExpressionContext,
): string | undefined {
	if (item.kind === "literal")
		return typeof item.value === "string" ? item.value : undefined;
	const select = staticSelectOf(item.field, context);
	const values = item.options.map(
		(uuid) => select?.options.find((option) => option.uuid === uuid)?.value,
	);
	return values.every((value) => value !== undefined)
		? values.join(" ")
		: undefined;
}

/**
 * The same value as a choice of `subject`: a choice of that question stays,
 * and a literal naming one of its choices becomes that choice, so the
 * comparison keeps its meaning. Anything else starts at `fallback`, the first
 * choice not already taken.
 */
export function asChoiceOf(
	item: Literal | Choice,
	subject: StaticSelectSubject,
	context: ExpressionContext,
	taken: readonly (Literal | Choice)[] = [],
): Choice | undefined {
	if (item.kind === "choice" && item.field === subject.field) return item;
	const text = valueText(item, context);
	const named = subject.options.find((option) => option.value === text);
	if (named !== undefined) return choiceOf(subject.field, named.uuid);
	const used = new Set(
		taken.flatMap((other) =>
			other.kind === "choice" && other.field === subject.field
				? other.options
				: [],
		),
	);
	const first =
		subject.options.find((option) => !used.has(option.uuid)) ??
		subject.options[0];
	return first === undefined ? undefined : choiceOf(subject.field, first.uuid);
}

/** The same value as plain text, for a subject that has no written choices:
 * a choice becomes its current value, so the comparison still compares with
 * it. A literal stays as it is. */
export function asLiteral(
	item: Literal | Choice,
	context: ExpressionContext,
): Literal {
	if (item.kind === "literal") return item;
	return literal(valueText(item, context) ?? "");
}

/** Retarget every selection value at a new subject: choices of a select
 * with written choices, plain text otherwise. */
export function retargetSelectionValues<T extends Literal | Choice>(
	values: readonly T[],
	subject: StaticSelectSubject | undefined,
	context: ExpressionContext,
): (Literal | Choice)[] {
	const out: (Literal | Choice)[] = [];
	for (const item of values) {
		const next =
			subject === undefined
				? item.kind === "choice"
					? asLiteral(item, context)
					: item
				: (asChoiceOf(item, subject, context, out) ?? item);
		out.push(next);
	}
	return out;
}
