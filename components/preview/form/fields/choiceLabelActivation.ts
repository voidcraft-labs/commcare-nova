import type { MouseEvent } from "react";

function choiceControl(event: MouseEvent<HTMLLabelElement>) {
	if (event.button !== 0 || event.defaultPrevented) return;
	const label = event.currentTarget;
	const control = label.control;
	if (
		!(control instanceof HTMLInputElement) ||
		(control.type !== "radio" && control.type !== "checkbox") ||
		control.matches(":disabled") ||
		control.readOnly ||
		label.closest("[inert]")
	)
		return;
	// An authored link or media control owns its native activation. Direct
	// input clicks already focus the control through the browser's default.
	if (
		event.target instanceof Element &&
		event.target.closest(
			"button,a[href],input,textarea,select,audio,video,[contenteditable=true],[role=button],[role=combobox]",
		)
	)
		return;
	return control;
}

/** Keep blur validation from moving a choice before its click target is chosen.
 * Compatibility mouse events after a touch tap use the same path. */
export function retainChoiceFocus(event: MouseEvent<HTMLLabelElement>) {
	if (choiceControl(event)) event.preventDefault();
}

/** The label's click target is now fixed. Focus its native control so blur
 * validation appears and keyboard navigation continues from the chosen answer.
 * The browser still owns label forwarding, checking and change dispatch. */
export function focusChosenChoice(event: MouseEvent<HTMLLabelElement>) {
	choiceControl(event)?.focus({ preventScroll: true });
}
