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
 * has to outlive the commit: a ref set at confirm time, consumed by an effect
 * once the slot has actually re-rendered empty, one frame later when the Add
 * button exists.
 *
 * It must not outlive it by more than ONE render, though. A clear can be
 * refused, and a refusal renders with the slot still full; an intent that
 * simply waited for the slot to empty would still be armed afterwards and would
 * fire on whatever emptied it next — a peer's clear, seconds later, yanking
 * focus for an action this author did not take. So the effect runs on EVERY
 * render and always consumes the intent, focusing only if the slot did empty.
 *
 * Pass `finalFocus` as well where the dialog accepts it — it costs nothing and
 * covers the case where the replacement happens to already be mounted.
 */

"use client";

import { type RefObject, useEffect, useRef } from "react";

export function useClearedSlotFocus(value: unknown): {
	/** Attach to the control that replaces the editor once the slot is empty. */
	readonly addRef: RefObject<HTMLButtonElement | null>;
	/** Call when the author confirms the clear, before the commit. */
	readonly onCleared: () => void;
} {
	const addRef = useRef<HTMLButtonElement>(null);
	const pending = useRef(false);
	const frame = useRef<number | null>(null);

	// Cancelled on UNMOUNT and at the next schedule, never from the scheduling
	// effect's own cleanup: that effect is un-keyed, so its cleanup runs before
	// every later render's effect and would cancel the focus it had just
	// scheduled the moment any other render landed inside the frame's window.
	// The unmount cancel also keeps a live rAF out of the async-leak detector.
	useEffect(
		() => () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		},
		[],
	);

	// Deliberately un-keyed — see the note above: a dep array on `value` would
	// skip the render that refuses, leaving the intent armed for a later one.
	useEffect(() => {
		if (!pending.current) return;
		pending.current = false;
		if (value !== undefined) return;
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			addRef.current?.focus();
		});
	});

	return {
		addRef,
		onCleared: () => {
			pending.current = true;
		},
	};
}
