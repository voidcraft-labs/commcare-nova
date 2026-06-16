"use client";
import type { RefCallback } from "react";
import { useCallback } from "react";

/**
 * A ref callback that makes a focusable element swallow Escape and blur,
 * instead of letting it bubble out and tear down a surrounding dialog/popover.
 *
 * Base UI's dismiss listens for Escape on `document` (bubble phase), so a React
 * `onKeyDown` — delegated to that same target — can't reliably stop it. A
 * NATIVE listener on the element halts the keydown before it ever reaches the
 * document listener, then blurs (the field's own "exit"); a second Escape, now
 * outside any field, dismisses as usual. This is the same contract
 * `XPathField` uses to keep Escape inside its CodeMirror editor — the shared
 * primitive for a plain `<input>` / `<textarea>` living inside a dialog.
 */
export function useStopEscape(): RefCallback<HTMLElement> {
	return useCallback((node: HTMLElement | null) => {
		if (!node) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			node.blur();
		};
		node.addEventListener("keydown", onKeyDown);
		return () => node.removeEventListener("keydown", onKeyDown);
	}, []);
}
