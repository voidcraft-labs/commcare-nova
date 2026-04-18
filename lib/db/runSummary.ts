/**
 * Per-run cost/behavior summary writer. One document per generation run
 * at `apps/{appId}/runs/{runId}`. Fire-and-forget; a Firestore outage
 * does not block request finalization.
 */
import { log } from "@/lib/logger";
import { docs } from "./firestore";
import type { RunSummaryDoc } from "./types";

/**
 * Write (or overwrite) a run summary document. Safe to call multiple
 * times — the same runId maps to the same doc ID. The last call wins.
 *
 * Used by `UsageAccumulator.flush` on request end. Admin inspection
 * scripts read from here for per-run cost analytics.
 */
export function writeRunSummary(
	appId: string,
	runId: string,
	summary: RunSummaryDoc,
): void {
	docs
		.run(appId, runId)
		.set(summary)
		.catch((err) =>
			log.error("[writeRunSummary] Firestore write failed", err, {
				appId,
				runId,
			}),
		);
}
