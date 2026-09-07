/**
 * The state model behind a hidden field's single Value control.
 *
 * A hidden field carries exactly one value source: `calculate` (keep in
 * step: re-evaluated whenever a value it reads changes and on every form
 * open, a resumed saved form included) or `default_value` (set once: seeded
 * when a form instance first opens and never again). The rail shows one
 * control with a mode switch rather than two slots, and every write it makes
 * names BOTH slots so the document can never hold the pair the validator
 * refuses. These helpers are pure so the mode, the hint, and the exact patch
 * each gesture dispatches are pinned without mounting CodeMirror.
 *
 * One asymmetry runs through every helper: the inert placeholder
 * (`HIDDEN_INERT_VALUE`) may sit in `default_value` and never in
 * `calculate`. A calculation runs after the loaded case's value is seeded,
 * so on a hidden field that writes the loaded case's own type an inert
 * calculation writes nothing over the case's saved value on every
 * submission, where an inert default is replaced by that value before
 * anyone reads it. Keep in step therefore always holds an authored
 * expression: entering it with nothing to carry is a request for one, not a
 * write, and emptying it returns the field to set once with nothing.
 */

import {
	HIDDEN_INERT_VALUE,
	type HiddenField,
	type XPathExpression,
} from "@/lib/domain";

export type HiddenValueMode = "calculate" | "default_value";

export const HIDDEN_VALUE_MODES: ReadonlyArray<{
	readonly value: HiddenValueMode;
	readonly label: string;
}> = [
	{ value: "calculate", label: "Keep in step" },
	{ value: "default_value", label: "Set once" },
];

/**
 * Which slot the stored field is in. A calculation present means keep in
 * step, including a historical field holding both slots (the calculation is
 * what runs on the wire, so it is the honest one to show). Otherwise set
 * once: the born state of a hidden field, and the only state a field with
 * no authored value can honestly be in.
 */
export function activeHiddenValueMode(
	field: Pick<HiddenField, "calculate" | "default_value">,
): HiddenValueMode {
	return field.calculate !== undefined ? "calculate" : "default_value";
}

/**
 * Whether an expression is the inert placeholder a builder-born hidden field
 * carries until someone types a real value. Structural: the one-part
 * empty-string literal, exactly as `HIDDEN_INERT_VALUE` spells it. A blank
 * text run (`""`) or a padded literal (`' '`) is not it.
 */
export function isInertHiddenValue(
	expression: XPathExpression | undefined,
): boolean {
	if (expression === undefined) return false;
	const [only, ...rest] = expression.parts;
	const inert = HIDDEN_INERT_VALUE.parts[0];
	return (
		rest.length === 0 &&
		only !== undefined &&
		only.kind === "text" &&
		inert !== undefined &&
		inert.kind === "text" &&
		only.text === inert.text
	);
}

/** The one-write patch shape every Value gesture dispatches. */
export type HiddenValuePatch = {
	calculate: XPathExpression | null;
	default_value: XPathExpression | null;
};

/** The patch that leaves a hidden field set once with nothing authored. */
export const HIDDEN_VALUE_EMPTY_PATCH: HiddenValuePatch = {
	calculate: null,
	default_value: HIDDEN_INERT_VALUE,
};

/**
 * Save `expression` into `mode` and clear the other slot. An empty save (the
 * editor committed nothing) is the same write in either mode: the field
 * returns to set once with the inert placeholder, because "no calculation"
 * has exactly one honest spelling and it is not an empty calculation.
 */
export function hiddenValueSavePatch(
	mode: HiddenValueMode,
	expression: XPathExpression | undefined,
): HiddenValuePatch {
	if (expression === undefined) return HIDDEN_VALUE_EMPTY_PATCH;
	return mode === "calculate"
		? { calculate: expression, default_value: null }
		: { calculate: null, default_value: expression };
}

export type HiddenValueModeSwitch =
	/** `next` is already the stored mode: nothing to write. */
	| { readonly kind: "unchanged" }
	/** One write moves the expression across. */
	| { readonly kind: "commit"; readonly patch: HiddenValuePatch }
	/**
	 * Keep in step was chosen with nothing to carry. The control shows the
	 * new mode with an open editor and commits only a typed calculation;
	 * leaving the editor empty leaves the field as it was.
	 */
	| { readonly kind: "await-calculation" };

/**
 * What choosing `next` on the mode switch does. An authored expression
 * carries across because switching how a value is set is not a decision to
 * throw the value away. Toward set once, a field with nothing authored
 * lands on the inert placeholder; toward keep in step it cannot, so the
 * switch waits for a calculation instead.
 */
export function hiddenValueModeSwitch(
	field: Pick<HiddenField, "calculate" | "default_value">,
	next: HiddenValueMode,
): HiddenValueModeSwitch {
	const current = activeHiddenValueMode(field);
	if (current === next) return { kind: "unchanged" };
	if (next === "default_value") {
		return {
			kind: "commit",
			patch: {
				calculate: null,
				default_value: field.calculate ?? HIDDEN_INERT_VALUE,
			},
		};
	}
	const carried = field.default_value;
	if (carried === undefined || isInertHiddenValue(carried)) {
		return { kind: "await-calculation" };
	}
	return {
		kind: "commit",
		patch: { calculate: carried, default_value: null },
	};
}

/**
 * The quiet line under the mode switch. `preloads` is true when the field
 * writes the loaded case's own type on a one-case form, so set once means
 * the case's value is carried through rather than a typed expression.
 */
export function hiddenValueModeHint(
	mode: HiddenValueMode,
	preloads: boolean,
): string {
	if (mode === "calculate") {
		return preloads
			? "Recalculates whenever a value it uses changes and each time the form opens. The result replaces this case's current value."
			: "Recalculates whenever a value it uses changes and each time the form opens, a reopened saved form included.";
	}
	return preloads
		? "Opens with this case's current value and carries it through unchanged."
		: "Runs once when the form first opens. A reopened saved form keeps the value it had.";
}
