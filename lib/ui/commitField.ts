import type { CommitOutcome } from "@/lib/domain";

/** Options for configuring commit/cancel/checkmark behavior. */
export interface CommitFieldOptions {
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

export interface CommitFieldSnapshot {
	readonly draft: string;
	readonly focused: boolean;
	readonly saved: boolean;
	readonly rejection: string | null;
	readonly rejectionNonce: number;
}

/** Only the browser adapter supplies these effects; the editing rules require no DOM. */
export interface CommitFieldEffects {
	blur?: () => void;
	focus?: () => void;
	select?: () => void;
}

/** One editor lifetime. Persistence is supplied by its owner and may refuse a commit. */
export function createCommitFieldModel(
	getOptions: () => CommitFieldOptions,
	effects: CommitFieldEffects = {},
) {
	let snapshot: CommitFieldSnapshot = {
		draft: getOptions().value,
		focused: false,
		saved: false,
		rejection: null,
		rejectionNonce: 0,
	};
	const listeners = new Set<() => void>();
	let disposed = false;
	let committed = false;
	let restoring = false;
	let savedTimer: ReturnType<typeof setTimeout> | undefined;

	const publish = (patch: Partial<CommitFieldSnapshot>) => {
		const next = { ...snapshot, ...patch };
		if (
			next.draft === snapshot.draft &&
			next.focused === snapshot.focused &&
			next.saved === snapshot.saved &&
			next.rejection === snapshot.rejection &&
			next.rejectionNonce === snapshot.rejectionNonce
		)
			return;
		snapshot = next;
		for (const listener of listeners) listener();
	};
	const clearTimer = () => {
		if (savedTimer !== undefined) clearTimeout(savedTimer);
		savedTimer = undefined;
	};
	const focus = () => {
		committed = false;
		if (restoring) return;
		const options = getOptions();
		publish({ draft: options.value, focused: true, rejection: null });
		if (options.selectAll) effects.select?.();
	};
	const commit = () => {
		if (committed || disposed) return;
		committed = true;
		publish({ focused: false });
		effects.blur?.();
		const options = getOptions();
		const trimmed = snapshot.draft.trim();
		if (!trimmed && options.onEmpty) {
			options.onEmpty();
			return;
		}
		if ((options.required && !trimmed) || trimmed === options.value) return;
		if (options.validate && !options.validate(trimmed)) return;
		const outcome = options.onSave(trimmed);
		if (outcome?.ok === false) {
			if (outcome.messages.length > 0) {
				committed = false;
				publish({
					focused: true,
					rejection: outcome.messages[0],
					rejectionNonce: snapshot.rejectionNonce + 1,
				});
				restoring = true;
				try {
					effects.focus?.();
				} finally {
					restoring = false;
				}
			}
			return;
		}
		if (disposed) return;
		clearTimer();
		publish({ rejection: null, saved: true });
		if (disposed) return;
		savedTimer = setTimeout(() => {
			savedTimer = undefined;
			publish({ saved: false });
		}, 1500);
	};
	const cancel = () => {
		committed = true;
		publish({ rejection: null, focused: false });
		effects.blur?.();
		const options = getOptions();
		if (!options.value.trim()) options.onEmpty?.();
	};

	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		focus,
		setDraft: (draft: string) => publish({ draft, rejection: null }),
		commit,
		cancel,
		blur: () => {
			if (committed) {
				committed = false;
				return;
			}
			commit();
		},
		/** Whether a key belongs to this editor; the browser handles cancellation. */
		key: (key: string, modifier = false): boolean => {
			if (key === "Escape") {
				cancel();
				return true;
			}
			if (key === "Enter" && (!getOptions().multiline || modifier)) {
				commit();
				return true;
			}
			return false;
		},
		activate: () => {
			disposed = false;
		},
		dispose: () => {
			disposed = true;
			clearTimer();
			snapshot = { ...snapshot, saved: false };
		},
	};
}
