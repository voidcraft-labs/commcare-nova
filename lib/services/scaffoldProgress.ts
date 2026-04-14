/**
 * scaffoldProgress — derive a 0..1 progress value from the legacy store's
 * generation lifecycle fields + the doc store's case-type count.
 *
 * Replaces the `BuilderEngine.scaffoldProgress` getter. Lives here as a
 * pure function so the signal grid controller (which polls on rAF) can
 * compute progress without holding a class reference — callers pass the
 * two store states in directly.
 *
 * Phase 4 will rewrite generation as a mutation stream and this helper
 * goes away: scaffold progress becomes a derived selector on the doc
 * store's entity counts instead of a custom heuristic over lifecycle
 * flags + partial scaffold data.
 */

import type { BlueprintDoc } from "@/lib/doc/types";
import type { BuilderState } from "@/lib/services/builderStore";
import { BuilderPhase, GenerationStage } from "./builder";

/**
 * Compute the current scaffold progress as a value in [0, 1].
 *
 * Branching:
 *   - Not generating → 0 (not started) or 1 (already ready).
 *   - DataModel stage → 0.05 (ramp-in) until case types arrive, then 0.3.
 *   - Structure stage → 0.35 (initial) → 0.55 (partial scaffold) → 0.85
 *     (full scaffold).
 *   - Later stages (Modules / Forms / Validate / Fix) → 1.0, since the
 *     signal grid's "building" mode takes over from here.
 */
export function computeScaffoldProgress(
	s: BuilderState,
	doc: BlueprintDoc | null | undefined,
): number {
	if (s.phase !== BuilderPhase.Generating) {
		return s.phase === BuilderPhase.Ready || s.phase === BuilderPhase.Completed
			? 1.0
			: 0;
	}

	if (s.generationStage === GenerationStage.DataModel) {
		/* Case types live on the doc store; fall back to 0.05 (no case types
		 * received yet) when the bridge hasn't connected a doc. */
		const hasCaseTypes = (doc?.caseTypes?.length ?? 0) > 0;
		return hasCaseTypes ? 0.3 : 0.05;
	}
	if (s.generationStage === GenerationStage.Structure) {
		const gen = s.generationData;
		if (gen?.scaffold) return 0.85;
		if (gen?.partialScaffold) return 0.55;
		return 0.35;
	}
	return 1.0;
}
