/**
 * scaffoldProgress — derive a 0..1 progress value for the signal grid
 * during an initial build. Pure function consumed by `ChatSidebar`'s
 * controller callback.
 *
 * Input is the already-derived phase plus the current stage + a couple
 * of content signals (case types + modules) so we can refine the
 * progress within the early generation phases. The phase carries the
 * "are we currently in a build?" bit — derived from the session events
 * buffer, not a shadow `agentActive` flag.
 */

import type { BlueprintDoc } from "@/lib/doc/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	type GenerationStage,
	GenerationStage as Stage,
} from "@/lib/session/types";

/**
 * Compute scaffold progress as a value in [0, 1]:
 *   - Loading / Idle → 0
 *   - Ready / Completed → 1 (app is usable)
 *   - Generating, DataModel stage → 0.05 (ramp-in) → 0.3 once case types land
 *   - Generating, Structure stage → 0.35 → 0.85 once the doc has modules
 *   - Generating, later stages (Modules / Forms / Validate / Fix) → 1 —
 *     the signal grid's "building" mode takes over the visual from here
 */
export function computeScaffoldProgress(
	phase: BuilderPhase,
	agentStage: GenerationStage | null,
	hasCaseTypes: boolean,
	docHasData: boolean,
): number {
	if (phase === BuilderPhase.Ready || phase === BuilderPhase.Completed) {
		return 1.0;
	}
	if (phase !== BuilderPhase.Generating) {
		/* Loading / Idle → no progress to show. */
		return 0;
	}

	/* Generating branch. `agentStage` is null in the window between
	 * `beginRun` (stream opens) and the first stage-tagged mutation
	 * landing. Treat identically to DataModel — without this guard, the
	 * null stage falls through to the 1.0 return at the bottom and the
	 * progress bar briefly shows "done". */
	if (agentStage === null || agentStage === Stage.DataModel) {
		return hasCaseTypes ? 0.3 : 0.05;
	}
	if (agentStage === Stage.Structure) {
		return docHasData ? 0.85 : 0.35;
	}
	/* Modules / Forms / Validate / Fix — signal grid takes over. */
	return 1.0;
}

/** Re-export for tests that want to pass a doc snapshot directly. */
export type ScaffoldProgressDoc = BlueprintDoc | null | undefined;
