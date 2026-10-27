/**
 * Focus the control that REPLACES an optional slot's editor when the slot is
 * cleared.
 *
 * Clearing one of these slots unmounts the control that did the clearing — the
 * section's Clear action — in the same commit that replaces the body with an
 * Add button. So there is nothing left to restore focus to, and a keyboard
 * user lands on `document.body`: their next Tab restarts at the top of the
 * document, and a screen-reader user is told nothing happened at all.
 *
 * Passing Base UI's `finalFocus` alone does NOT fix it. That callback resolves
 * during the closing dialog's layout-effect cleanup, which runs BEFORE the
 * replacement button's ref is attached, so it reads `null` and Base UI falls
 * back to the trigger it is in the middle of unmounting. The intent therefore
 * has to outlive the commit: STATE set at confirm time, in the same event as
 * the clear, so React renders both together and the render that carries the
 * intent is the one that shows the slot's result. Focus moves one frame later,
 * when the Add button exists. It cannot be a ref: React flushes a still-pending
 * passive effect from an EARLIER, non-urgent commit before rendering the
 * confirm's update, and that stale effect, which saw the slot still full,
 * would read the fresh intent as a refusal and discard it.
 *
 * An intent is judged by ONE render and never again. A clear can be refused,
 * and a refusal renders with the slot still full; an intent that simply waited
 * for the slot to empty would still be armed afterwards and would fire on
 * whatever emptied it next — a peer's clear, seconds later, yanking focus for
 * an action this author did not take. So the effect marks each intent handled
 * the first time it sees it, focusing only if the slot did empty.
 *
 * Pass `finalFocus` as well where the dialog accepts it — it costs nothing and
 * covers the case where the replacement happens to already be mounted.
 */

"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

export function useClearedSlotFocus(value: unknown): {
	/** Attach to the control that replaces the editor once the slot is empty. */
	readonly addRef: RefObject<HTMLButtonElement | null>;
	/** Call when the author confirms the clear, before the commit. */
	readonly onCleared: () => void;
} {
	const addRef = useRef<HTMLButtonElement>(null);
	/* A fresh object per confirm, so a second clear is a new intent. */
	const [intent, setIntent] = useState<object | null>(null);
	const handled = useRef<object | null>(null);
	const frame = useRef<number | null>(null);

	// Cancelled on UNMOUNT and at the next schedule, never from the scheduling
	// effect's own cleanup: that cleanup runs whenever the slot's value changes
	// again, and would cancel the focus it had just scheduled the moment a
	// peer's edit landed inside the frame's window.
	useEffect(
		() => () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		},
		[],
	);

	useEffect(() => {
		if (intent === null || handled.current === intent) return;
		handled.current = intent;
		if (value !== undefined) return;
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			addRef.current?.focus();
		});
	}, [intent, value]);

	return {
		addRef,
		onCleared: () => {
			setIntent({});
		},
	};
}
