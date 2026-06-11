/**
 * Narrow context interface shared between the two surfaces that execute
 * SA tools:
 *
 *   - GenerationContext (lib/agent/generationContext.ts) — chat surface,
 *     implements this via its existing methods.
 *   - McpContext (lib/mcp/context.ts) — MCP surface, implements this by
 *     declaration.
 *
 * The interface is deliberately small. It exposes only what tool bodies
 * legitimately need to perform their domain work. Anything surface-
 * specific (spend cap, web UI state sync, SSE writer, progress token,
 * prompt cache) stays on the concrete class and never leaks into shared
 * tool logic.
 *
 * Tool modules in lib/agent/tools/<name>.ts take `ctx: ToolExecutionContext`
 * in their execute signature, never the concrete GenerationContext or
 * McpContext. The concrete class is chosen by the caller (chat route vs
 * MCP adapter).
 */

import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import type { MediaAttachExpectation } from "@/lib/media/attachVerdicts";

export interface ToolExecutionContext {
	/** Current app id. Every tool operates against one app. */
	readonly appId: string;

	/** Authenticated user id. Used by tools that need to resolve
	 * user-scoped resources (e.g., KMS-encrypted HQ credentials). */
	readonly userId: string;

	/** Per-run grouping id. Stamped on every event envelope. */
	readonly runId: string;

	/**
	 * Persist a mutation batch to the durable event log and to Firestore.
	 * Returns the built envelopes so callers can correlate with tool-
	 * response metadata without rebuilding them.
	 *
	 * `doc` is the POST-mutation blueprint — the result of
	 * `applyToDoc(preMutationDoc, mutations)`. Implementations persist the
	 * passed-in value. Callers MUST apply the mutations to a new doc
	 * before invoking this method.
	 *
	 * Async to let implementations await durable persistence when that's
	 * part of their contract. Callers must not infer durability from
	 * promise resolution alone — consult the concrete surface's docstring
	 * for the actual persistence semantics.
	 *
	 * `mediaExpectations` carries the media attach verdict's per-asset
	 * requirements when the batch attaches asset references (see
	 * `lib/media/attachVerdicts.ts`). The tool has already run the
	 * pre-commit verdict; a surface whose save is transactional (MCP)
	 * re-applies the per-asset judgment to rows read INSIDE the same
	 * transaction that re-verdicts the batch, so the asset state the
	 * commit relies on can't be raced out from under it. The chat surface
	 * ignores it — its run owns the doc between the pre-commit read and
	 * the fire-and-forget save.
	 */
	recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
		mediaExpectations?: readonly MediaAttachExpectation[],
	): Promise<MutationEvent[]>;

	/**
	 * Persist a multi-stage mutation sequence as ONE save. The stages keep
	 * their per-stage event-log tags (`convert:`/`rename:`/`edit:` chapter
	 * shapes), but the blueprint write is a single unit: an implementation
	 * whose save can reject (the MCP surface's transactional guarded
	 * commit) re-verdicts the CONCATENATED batch against the fresh stored
	 * doc and commits all-or-nothing — a rejection mid-sequence can never
	 * leave a committed prefix, which is what lets every surface state "a
	 * rejected call saved nothing" with no multi-stage asterisk.
	 *
	 * Callers pass stages with non-empty `mutations`; each stage's `doc`
	 * is the blueprint AFTER that stage applied to the previous one's.
	 */
	recordMutationStages(stages: StagedMutationBatch[]): Promise<MutationEvent[]>;

	/** Persist a conversation event (assistant text/reasoning, tool
	 * call/result, user message, error). */
	recordConversation(payload: ConversationPayload): ConversationEvent;
}

/**
 * One stage of a multi-stage edit: the batch plus the doc AFTER it applied
 * to the previous stage's doc. The per-stage `stage` tag keeps the event
 * log's chapter shapes while the whole sequence gates and persists as one
 * edit (see `recordMutationStages`).
 */
export interface StagedMutationBatch {
	mutations: Mutation[];
	doc: BlueprintDoc;
	stage?: string;
}
