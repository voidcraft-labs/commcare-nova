/**
 * The canonical mutation host — the persistence side of the canonical
 * workspace.
 *
 * A host owns HOW an accepted batch reaches durable state and what the
 * surface emits around it; the workspace owns the document, the ordering,
 * and the gate. Two hosts implement this contract today:
 *
 *   - `GenerationContext` (chat) — commits inline through the canonical
 *     commit kernel (`commitGuardedBatch` / `applyBlueprintChange` for the
 *     case-store-coupled batches), emits `data-mutations` SSE + event-log
 *     envelopes only AFTER the commit resolves, latches terminal scope
 *     errors, and provides the authorized conflict reload.
 *   - `McpContext` (MCP) — commits through `applyBlueprintChange`'s
 *     transactional guarded save; a rejection propagates to the adapter's
 *     error envelope (per-call doc lifecycle, no reload).
 *
 * Tool bodies never see this interface: they reach persistence only through
 * `ToolInvocationContext.applyBatch` / `applyStages`, which the workspace
 * implements over this host.
 */

import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import type { AdmittedMutationStages } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	RecordMutationsOptions,
	RecordMutationsResult,
} from "../toolExecutionContext";
import type { ToolInvocationContext } from "./types";

export interface CanonicalMutationHost {
	readonly appId: string;
	readonly projectId: string;
	readonly userId: string;
	readonly runId: string;
	readonly chatRunHolder?: ToolInvocationContext["chatRunHolder"];
	readonly lookupDefinitions?: ToolInvocationContext["lookupDefinitions"];
	readonly lookupCatalog?: ToolInvocationContext["lookupCatalog"];
	readonly conversionImpact: ToolInvocationContext["conversionImpact"];

	/**
	 * Persist one prepared batch through the canonical commit boundary.
	 * Resolves only after durable persistence; the returned `committedDoc` is
	 * the writer's fresh committed doc (a concurrent peer edit merged in). A
	 * rejection (`BlueprintCommitRejectedError`) or terminal authority error
	 * propagates — the host never swallows persistence errors.
	 */
	recordMutations(
		prepared: PreparedMutationCandidate,
		stage?: string,
		options?: RecordMutationsOptions,
	): Promise<RecordMutationsResult>;

	/**
	 * Persist a multi-stage sequence as ONE save (one batch id, one seq).
	 * Per-stage envelopes keep their own event tags; a rejection anywhere
	 * commits zero of the stages.
	 */
	recordMutationStages(
		prepared: PreparedMutationCandidate,
		stages: AdmittedMutationStages,
	): Promise<RecordMutationsResult>;

	/**
	 * Load one fresh AUTHORIZED snapshot after an authoritative commit
	 * conflict, so the workspace continues from current server state rather
	 * than its stale document. Chat implements it (latching terminal scope
	 * errors — lost access, moved Project — before throwing them); MCP omits
	 * it, because its doc lifecycle is per-call and a rejection simply
	 * propagates to the wire envelope.
	 */
	reloadAuthorizedSnapshot?(): Promise<BlueprintDoc>;
}
