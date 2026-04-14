/**
 * builderSelectors — pure selectors for the legacy BuilderState.
 *
 * Selectors return primitives or stable references (booleans, strings,
 * Immer-managed objects). Safe to pass directly to `useBuilderStore(selector)`.
 *
 * TreeData derivation has moved to `lib/doc/hooks/useDocTreeData.ts` —
 * reads directly from the doc store, no legacy mirrored entities.
 * `selectHasData` has moved to `lib/doc/hooks/useDocHasData.ts`.
 *
 * Breadcrumb derivation lives in the `useBreadcrumbs` hook in
 * `lib/routing/hooks.tsx` — URL-driven, no store dependency.
 */

import {
	BuilderPhase,
	type GenerationError,
	type GenerationStage,
} from "./builder";
import type { BuilderState } from "./builderStore";

// ── Lifecycle selectors ────────────────────────────────────────────────

/** True when the builder has entity data and is interactive (Ready or Completed). */
export function selectIsReady(s: BuilderState): boolean {
	return s.phase === BuilderPhase.Ready || s.phase === BuilderPhase.Completed;
}

// ── Replay selectors ──────────────────────────────────────────────────

/** True when the builder is in replay mode (replay stages loaded in store). */
export function selectInReplayMode(s: BuilderState): boolean {
	return s.replayStages !== undefined;
}

// ── Field selectors (single-field reads for component subscriptions) ──

/** Current generation stage (null when not generating). */
export function selectGenStage(s: BuilderState): GenerationStage | null {
	return s.generationStage;
}

/** Current generation error (null when no error). */
export function selectGenError(s: BuilderState): GenerationError {
	return s.generationError;
}

/** Current generation status message. */
export function selectStatusMsg(s: BuilderState): string {
	return s.statusMessage;
}
