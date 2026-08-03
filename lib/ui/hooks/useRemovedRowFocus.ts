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
 * The intent has to outlive the commit, so it rides a ref — but it must not
 * outlive it by more than ONE render. A removal can be refused (a stale edit, a
 * dormant lookup carrier, the commit gate), and a refusal renders without
 * shortening the list. An intent that waited for the list to shrink would still
 * be armed then, and would fire against whatever changed the list next — the
 * author reads the refusal, adds a write, and focus jumps to an unrelated row's
 * Remove button. So the effect runs on EVERY render and always consumes the
 * intent: it focuses only when the list actually got shorter, and otherwise
 * discards it.
 */

"use client";

import { type RefObject, useEffect, useRef } from "react";

export function useRemovedRowFocus(count: number): {
	/** Attach to each row's remove control, by its index in the list. */
	readonly register: (index: number) => (el: HTMLButtonElement | null) => void;
	/** Call when the author removes the row at `index`, before the commit. */
	readonly onRemoved: (index: number) => void;
	/** Focus a row after a reorder commits. */
	readonly focusRow: (index: number) => void;
	/** Attach to the Add control — where focus lands once nothing is left. */
	readonly addRef: RefObject<HTMLButtonElement | null>;
} {
	const rows = useRef<(HTMLButtonElement | null)[]>([]);
	const addRef = useRef<HTMLButtonElement>(null);
	const pending = useRef<{ index: number; count: number } | null>(null);
	const frame = useRef<number | null>(null);

	// The frame is cancelled on UNMOUNT and at the next schedule — never from
	// the scheduling effect's own cleanup. That effect is un-keyed, so its
	// cleanup runs before every later render's effect; cancelling there would
	// kill the pending focus whenever any render at all lands inside the
	// frame's window, and this component re-renders on every document change.
	// The unmount cancel is also what keeps a live rAF out of the async-leak
	// detector CI runs the whole suite under.
	useEffect(
		() => () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		},
		[],
	);

	// Deliberately un-keyed: the question is "did the render that just landed
	// remove the row?", which has to be asked on the very next render whatever
	// caused it — a dep array would skip the render that refuses.
	useEffect(() => {
		const intent = pending.current;
		if (intent === null) return;
		pending.current = null;
		if (count >= intent.count) return;
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			/* The row that slid into the gap — or, when the last row went, the
			 * one now at the end. `count` is the live bound. */
			const target = rows.current[Math.min(intent.index, count - 1)];
			(target ?? addRef.current)?.focus();
		});
	});

	return {
		register: (index: number) => (el: HTMLButtonElement | null) => {
			rows.current[index] = el;
		},
		onRemoved: (index: number) => {
			pending.current = { index, count };
		},
		focusRow: (index: number) => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
			frame.current = requestAnimationFrame(() => {
				frame.current = null;
				(rows.current[index] ?? addRef.current)?.focus();
			});
		},
		addRef,
	};
}
