"use client";

import { type KeyboardEvent, useCallback } from "react";

/**
 * Arrow-key navigation for a POPOVER that acts as a menu.
 *
 * Base UI's `Menu` gives this for free, but the account and Project menus are
 * popovers whose rows are plain buttons and links (they hold sections, headings
 * and mixed content a menu's row model does not fit). That left them answering
 * the pointer and not the keyboard: arrowing through them moved nothing, and
 * both record a real choice (switch Project, sign out), which is not a thing to
 * do blind.
 *
 * Attach to the popup element. Down/Up move through the rows and wrap, Home
 * and End jump to the ends, and everything else is left alone so Tab, Escape,
 * Enter and typing still behave the way the popup and its own controls expect.
 *
 * The row list is read from the DOM at each keystroke rather than captured:
 * these panels add and remove rows while open (a Project list loads, a
 * confirmation arms), and a stale list would step onto a row that is gone.
 */
export function useMenuArrowKeys(): (
	event: KeyboardEvent<HTMLElement>,
) => void {
	return useCallback((event: KeyboardEvent<HTMLElement>) => {
		if (
			event.key !== "ArrowDown" &&
			event.key !== "ArrowUp" &&
			event.key !== "Home" &&
			event.key !== "End"
		) {
			return;
		}

		const panel = event.currentTarget;
		const rows = [
			...panel.querySelectorAll<HTMLElement>("a[href], button"),
		].filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
		if (rows.length === 0) return;

		/* Only steer when focus is already inside the panel. A key pressed while
		 * focus sits on the trigger still belongs to the popup's own open/close
		 * handling. */
		const active = document.activeElement;
		const current = rows.indexOf(active as HTMLElement);
		if (current === -1 && event.key !== "ArrowDown" && event.key !== "End") {
			return;
		}

		let next: number;
		if (event.key === "Home") next = 0;
		else if (event.key === "End") next = rows.length - 1;
		else if (event.key === "ArrowDown")
			next = current === -1 ? 0 : (current + 1) % rows.length;
		else next = (current - 1 + rows.length) % rows.length;

		event.preventDefault();
		event.stopPropagation();
		rows[next]?.focus();
	}, []);
}
