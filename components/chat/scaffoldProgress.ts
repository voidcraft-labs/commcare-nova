/**
 * scaffoldProgress — derive a 0..1 progress value for the signal grid
 * during an initial build. Pure function consumed by `ChatSidebar`'s
 * controller callback.
 *
 * Input is the already-derived phase plus the current milestone and whether
 * case types have landed, so we can refine progress while the foundation is
 * being established. The phase carries the
 * "are we currently in a build?" bit — derived from the session events
 * buffer, not a shadow `agentActive` flag.
 */

import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	type GenerationStage,
	GenerationStage as Stage,
} from "@/lib/session/types";
import type { SignalMode } from "@/lib/signalGridController";

/** Generation-owned signal-grid mode, or null when the current run is an edit
 *  (or has not established a generation milestone). Stage tags alone cannot
 *  distinguish those cases because initial builds and edits share tools. */
export function deriveGenerationSignalMode(
	isGenerating: boolean,
	agentStage: GenerationStage | null,
): SignalMode | null {
	if (!isGenerating || agentStage === null) return null;
	if (agentStage === Stage.Foundation) return "scaffolding";
	return "building";
}

/**
 * Compute scaffold progress as a value in [0, 1]:
 *   - Loading / Idle → 0
 *   - Ready / Completed → 1 (app is usable)
 *   - Generating, Foundation milestone → 0.05 → 0.3 once case types land
 *   - Generating, Build / historical Fix milestones → 1 —
 *     the signal grid's "building" mode takes over the visual from here
 */
export function computeScaffoldProgress(
	phase: BuilderPhase,
	agentStage: GenerationStage | null,
	hasCaseTypes: boolean,
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
	 * landing. Treat identically to Foundation — without this guard, the
	 * null stage falls through to the 1.0 return at the bottom and the
	 * progress bar briefly shows "done". */
	if (agentStage === null || agentStage === Stage.Foundation) {
		return hasCaseTypes ? 0.3 : 0.05;
	}
	/* Build / historical Fix — signal grid takes over. */
	return 1.0;
}
