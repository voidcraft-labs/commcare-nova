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
 * Render a committed row migration's park outcome as the note the surface
 * wrapper appends to its success message (a park must never be invisible to
 * the person who caused it). Typed structurally so this leaf imports no
 * storage implementation.
 */
export function describeParkedOutcome(outcome: {
	readonly parked: number;
	readonly failureReasons: readonly string[];
}): string {
	const detail = outcome.failureReasons.slice(0, 3).join("; ");
	const more =
		outcome.failureReasons.length > 3
			? ` (and ${outcome.failureReasons.length - 3} more)`
			: "";
	return (
		`Data note: ${outcome.parked} saved case value${outcome.parked === 1 ? "" : "s"} ` +
		`could not convert to the new type, so Nova kept ${outcome.parked === 1 ? "it" : "them"} for review — ` +
		`the cases themselves are intact, and the values can be reviewed and put back ` +
		`under Case data in the builder. ${detail}${more}`
	);
}

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
