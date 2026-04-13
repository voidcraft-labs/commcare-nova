"use client";

/**
 * EditGuardContext — scoped context that gates URL-driven selection changes
 * when an inline editor has unsaved content.
 *
 * Replaces `BuilderEngine._editGuard` / `setEditGuard` / `clearEditGuard` /
 * `checkEditGuard` with a React-context-based registration pattern.
 *
 * **Contract:**
 * - A single current predicate is allowed (mirrors engine's behavior — there's
 *   only ever one inline editor with unsaved content at a time).
 * - `useRegisterEditGuard(predicate, enabled)` installs the predicate when
 *   `enabled` is true and clears on unmount.
 * - Last-write-wins: if a second hook registers while an earlier one is active,
 *   the new predicate takes over. Cleanup only nulls when
 *   `predicateRef.current === predicate` still matches — so stale cleanups
 *   from an earlier registration are harmless.
 * - `useConsultEditGuard()` returns a stable function that evaluates the
 *   current predicate: `true` = safe to proceed, `false` = block.
 */

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";

// ── Types ──────────────────────────────────────────────────────────────

/** A predicate evaluated on selection attempts. Return `true` if it's
 *  safe to leave the current editor, `false` to block the transition. */
export type EditGuardPredicate = () => boolean;

/** Internal API shape — exposed via context, consumed by the public hooks. */
interface EditGuardApi {
	register: (predicate: EditGuardPredicate) => () => void;
	consult: () => boolean;
}

// ── Context ────────────────────────────────────────────────────────────

const EditGuardContext = createContext<EditGuardApi | null>(null);

// ── Provider ───────────────────────────────────────────────────────────

/**
 * Provides the edit-guard registration and consultation surface.
 *
 * Mount once inside `BuilderProvider`. The ref-based predicate storage
 * means this component never re-renders its children — no performance
 * cost from registration churn.
 */
export function EditGuardProvider({ children }: { children: ReactNode }) {
	const predicateRef = useRef<EditGuardPredicate | null>(null);

	const api = useMemo<EditGuardApi>(
		() => ({
			register(predicate) {
				predicateRef.current = predicate;
				return () => {
					/* Only null if our predicate is still the active one.
					 * A later registration may have already replaced it. */
					if (predicateRef.current === predicate) {
						predicateRef.current = null;
					}
				};
			},
			consult() {
				const p = predicateRef.current;
				return p ? p() : true;
			},
		}),
		[],
	);

	return <EditGuardContext value={api}>{children}</EditGuardContext>;
}

// ── Internal accessor ──────────────────────────────────────────────────

function useEditGuardApi(): EditGuardApi {
	const ctx = useContext(EditGuardContext);
	if (!ctx) {
		throw new Error("EditGuard hooks must be used within EditGuardProvider");
	}
	return ctx;
}

// ── Public hooks ───────────────────────────────────────────────────────

/**
 * Install an edit guard predicate. Called by inline editors that have
 * unsaved content and want to block selection changes.
 *
 * The predicate is evaluated on selection attempts. Return `true` if it's
 * safe to leave, `false` to block. Registration is last-write-wins and
 * auto-clears on unmount.
 *
 * The `enabled` parameter prevents re-registering on every keystroke:
 * the editor sets `enabled = true` on focus and `false` on blur/commit/cancel,
 * so the guard is only active while the editor is in an editing state.
 * Without this, every change to the predicate's closure (e.g. a new
 * `hasUnsavedContent` value) would trigger a deregister-register cycle.
 */
export function useRegisterEditGuard(
	predicate: EditGuardPredicate,
	enabled: boolean,
): void {
	const { register } = useEditGuardApi();
	useEffect(() => {
		if (!enabled) return;
		return register(predicate);
	}, [register, predicate, enabled]);
}

/**
 * Returns a stable function that evaluates the current edit guard.
 * `true` means "safe to proceed", `false` means "block".
 *
 * Used by routing hooks (`useSelect`) to gate URL-driven selection
 * changes — the spec line: "useSelect hook consults
 * EditGuardContext.canLeave() before calling router.replace."
 */
export function useConsultEditGuard(): () => boolean {
	const { consult } = useEditGuardApi();
	return consult;
}
