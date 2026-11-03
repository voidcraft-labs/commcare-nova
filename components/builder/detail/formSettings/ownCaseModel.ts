// components/builder/detail/formSettings/ownCaseModel.ts
//
// The pure state of a form's own-case rows in form settings.
//
// | Form type    | Rows                                                  |
// |--------------|-------------------------------------------------------|
// | close        | **Close the case**                                    |
// | registration | **Create the case**, **Close the case it creates**    |
// | follow-up    | none                                                  |
// | survey       | none                                                  |
//
// What each choice stores:
//
// - **Close the case** (close form): `Every time` is `closeCondition`
//   absent, `When a condition is true` the author's condition.
// - **Create the case**: `Every time` is `openCondition` absent, `When a
//   condition is true` the author's condition.
// - **Close the case it creates**: `Never` is `closeCondition` absent,
//   `Every time` is `closeCondition` = `true()` (the `match-all` node),
//   `When a condition is true` the author's condition.
//
// The asymmetry is the form's own: a close form always closes its case, so
// an absent condition is every time, while a registration closes the case
// it creates only when `closeCondition` is present
// (`lib/domain/forms.ts::formSchema`). A stored `true()` on a registration
// reads `Every time`, never as a condition card.
//
// Choosing `When a condition is true` stores nothing. It enters the local
// state `awaiting-condition` for that row (the
// `editor/fields/hiddenValueModel.ts` precedent: a local state, not a
// write), the condition editor opens, and only a condition the author
// completes commits, as one `updateForm`. Leaving it empty returns the row
// to its stored choice. Committing a seed such as `true()` or `false()`
// would be a second spelling of a stored choice, or a change workers meet
// before the author wrote anything.

import type { Expression, Form, FormType, Uuid } from "@/lib/domain";
import { matchAll } from "@/lib/domain/expression";

/** One of a form's own-case rows. */
export type OwnCaseRowKey = "close" | "create" | "close-created";

/** A choice any own-case row offers. */
export type OwnCaseChoice = "never" | "every-time" | "condition";

/** The form property a row stores its choice in. */
export type OwnCaseConditionProperty = "openCondition" | "closeCondition";

/** The expression slot a row's condition is checked as. */
export type OwnCaseConditionSlot =
	| "form_open_condition"
	| "form_close_condition";

export interface OwnCaseRowSpec {
	readonly key: OwnCaseRowKey;
	readonly label: string;
	readonly property: OwnCaseConditionProperty;
	readonly slot: OwnCaseConditionSlot;
	readonly choices: ReadonlyArray<{
		readonly value: OwnCaseChoice;
		readonly label: string;
	}>;
}

const EVERY_TIME = { value: "every-time", label: "Every time" } as const;
const CONDITION = {
	value: "condition",
	label: "When a condition is true",
} as const;
const NEVER = { value: "never", label: "Never" } as const;

const CLOSE_ROW: OwnCaseRowSpec = {
	key: "close",
	label: "Close the case",
	property: "closeCondition",
	slot: "form_close_condition",
	choices: [EVERY_TIME, CONDITION],
};
const CREATE_ROW: OwnCaseRowSpec = {
	key: "create",
	label: "Create the case",
	property: "openCondition",
	slot: "form_open_condition",
	choices: [EVERY_TIME, CONDITION],
};
const CLOSE_CREATED_ROW: OwnCaseRowSpec = {
	key: "close-created",
	label: "Close the case it creates",
	property: "closeCondition",
	slot: "form_close_condition",
	choices: [NEVER, EVERY_TIME, CONDITION],
};

/** The own-case rows a form of this type has, in the order they show. */
export function ownCaseRows(formType: FormType): readonly OwnCaseRowSpec[] {
	switch (formType) {
		case "close":
			return [CLOSE_ROW];
		case "registration":
			return [CREATE_ROW, CLOSE_CREATED_ROW];
		case "followup":
		case "survey":
			return [];
	}
}

/** The rows' local state, remembered per form: the settings popover's
 *  section is reused when the selection moves to another form. `awaiting`
 *  lists the rows whose condition editor is open over nothing stored. */
export interface OwnCaseLocalState {
	readonly formUuid: Uuid;
	readonly awaiting: readonly OwnCaseRowKey[];
}

export interface OwnCaseRowModel extends OwnCaseRowSpec {
	/** The choice the row shows. */
	readonly choice: OwnCaseChoice;
	/** The stored condition, when the row shows one as a card. */
	readonly condition: Expression | undefined;
	/** The condition editor is open over no stored condition yet. */
	readonly awaitingCondition: boolean;
}

/** The patch a commit of a row writes; `null` clears the property. */
export type OwnCaseConditionPatch =
	| { readonly openCondition: Expression | null }
	| { readonly closeCondition: Expression | null };

/** What choosing one of a row's choices does. */
export type OwnCaseChoiceOutcome =
	| { readonly kind: "commit"; readonly patch: OwnCaseConditionPatch }
	| { readonly kind: "await-condition" }
	| { readonly kind: "unchanged" };

type OwnCaseForm = Pick<
	Form,
	"uuid" | "type" | "openCondition" | "closeCondition"
>;

/** The choice a row's stored value reads as, and the condition it shows. */
function storedChoice(
	row: OwnCaseRowSpec,
	form: Pick<Form, "openCondition" | "closeCondition">,
): { readonly choice: OwnCaseChoice; readonly condition?: Expression } {
	const stored = form[row.property];
	if (row.key === "close-created") {
		if (stored === undefined) return { choice: "never" };
		if (stored.kind === "match-all") return { choice: "every-time" };
		return { choice: "condition", condition: stored };
	}
	return stored === undefined
		? { choice: "every-time" }
		: { choice: "condition", condition: stored };
}

