import type { KeyboardEvent } from "react";

/**
 * Base UI Menu reserves printable key presses for menu-item typeahead and
 * prevents their browser default. A real search input inside a menu therefore
 * has to stop editing keys before they bubble to the popup, or the keystroke
 * never reaches the input.
 *
 * These keys intentionally keep bubbling so the menu retains its native
 * keyboard contract: vertical navigation, item activation, dismissal, and
 * forward focus movement. Left/right, Home/End, deletion, shortcuts, and text
 * input remain owned by the search field.
 */
const MENU_OWNED_KEYS = new Set([
	"ArrowDown",
	"ArrowUp",
	"Enter",
	"Escape",
	"Tab",
]);

export function handleMenuSearchInputKeyDown(
	event: KeyboardEvent<HTMLInputElement>,
): void {
	if (!MENU_OWNED_KEYS.has(event.key)) {
		event.stopPropagation();
	}
}
