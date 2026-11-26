// components/builder/shared/answeredCondition.ts
//
// A case change's condition on one form answer read as CommCare reads an
// answer alone, `boolean(<answer>)`: true wherever the worker gave one, a
// number answered 0 excepted. The gate admits it as a case change's
// condition alone (`typeChecker.ts::effectiveBooleanOfAnswer`).

import {
	type Expression,
	type ExpressionOfKind,
	formField,
	term,
} from "@/lib/domain/expression";
import type { EditorFormFieldDecl } from "./formFieldPresentation";

/** `boolean(<answer>)` over `answer`. */
export function isAnswered(answer: Expression): ExpressionOfKind<"call"> {
	return { kind: "call", fn: "boolean", args: [answer] };
}

/** Whether `value` is `boolean(...)` of one form answer. */
export function isAnsweredCall(
	value: Expression,
): value is ExpressionOfKind<"call"> {
	return (
		value.kind === "call" &&
		value.fn === "boolean" &&
		value.args.length === 1 &&
		value.args[0]?.kind === "term" &&
		value.args[0].term.kind === "field"
	);
}

/** Whether `value` reads one form answer alone. */
export function isFormAnswer(value: Expression | undefined): boolean {
	return value?.kind === "term" && value.term.kind === "field";
}

/** An answered condition over the first form answer a slot reads. */
export function isAnsweredDefault(ctx: {
	readonly formFields?: readonly EditorFormFieldDecl[];
}): ExpressionOfKind<"call"> {
	const field = ctx.formFields?.[0];
	if (field === undefined)
		throw new Error(
			"An answered condition needs a form answer the slot can read; its schema offers it only where one exists.",
		);
	return isAnswered(term(formField(field.uuid)));
}
