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
 * A field with nothing authored holds neither slot, and `calculate` holds
 * only a calculation someone typed: an empty save in either mode clears both
 * slots, and entering keep in step with nothing to carry is a request for a
 * calculation, not a write.
 */

import type { HiddenField } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";

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
 * the value the field ends with, so it is the honest one to show). Otherwise
 * set once, a field holding neither slot included.
 */
export function activeHiddenValueMode(
	field: Pick<HiddenField, "calculate" | "default_value">,
): HiddenValueMode {
	return field.calculate !== undefined ? "calculate" : "default_value";
}

/** The one-write patch shape every Value gesture dispatches. */
export type HiddenValuePatch = {
	calculate: Expression | null;
	default_value: Expression | null;
};

/** The patch that leaves a hidden field with nothing authored. */
export const HIDDEN_VALUE_EMPTY_PATCH: HiddenValuePatch = {
	calculate: null,
	default_value: null,
};

/**
 * Save `expression` into `mode` and clear the other slot. An empty save (the
 * editor committed nothing) is the same write in either mode: the field
 * returns to holding neither slot, because "no calculation" has exactly one
 * honest spelling and it is not an empty calculation.
 */
export function hiddenValueSavePatch(
	mode: HiddenValueMode,
	expression: Expression | undefined,
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
 * throw the value away. A field with nothing authored already reads as set
 * once; toward keep in step it has nothing to carry, so the switch waits for
 * a calculation instead.
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
				default_value: field.calculate ?? null,
			},
		};
	}
	const carried = field.default_value;
	if (carried === undefined) {
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
 * `blankNote` is `hiddenWriterBlankNote`'s sentence for a field with no
 * value that writes a case property; where it answers, it is the line, but
 * only for the field as stored: while `choosing` (the editor is open, or keep
 * in step was chosen and awaits a calculation) another value is on its way,
 * so the line says what the mode does with it.
 */
export function hiddenValueModeHint(
	mode: HiddenValueMode,
	preloads: boolean,
	blankNote: string | undefined,
	choosing: boolean,
): string {
	if (blankNote !== undefined && !choosing) return blankNote;
	if (mode === "calculate") {
		return preloads
			? "Recalculates whenever a value it uses changes and each time the form opens. The result replaces this case's current value."
			: "Recalculates whenever a value it uses changes and each time the form opens, a reopened saved form included.";
	}
	return preloads
		? "Opens with this case's current value and carries it through unchanged."
		: "Runs once when the form first opens. A reopened saved form keeps the value it had.";
}
