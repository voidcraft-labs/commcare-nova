/**
 * scaffoldProgress — derive a 0..1 progress value from the session store's
 * generation lifecycle fields + the doc store's entity counts. Consumed by
 * `ChatSidebar.tsx` to drive the progress indicator during generation.
 *
 * Pure function: callers pass in the session state slice and doc snapshot,
 * keeping this module free of store subscriptions. Colocated with the
 * sidebar because the derivation is sidebar-specific — it reads state that
 * only exists on the client and renders exclusively inside the one
 * `"use client"` component that calls it.
 */

import type { BlueprintDoc } from "@/lib/doc/types";
import type { GenerationStage } from "@/lib/session/types";
import { GenerationStage as Stage } from "@/lib/session/types";

/** Session store fields needed for scaffold progress computation. */
export interface ScaffoldProgressInput {
	agentStage: GenerationStage | null;
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
 *   - Structure stage → 0.35 (initial) → 0.85 (full scaffold = doc has entities).
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

	/* Early generation: agentStage is null in the brief window between
	 * setAgentActive(true) (chat status effect) and beginAgentWrite()
	 * (data-start-build event). Treat identically to DataModel — without
	 * this guard, the null stage falls through to the 1.0 return at the
	 * bottom and the progress bar briefly shows "done". */
	if (session.agentStage === null || session.agentStage === Stage.DataModel) {
		const hasCaseTypes = (doc?.caseTypes?.length ?? 0) > 0;
		return hasCaseTypes ? 0.3 : 0.05;
	}

	/* Structure stage: doc entity creation. */
	if (session.agentStage === Stage.Structure) {
		if (docHasData) return 0.85;
		return 0.35;
	}

	/* Modules / Forms / Validate / Fix — signal grid takes over. */
	return 1.0;
}
