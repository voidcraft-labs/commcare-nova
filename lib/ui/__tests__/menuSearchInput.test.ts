import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { handleMenuSearchInputKeyDown } from "../menuSearchInput";

function propagationFor(key: string): boolean {
	let stopped = false;
	const event = {
		key,
		stopPropagation: () => {
			stopped = true;
		},
	} as unknown as KeyboardEvent<HTMLInputElement>;
	handleMenuSearchInputKeyDown(event);
	return stopped;
}

describe("handleMenuSearchInputKeyDown", () => {
	it("keeps text-editing keys out of menu typeahead", () => {
		for (const key of ["a", " ", "Backspace", "Delete", "Home", "ArrowLeft"]) {
			expect(propagationFor(key), key).toBe(true);
		}
	});

	it("leaves navigation, activation, dismissal, and forward focus to the menu", () => {
		for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]) {
			expect(propagationFor(key), key).toBe(false);
		}
	});
});
