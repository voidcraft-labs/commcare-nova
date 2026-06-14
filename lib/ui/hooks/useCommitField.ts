"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitOutcome } from "@/lib/domain";

/** Options for configuring commit/cancel/checkmark behavior. */
interface UseCommitFieldOptions {
	/** Current persisted value — the source of truth outside of editing. */
	value: string;
	/**
	 * Called when a changed value is committed (after validation, if any).
	 * May return the gated dispatch's `CommitOutcome`: an `ok: false`
	 * with messages means the validity gate refused the edit — the hook
	 * then RESTORES editing with the draft intact (typed input is never
	 * discarded) and exposes the first finding via `rejection` so the
	 * consumer renders it inline. A `void` return reads as committed.
	 */
	onSave: (value: string) => CommitOutcome | undefined;
	/**
	 * Optional pre-save validation. Return `false` to reject the commit —
	 * the save will not fire and the checkmark animation will be suppressed.
	 * Useful for blocking renames on sibling conflicts, invalid XPath, etc.
	 */
	validate?: (value: string) => boolean;
	/**
	 * Called when the field is committed empty (value cleared + committed).
	 * Typically used to trigger deletion of the associated item.
	 * Mutually exclusive with `required`.
	 */
	onEmpty?: () => void;
	/**
	 * When true, committing an empty value reverts to the previous value instead
	 * of calling onSave. Mutually exclusive with `onEmpty`.
	 */
	required?: boolean;
	/**
	 * Multi-line mode: plain Enter inserts a newline; Cmd/Ctrl+Enter commits.
	 * Single-line (default): Enter commits.
	 */
	multiline?: boolean;
	/** If true, all text is selected when the field gains focus. */
	selectAll?: boolean;
}

