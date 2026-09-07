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

function otherMode(mode: HiddenValueMode): HiddenValueMode {
	return mode === "calculate" ? "default_value" : "calculate";
}

/**
 * Which slot the control edits. A calculation present means keep in step,
 * including a historical field holding both slots (the calculation is what
 * runs on the wire, so it is the honest one to show). A default alone means
 * set once. Neither means keep in step: the born state of a hidden field,
 * and the mode a field with no value would most likely want next.
 */
export function activeHiddenValueMode(
	field: Pick<HiddenField, "calculate" | "default_value">,
): HiddenValueMode {
	if (field.calculate !== undefined) return "calculate";
	if (field.default_value !== undefined) return "default_value";
	return "calculate";
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

/**
 * Save `expression` into `mode` and clear the other slot. An empty save
 * (the editor committed nothing) keeps the field valid by writing the inert
 * placeholder rather than leaving the field with no value source.
 */
export function hiddenValueSavePatch(
	mode: HiddenValueMode,
	expression: XPathExpression | undefined,
): HiddenValuePatch {
	return {
		[mode]: expression ?? HIDDEN_INERT_VALUE,
		[otherMode(mode)]: null,
	} as HiddenValuePatch;
}

/**
 * Move the current expression into `next` and clear the slot it left. The
 * expression carries across because switching how a value is set is not a
 * decision to throw the value away; a field with no expression to carry
 * starts the new mode with the inert placeholder. `null` when `next` is
 * already the active mode: there is nothing to write.
 */
export function hiddenValueModeSwitchPatch(
	field: Pick<HiddenField, "calculate" | "default_value">,
	next: HiddenValueMode,
): HiddenValuePatch | null {
	const current = activeHiddenValueMode(field);
	if (current === next) return null;
	return {
		[next]: field[current] ?? HIDDEN_INERT_VALUE,
		[current]: null,
	} as HiddenValuePatch;
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
