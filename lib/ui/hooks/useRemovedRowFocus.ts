/**
 * Hand keyboard focus forward when a row's own action removes that row.
 *
 * The button the author pressed unmounts in the same commit that removes the
 * row, so there is nothing left to restore focus to and it falls to
 * `document.body` — the next Tab restarts at the top of the document. The
 * repo's rule (`components/builder/CLAUDE.md`) is next, then previous, then the
 * Add control once the list is empty, and the reason for that order is that a
 * list is usually pruned downward: focusing the row that slid into the gap
 * lets an author remove three rows with three presses.
 *
 * The intent has to outlive the commit, so it is STATE, set in the same event
 * as the removal. React batches the two into one render, so the render that
 * carries the intent is exactly the render that shows the removal's result.
 * It cannot be a ref: a ref is read by whichever effect runs next, and React
 * flushes a still-pending passive effect from an EARLIER commit (any render
 * that was not urgent, such as one a background refresh started) before it
 * renders the click's update. That stale effect saw the old, longer list, so
 * it would judge the fresh intent a refusal and discard it, and focus would
 * fall to `document.body` with no fallback. State is part of a render; a
 * render that began before the intent existed cannot see it.
 *
 * An intent is judged by ONE render and never again. A removal can be refused
 * (a stale edit, a dormant lookup carrier, the commit gate), and a refusal
 * renders without shortening the list. An intent still armed then would fire
 * against whatever changed the list next: the author reads the refusal, adds
 * a write, and focus jumps to an unrelated row's Remove button. So the effect
 * marks each intent handled the first time it sees it, focusing only when the
 * list actually got shorter.
 */

"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

type RemovalIntent = { readonly index: number; readonly count: number };

export function useRemovedRowFocus(count: number): {
	/** Attach to each row's durable focus target, by its index in the list. */
	readonly register: (index: number) => (el: HTMLElement | null) => void;
	/** Call when the author removes the row at `index`, before the commit. */
	readonly onRemoved: (index: number) => void;
	/** Focus a row after a reorder commits. */
	readonly focusRow: (index: number) => void;
	/** Attach to the Add control — where focus lands once nothing is left. */
	readonly addRef: RefObject<HTMLButtonElement | null>;
} {
	const rows = useRef<(HTMLElement | null)[]>([]);
	const addRef = useRef<HTMLButtonElement>(null);
	const [intent, setIntent] = useState<RemovalIntent | null>(null);
	const handled = useRef<RemovalIntent | null>(null);
	const frame = useRef<number | null>(null);

	// The frame is cancelled on UNMOUNT and at the next schedule — never from
	// the scheduling effect's own cleanup. That cleanup runs whenever the list
	// length changes again, so cancelling there would kill the pending focus
	// whenever a peer's edit lands inside the frame's window.
	useEffect(
		() => () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		},
		[],
	);

	useEffect(() => {
		if (intent === null || handled.current === intent) return;
		handled.current = intent;
		if (count >= intent.count) return;
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			/* The row that slid into the gap — or, when the last row went, the
			 * one now at the end. `count` is the live bound. */
			const target = rows.current[Math.min(intent.index, count - 1)];
			if (!focusAvailable(target)) focusAvailable(addRef.current);
		});
	}, [intent, count]);

	return {
		register: (index: number) => (el: HTMLElement | null) => {
			rows.current[index] = el;
		},
		onRemoved: (index: number) => {
			setIntent({ index, count });
		},
		focusRow: (index: number) => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
			frame.current = requestAnimationFrame(() => {
				frame.current = null;
				if (!focusAvailable(rows.current[index]))
					focusAvailable(addRef.current);
			});
		},
		addRef,
	};
}

function focusAvailable(element: HTMLElement | null | undefined): boolean {
	if (element === null || element === undefined) return false;
	if (element instanceof HTMLButtonElement && element.disabled) return false;
	element.focus();
	return document.activeElement === element;
}