/** Result returned by useCommitField. */
interface UseCommitFieldResult {
	/**
	 * The value to display in the input: the in-progress draft while focused,
	 * or the stable prop value when blurred. Prevents stale draft flicker after
	 * blur and correctly reflects undo/redo without a synchronization effect.
	 */
	draft: string;
	/** Update the internal draft. Wire to the input's onChange handler. */
	setDraft: (v: string) => void;
	/** Whether the field is actively being edited. */
	focused: boolean;
	/**
	 * True for 1.5 seconds after a successful commit.
	 * Use this to drive a checkmark animation in the label row.
	 */
	saved: boolean;
	/**
	 * The validity gate's first finding when the last commit attempt was
	 * refused, else `null`. The hook keeps the field in edit mode with
	 * the draft intact while this is set; cleared on the next keystroke,
	 * focus, or successful commit. Consumers render it inline beside the
	 * input.
	 */
	rejection: string | null;
	/**
	 * Increments on every refused commit — including a repeat refusal of
	 * the SAME draft, which leaves `rejection` textually unchanged.
	 * Consumers key the physical feedback (input shake) on this so a
	 * second Enter on an unchanged bad value still visibly bounces.
	 */
	rejectionNonce: number;
	/** Callback ref to attach to the input/textarea element. */
	ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => void;
	/** Wire to the input's onFocus. */
	handleFocus: () => void;
	/** Wire to the input's onBlur. */
	handleBlur: () => void;
	/**
	 * Wire to the input's onKeyDown.
	 * - Single-line: Enter commits.
	 * - Multiline: Cmd/Ctrl+Enter commits; plain Enter inserts a newline.
	 * - Escape: cancels and stopPropagation (prevents the parent popover from
	 *   closing when the user only wants to cancel the edit).
	 */
	handleKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * Encapsulates the commit/cancel/checkmark model shared across all inline text
 * editors in the builder: EditableText and InlineField (form settings).
 *
 * Draft isolation while focused, Enter/blur to commit, Escape to cancel.
 * committedRef prevents double-commit when Enter triggers blur.
 * `saved` is true for 1.5 s after a successful commit for checkmark animation.
 */
export function useCommitField({
	value,
	onSave,
	validate,
	onEmpty,
	required,
	multiline,
	selectAll,
}: UseCommitFieldOptions): UseCommitFieldResult {
	const [internalDraft, setInternalDraft] = useState(value);
	const [focused, setFocused] = useState(false);
	const [saved, setSaved] = useState(false);
	const [rejection, setRejection] = useState<string | null>(null);
	const [rejectionNonce, setRejectionNonce] = useState(0);

	// Guards against double-commit: set before imperative .blur() so handleBlur
	// knows not to re-commit after Enter or Escape already fired.
	const committedRef = useRef(false);
	/* Set by a rejected commit just before its programmatic refocus. The
	 * focus event fires synchronously (before React re-renders), so
	 * `handleFocus` can't read the just-set state — this ref is how it
	 * knows to KEEP the draft + rejection instead of snapshotting the
	 * prop value over them. */
	const restoringRef = useRef(false);
	const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

	const ref = useCallback(
		(el: HTMLInputElement | HTMLTextAreaElement | null) => {
			inputRef.current = el;
		},
		[],
	);

	// When not focused, always show the authoritative prop value — undo/redo
	// changes are visible without a synchronization effect.
	const draft = focused ? internalDraft : value;

	// Clear the saved checkmark after 1.5s. Cleanup cancels the timer if
	// the consumer unmounts mid-window or fires a fresh commit before the
	// previous one drops.
	useEffect(() => {
		if (!saved) return;
		const timer = setTimeout(() => setSaved(false), 1500);
		return () => clearTimeout(timer);
	}, [saved]);

	const commit = useCallback(() => {
		if (committedRef.current) return;
		committedRef.current = true;
		setFocused(false);
		inputRef.current?.blur();
		const trimmed = internalDraft.trim();
		if (!trimmed && onEmpty) {
			onEmpty();
			return;
		}
		if (required && !trimmed) return;
		if (trimmed !== value) {
			if (validate && !validate(trimmed)) return;
			const outcome = onSave(trimmed);
			if (outcome && outcome.ok === false) {
				/* The validity gate refused the edit. Restore editing with
				 * the draft intact — the user's typed input must survive the
				 * bounced commit — and surface the first finding inline. A
				 * messageless rejection is a silent no-op (stale uuid), which
				 * keeps the legacy quiet behavior: no error, no refocus. */
				if (outcome.messages.length > 0) {
					committedRef.current = false;
					setRejection(outcome.messages[0]);
					setRejectionNonce((n) => n + 1);
					setFocused(true);
					restoringRef.current = true;
					inputRef.current?.focus();
				}
				return;
			}
			setRejection(null);
			setSaved(true);
		}
	}, [internalDraft, value, onSave, validate, onEmpty, required]);

	const cancel = useCallback(() => {
		committedRef.current = true;
		// Escape reverts to the persisted value — nothing refused remains on
		// screen, so the rejection notice must leave with the draft.
		setRejection(null);
		setFocused(false);
		inputRef.current?.blur();
		// If the field had no value to begin with, cancel still removes the item.
		if (!value.trim() && onEmpty) onEmpty();
	}, [value, onEmpty]);

	const handleFocus = useCallback(() => {
		committedRef.current = false;
		if (restoringRef.current) {
			/* Re-entry from a rejected commit's programmatic refocus — keep
			 * the draft (the whole point is not losing it) and the
			 * rejection message it just set. */
			restoringRef.current = false;
			setFocused(true);
			return;
		}
		setRejection(null);
		// Snapshot prop value as editing baseline — captures undo/redo changes
		// that happened while the field was blurred.
		setInternalDraft(value);
		setFocused(true);
		// React's onFocus fires after the browser positions the caret, so
		// `.select()` here just overrides it — no deferral needed.
		if (selectAll) inputRef.current?.select();
	}, [value, selectAll]);

	const handleBlur = useCallback(() => {
		if (committedRef.current) {
			committedRef.current = false;
			return;
		}
		commit();
	}, [commit]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				if (multiline) {
					if (e.metaKey || e.ctrlKey) {
						e.preventDefault();
						e.stopPropagation();
						commit();
					}
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				commit();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				cancel();
			}
		},
		[multiline, commit, cancel],
	);

	const setDraft = useCallback((v: string) => {
		setRejection(null);
		setInternalDraft(v);
	}, []);

	return {
		draft,
		setDraft,
		focused,
		saved,
		rejection,
		rejectionNonce,
		ref,
		handleFocus,
		handleBlur,
		handleKeyDown,
	};
}
