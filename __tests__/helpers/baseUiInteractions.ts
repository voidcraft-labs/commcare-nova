/**
 * Interactions that reach the DOM directly rather than through `fireEvent`,
 * wrapped so React commits what they trigger inside the test.
 *
 * `fireEvent` is already act-wrapped by Testing Library. These three are not,
 * and each one moves real state in a Base UI surface:
 *
 *   - `element.focus()` dispatches focus synchronously, and Base UI opens
 *     tooltips and drives menu list-navigation from it.
 *   - Happy DOM does not synthesize a button's browser-owned activation click
 *     from Enter, so keyboard activation has to be spelled out.
 *   - Popups release scroll lock and finish their close transition on a
 *     macrotask plus a couple of frames, after the gesture that closed them.
 *
 * Left unwrapped, all three commit after the assertions that were supposed to
 * observe them; `vitest.setup.ts` fails the test when that happens.
 */

import { act, fireEvent } from "@testing-library/react";

/**
 * Move real DOM focus. Tests that assert on `document.activeElement` need this
 * rather than `fireEvent.focus`, which dispatches the event without moving
 * focus.
 */
export function focusElement(element: HTMLElement): void {
	act(() => {
		element.focus();
	});
}

/**
 * Activate a control from the keyboard, the way a browser's Enter does. Happy
 * DOM does not synthesize the activation click, so it is dispatched here with
 * the zero `detail` a real keyboard activation carries.
 */
export function activateWithEnter(element: HTMLElement): void {
	focusElement(element);
	fireEvent.keyDown(element, { key: "Enter", code: "Enter" });
	fireEvent.click(element, { detail: 0 });
	fireEvent.keyUp(element, { key: "Enter", code: "Enter" });
}

/** Let an opening or closing popup finish its focus, scroll-lock, and transition work. */
export async function settleBaseUiTransitions(): Promise<void> {
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
}
