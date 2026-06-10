/**
 * Commit-phase plumbing for the builder's mutation gate.
 *
 * `useBlueprintMutations` gates every UI-originated batch through
 * `commitVerdicts.ts::mutationCommitVerdict`, which needs the app's
 * lifecycle phase (`"building"` while a generation run is constructing
 * the app, `"complete"` otherwise). That phase is derived from SESSION
 * state — and `lib/doc` cannot import `lib/session` (the session package
 * already imports doc hooks; the reverse edge would close an import
 * cycle). So the builder supplies the phase from above: a bridge
 * component inside the session provider (see
 * `components/builder/BuilderProvider.tsx`) writes the derived phase
 * into the mutable ref this context carries.
 *
 * The context value is a STABLE ref object, not the phase itself —
 * consumers read `ref.current` at dispatch time (the same lazy-snapshot
 * discipline as the hook's `store.getState()`), so a phase flip at run
 * start/end never re-renders the dozens of components holding the
 * mutation API. The default reads `"complete"`: outside a builder
 * session there is no construction window, and complete is the stricter
 * (fail-closed) direction.
 */

"use client";

import { createContext, type ReactNode, useContext, useRef } from "react";
import type { CommitPhase } from "@/lib/doc/commitVerdicts";

export interface CommitPhaseRef {
	current: CommitPhase;
}

const DEFAULT_REF: CommitPhaseRef = { current: "complete" };

const CommitPhaseContext = createContext<CommitPhaseRef>(DEFAULT_REF);

/**
 * Provide the commit phase to the doc mutation hook. `phase` is read
 * into a stable ref on every render — the provider's own re-render (the
 * bridge component subscribes to the session phase) is what keeps the
 * ref current, while consumers never re-render off it.
 */
export function CommitPhaseProvider({
	phase,
	children,
}: {
	phase: CommitPhase;
	children: ReactNode;
}) {
	const ref = useRef<CommitPhaseRef>({ current: phase });
	ref.current.current = phase;
	return (
		<CommitPhaseContext.Provider value={ref.current}>
			{children}
		</CommitPhaseContext.Provider>
	);
}

/** The stable phase ref — read `.current` at dispatch time. */
export function useCommitPhaseRef(): CommitPhaseRef {
	return useContext(CommitPhaseContext);
}
