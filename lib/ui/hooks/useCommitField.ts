"use client";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import {
	type CommitFieldOptions,
	createCommitFieldModel,
} from "../commitField";

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

/** React subscribes to the editor model; DOM focus, blur, and selection stay here. */
export function useCommitField(
	options: CommitFieldOptions,
): UseCommitFieldResult {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
	const model = useMemo(
		() =>
			createCommitFieldModel(() => optionsRef.current, {
				blur: () => inputRef.current?.blur(),
				focus: () => inputRef.current?.focus(),
				select: () => inputRef.current?.select(),
			}),
		[],
	);
	const snapshot = useSyncExternalStore(
		model.subscribe,
		model.getSnapshot,
		model.getSnapshot,
	);
	useEffect(() => {
		model.activate();
		return () => model.dispose();
	}, [model]);
	const ref = useCallback(
		(element: HTMLInputElement | HTMLTextAreaElement | null) => {
			inputRef.current = element;
		},
		[],
	);
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (model.key(event.key, event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				event.stopPropagation();
			}
		},
		[model],
	);
	return {
		...snapshot,
		draft: snapshot.focused ? snapshot.draft : options.value,
		setDraft: model.setDraft,
		ref,
		handleFocus: model.focus,
		handleBlur: model.blur,
		handleKeyDown,
	};
}