function patchFor(
	row: OwnCaseRowSpec,
	value: Expression | null,
): OwnCaseConditionPatch {
	return row.property === "openCondition"
		? { openCondition: value }
		: { closeCondition: value };
}

function rowSpec(formType: FormType, key: OwnCaseRowKey): OwnCaseRowSpec {
	const row = ownCaseRows(formType).find((r) => r.key === key);
	if (row === undefined) {
		throw new Error(
			`A ${formType} form has no "${key}" row in its case settings, so a choice on it cannot be read.`,
		);
	}
	return row;
}

function isAwaiting(
	form: Pick<Form, "uuid">,
	local: OwnCaseLocalState | null,
	key: OwnCaseRowKey,
): boolean {
	return local?.formUuid === form.uuid && local.awaiting.includes(key);
}

/**
 * The own-case rows of `form`, empty for a form type with none. `local` is
 * the rows' local state; one remembered for another form says nothing
 * about this one.
 */
export function ownCaseRowModels(
	form: OwnCaseForm,
	local: OwnCaseLocalState | null,
): readonly OwnCaseRowModel[] {
	return ownCaseRows(form.type).map((row): OwnCaseRowModel => {
		const stored = storedChoice(row, form);
		if (stored.condition !== undefined) {
			return {
				...row,
				choice: "condition",
				condition: stored.condition,
				awaitingCondition: false,
			};
		}
		const awaiting = isAwaiting(form, local, row.key);
		return {
			...row,
			choice: awaiting ? "condition" : stored.choice,
			condition: undefined,
			awaitingCondition: awaiting,
		};
	});
}

/**
 * What choosing `choice` on the row `key` does over the stored form: a
 * choice that is already stored changes nothing, `When a condition is
 * true` over no stored condition awaits the author's condition and writes
 * nothing, and any other choice commits its stored value.
 */
export function ownCaseChoiceOutcome(
	form: Pick<Form, "type" | "openCondition" | "closeCondition">,
	key: OwnCaseRowKey,
	choice: OwnCaseChoice,
): OwnCaseChoiceOutcome {
	const row = rowSpec(form.type, key);
	const stored = storedChoice(row, form);
	if (choice === stored.choice) return { kind: "unchanged" };
	switch (choice) {
		case "condition":
			return { kind: "await-condition" };
		case "never":
			return { kind: "commit", patch: patchFor(row, null) };
		case "every-time":
			return {
				kind: "commit",
				patch: patchFor(row, row.key === "close-created" ? matchAll() : null),
			};
	}
}

/** The one `updateForm` patch a completed condition on the row commits. */
export function ownCaseConditionCommitPatch(
	formType: FormType,
	key: OwnCaseRowKey,
	condition: Expression,
): OwnCaseConditionPatch {
	return patchFor(rowSpec(formType, key), condition);
}

/**
 * The local state after `outcome` on the row `key` of the form
 * `formUuid`: an awaited condition opens the row's editor, and any other
 * outcome closes it. State remembered for another form is dropped.
 */
export function nextOwnCaseLocal(
	local: OwnCaseLocalState | null,
	formUuid: Uuid,
	key: OwnCaseRowKey,
	outcome: OwnCaseChoiceOutcome,
): OwnCaseLocalState | null {
	return outcome.kind === "await-condition"
		? withAwaiting(local, formUuid, key, true)
		: withAwaiting(local, formUuid, key, false);
}

/** The local state once the row's awaited condition landed or was
 *  abandoned. */
export function settleOwnCaseRow(
	local: OwnCaseLocalState | null,
	formUuid: Uuid,
	key: OwnCaseRowKey,
): OwnCaseLocalState | null {
	return withAwaiting(local, formUuid, key, false);
}

function withAwaiting(
	local: OwnCaseLocalState | null,
	formUuid: Uuid,
	key: OwnCaseRowKey,
	awaiting: boolean,
): OwnCaseLocalState | null {
	const current = local?.formUuid === formUuid ? local.awaiting : [];
	const others = current.filter((k) => k !== key);
	const next = awaiting ? [...others, key] : others;
	return next.length === 0 ? null : { formUuid, awaiting: next };
}

// ── The close form's row ───────────────────────────────────────────────
//
// The close form's one row, as `OwnCaseSection.tsx` reads it.

/** The choices of the close form's **Close the case** row. */
export type CloseChoice = "every-time" | "condition";

export const CLOSE_CHOICES: ReadonlyArray<{
	readonly value: CloseChoice;
	readonly label: string;
}> = [EVERY_TIME, CONDITION];

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

/** What choosing one of the close row's choices does. */
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
 * form type. `local` is the rows' local state; one remembered for another
 * form says nothing about this one.
 */
export function closeRowModel(
	form: OwnCaseForm,
	local: OwnCaseLocalState | null,
): CloseRowModel | undefined {
	if (!hasCloseRow(form.type)) return undefined;
	const row = ownCaseRowModels(form, local).find((r) => r.key === "close");
	if (row === undefined || row.choice === "never") return undefined;
	return {
		choice: row.choice,
		condition: row.condition,
		awaitingCondition: row.awaitingCondition,
	};
}

/**
 * What choosing `choice` on a close form's row does. `Every time` over a
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

/** The one `updateForm` patch a completed condition on a close form
 *  commits. */
export function closeConditionCommitPatch(
	condition: Expression,
): CloseConditionPatch {
	return { closeCondition: condition };
}

/** The local state after `outcome` on a close form's row. */
export function nextOwnCaseLocalState(
	formUuid: Uuid,
	outcome: CloseChoiceOutcome,
): OwnCaseLocalState | null {
	return nextOwnCaseLocal(null, formUuid, "close", outcome);
}
