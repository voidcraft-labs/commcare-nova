// components/builder/detail/formSettings/ownCaseModel.ts
//
// The pure state of a form's own-case rows in form settings.
//
// A close form always closes the case it loaded, so its one row is
// **Close the case**: `Every time` is `closeCondition` absent, and `When a
// condition is true` is `closeCondition` holding the author's condition.
// A registration's rows and every other form type's are elsewhere or none.
//
// Choosing `When a condition is true` stores nothing. It enters the local
// state `awaiting-condition` (the `editor/fields/hiddenValueModel.ts`
// precedent: a local state, not a write), the condition editor opens, and
// only a condition the author completes commits, as one `updateForm`.
// Leaving it empty returns the row to its stored choice. Committing a seed
// such as `true()` or `false()` would be a second spelling of a stored
// choice, or a change workers meet before the author wrote anything.

import type { Expression, Form, FormType, Uuid } from "@/lib/domain";

/** The choices of the close form's **Close the case** row. */
export type CloseChoice = "every-time" | "condition";

export const CLOSE_CHOICES: ReadonlyArray<{
	readonly value: CloseChoice;
	readonly label: string;
}> = [
	{ value: "every-time", label: "Every time" },
	{ value: "condition", label: "When a condition is true" },
];

/** The row's local state, remembered per form: the settings popover's
 *  section is reused when the selection moves to another form. */
export interface OwnCaseLocalState {
	readonly formUuid: Uuid;
	readonly awaitingCondition: boolean;
}

export interface CloseRowModel {
	/** The choice the row shows. */
	readonly choice: CloseChoice;
	/** The stored condition, when the row shows one. */
	readonly condition: Expression | undefined;
	/** The condition editor is open over nothing stored yet. */
	readonly awaitingCondition: boolean;
}

/** The patch a commit of the close row writes. */
export type CloseConditionPatch = {
	readonly closeCondition: Expression | null;
};

/** What choosing one of the row's choices does. */
export type CloseChoiceOutcome =
	| { readonly kind: "commit"; readonly patch: CloseConditionPatch }
	| { readonly kind: "await-condition" }
	| { readonly kind: "unchanged" };

/** Whether a form of this type has the **Close the case** row. */
export function hasCloseRow(formType: FormType): boolean {
	return formType === "close";
}

/**
 * The **Close the case** row of a close form, or `undefined` for any other
 * form type. `local` is the row's local state; one remembered for another
 * form says nothing about this one.
 */
export function closeRowModel(
	form: Pick<Form, "uuid" | "type" | "closeCondition">,
	local: OwnCaseLocalState | null,
): CloseRowModel | undefined {
	if (!hasCloseRow(form.type)) return undefined;
	if (form.closeCondition !== undefined) {
		return {
			choice: "condition",
			condition: form.closeCondition,
			awaitingCondition: false,
		};
	}
	const awaiting =
		local?.formUuid === form.uuid && local.awaitingCondition === true;
	return {
		choice: awaiting ? "condition" : "every-time",
		condition: undefined,
		awaitingCondition: awaiting,
	};
}

/**
 * What choosing `choice` does over the stored form. `Every time` over a
 * stored condition clears it; `When a condition is true` over nothing
 * stored awaits the author's condition and writes nothing.
 */
export function closeChoiceOutcome(
	form: Pick<Form, "closeCondition">,
	choice: CloseChoice,
): CloseChoiceOutcome {
	if (choice === "every-time") {
		return form.closeCondition === undefined
			? { kind: "unchanged" }
			: { kind: "commit", patch: { closeCondition: null } };
	}
	return form.closeCondition === undefined
		? { kind: "await-condition" }
		: { kind: "unchanged" };
}

/** The one `updateForm` patch a completed condition commits. */
export function closeConditionCommitPatch(
	condition: Expression,
): CloseConditionPatch {
	return { closeCondition: condition };
}

/** The local state after `outcome` for the form `formUuid`. */
export function nextOwnCaseLocalState(
	formUuid: Uuid,
	outcome: CloseChoiceOutcome,
): OwnCaseLocalState | null {
	return outcome.kind === "await-condition"
		? { formUuid, awaitingCondition: true }
		: null;
}
