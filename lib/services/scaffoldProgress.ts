/**
 * scaffoldProgress — derive a 0..1 progress value from the session store's
 * generation lifecycle fields + the doc store's entity counts.
 *
 * Pure function: callers pass in the session state slice and doc state,
 * keeping this module free of store subscriptions. The signal grid
 * controller polls this on rAF; ChatSidebar calls it for the progress
 * indicator.
 *
 * Phase 4 rewrote this to read from the session store (generation stage,
 * partial scaffold, agent lifecycle flags) instead of the legacy builder
 * store. Callers that still pass legacy store state will have type errors
 * until they migrate in T7.
 */

import type { BlueprintDoc } from "@/lib/doc/types";
import type { GenerationStage, PartialScaffoldData } from "@/lib/session/types";
import { GenerationStage as Stage } from "@/lib/session/types";

/** Session store fields needed for scaffold progress computation. */
export interface ScaffoldProgressInput {
	agentStage: GenerationStage | null;
	partialScaffold: PartialScaffoldData | undefined;
	agentActive: boolean;
	postBuildEdit: boolean;
	justCompleted: boolean;
	loading: boolean;
}

/**
 * Compute the current scaffold progress as a value in [0, 1].
 *
 * Branching:
 *   - Not generating → 0 (not started / loading) or 1 (already ready).
 *   - DataModel stage → 0.05 (ramp-in) until case types arrive, then 0.3.
 *   - Structure stage → 0.35 (initial) → 0.55 (partial scaffold) → 0.85
 *     (full scaffold = doc has entities).
 *   - Later stages (Modules / Forms / Validate / Fix) → 1.0, since the
 *     signal grid's "building" mode takes over from here.
 */
export function computeScaffoldProgress(
	session: ScaffoldProgressInput,
	doc: BlueprintDoc | null | undefined,
): number {
	const docHasData = (doc?.moduleOrder.length ?? 0) > 0;
	const isGenerating = session.agentActive && !session.postBuildEdit;
	const isReady = !session.loading && !session.agentActive && docHasData;

	/* Not in a generation run — either idle/loading (0) or app is ready (1). */
	if (!isGenerating) {
		return isReady || session.justCompleted ? 1.0 : 0;
	}

	/* DataModel stage: case types arriving on the doc bump from 0.05 → 0.3. */
	if (session.agentStage === Stage.DataModel) {
		const hasCaseTypes = (doc?.caseTypes?.length ?? 0) > 0;
		return hasCaseTypes ? 0.3 : 0.05;
	}

	/* Structure stage: partial scaffold → doc entity creation. */
	if (session.agentStage === Stage.Structure) {
		if (docHasData) return 0.85;
		if (session.partialScaffold) return 0.55;
		return 0.35;
	}

	/* Modules / Forms / Validate / Fix — signal grid takes over. */
	return 1.0;
}
