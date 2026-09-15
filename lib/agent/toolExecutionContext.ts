/**
 * Host-side persistence vocabulary shared by the two canonical mutation
 * hosts:
 *
 *   - GenerationContext (lib/agent/generationContext.ts) — chat surface.
 *   - McpContext (lib/mcp/context.ts) — MCP surface.
 *
 * Tool bodies no longer see these types: a shared tool executes against
 * `ToolInvocationContext` (lib/agent/workspace/types.ts), whose `applyBatch`
 * / `applyStages` are implemented by the workspace over the host's
 * `recordMutations` / `recordMutationStages`. The persistence methods are
 * deliberately unreachable from tool code — the workspace owns the document,
 * the gate, and the one-write-per-invocation budget.
 */

import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { MutationEvent } from "@/lib/log/types";
import type { MutationApplicationPolicy } from "./workspace/types";

export type { ConversionImpactFn } from "./workspace/types";

/**
 * What a mutation-recording commit returns: the event envelopes it logged,
 * the fully-hydrated committed doc (the guarded writer's `nextDoc`), and the
 * canonical sequence the batch committed at. The workspace adopts
 * `committedDoc` as its current document so every later invocation builds on
 * what actually landed (including a concurrent peer edit merged in).
 */
export interface RecordMutationsResult {
	readonly events: MutationEvent[];
	readonly committedDoc: BlueprintDoc;
	/** The `mutation_seq` the batch committed at. Absent only on a no-op
	 * (empty batch) result, which commits nothing. */
	readonly seq?: number;
}

/**
 * The commit-time policy a host's `recordMutations` receives — exactly the
 * tool-facing {@link MutationApplicationPolicy}, carried through the
 * workspace unchanged (one definition, two vocabulary homes).
 */
export type RecordMutationsOptions = MutationApplicationPolicy;

/**
 * One stage of a multi-stage edit: the batch plus the doc AFTER it applied
 * to the previous stage's doc. The per-stage `stage` tag keeps the event
 * log's chapter shapes while the whole sequence gates and persists as one
 * edit (see `ToolInvocationContext.applyStages`).
 */
export interface StagedMutationBatch {
	readonly mutations: Mutation[];
	readonly stage: string;
}
