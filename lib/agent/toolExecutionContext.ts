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

import type { ConversionImpact } from "@/lib/case-store";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import type { AdmittedMutationStages } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CasePropertyDataType } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import type { LookupDefinitionsSnapshot } from "@/lib/lookup/types";
import type { OrganizationRevision } from "@/lib/organization/types";

/**
 * What a mutation-recording commit returns: the event envelopes it logged, plus
 * the fully-hydrated committed doc (the guarded writer's `nextDoc`). The chat SA
 * adopts `committedDoc` as its working doc so it always builds on what actually
 * landed (including a concurrent peer edit merged in); MCP does the same.
 *
 */
export interface RecordMutationsResult {
	readonly events: MutationEvent[];
	readonly committedDoc: BlueprintDoc;
}

/**
 * Read-set fences a tool may attach to one authoritative Blueprint commit.
 *
 * Most tools need only the fresh Blueprint rebase/re-verdict. A tool whose
 * success result projects an external app-scoped store can name the exact
 * snapshot revision it used, so the writer either commits at that same
 * serialization point or rejects before persistence. This avoids a fallible
 * post-commit read while preventing a successful result from describing an
 * older external snapshot.
 */
export interface RecordMutationsOptions {
	readonly expectedOrganizationRevision?: OrganizationRevision;
}

/** The impact lookup a surface injects at context construction —
 *  production passes the schema store's `conversionImpact` bound to
 *  the context's app; tests stub it. The result is the case store's
 *  own `ConversionImpact` (a type-only import — no storage code
 *  enters any graph), so a field added to the store's preview reaches
 *  every consumer or fails compile, never silently goes missing. */
export type ConversionImpactFn = (args: {
	caseType: string;
	property: string;
	toType: CasePropertyDataType;
}) => Promise<ConversionImpact>;

export interface ToolExecutionContext {
	/** Current app id. Every tool operates against one app. */
	readonly appId: string;

	/** Project scope authoritatively admitted for this tool execution. */
	readonly projectId: string;

	/** Authenticated user id. Used by tools that need to resolve
	 * user-scoped resources (e.g., KMS-encrypted HQ credentials). */
	readonly userId: string;

	/** Per-run grouping id. Stamped on every event envelope. */
	readonly runId: string;

	/**
	 * Exact rows-free Project data definitions. Production chat and MCP
	 * contexts bind this to the freshly authorized Project scope; synthetic
	 * carrier-free tests may omit it. Mutating helpers request the union of
	 * lookup identities present before and after a batch so additions, edits,
	 * and clears all receive the same external validation context.
	 */
	readonly lookupDefinitions?: (
		tableIds: readonly LookupTableId[],
	) => Promise<LookupDefinitionsSnapshot>;

	/** Complete rows-free Project data catalog for author-facing read tools. */
	readonly lookupCatalog?: () => Promise<LookupDefinitionsSnapshot>;

	/**
	 * Exact chat-run capability for authoritative non-blueprint side effects.
	 * Absent on MCP, whose request authorization is independent of the chat run
	 * window. A tool must never reconstruct this from public `runId` attribution.
	 */
	readonly chatRunHolder?: {
		readonly source: "chat";
		readonly mode: "build" | "edit";
		readonly runId: string;
		readonly nonce: string;
	};

	/**
	 * Persist a mutation batch to the durable event log and to Postgres.
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
	 */
	recordMutations(
		prepared: PreparedMutationCandidate,
		stage?: string,
		options?: RecordMutationsOptions,
	): Promise<RecordMutationsResult>;

	/**
	 * Read-and-clear the note describing saved case values the LAST
	 * commit's row migration PARKED (`parked_case_values`) — set by the
	 * saga-routed commit paths, absent otherwise. The tool wrapper
	 * appends it to the tool's success message so the model (and an
	 * MCP client) can tell the user — a park must never be invisible
	 * to the person who caused it. Safe as call-scoped state because
	 * both surfaces serialize tool execution (the chat mutex; MCP's
	 * one-call-per-request).
	 */
	consumeParkedNote?(): string | undefined;

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
	recordMutationStages(
		prepared: PreparedMutationCandidate,
		stages: AdmittedMutationStages,
	): Promise<RecordMutationsResult>;

	/** Persist a conversation event (assistant text/reasoning, tool
	 * call/result, user message, error). */
	recordConversation(payload: ConversationPayload): ConversationEvent;

	/**
	 * Preview what retyping `(caseType, property)` to `toType` would do
	 * to this app's stored case rows — the consent gate `editField`
	 * consults before a failable conversion commits. Runs the case
	 * store's own cast over the migration's own population (held cases
	 * included), so the counts a needs-confirmation result reports are
	 * the counts the migration would produce for the same data.
	 */
	conversionImpact(
		args: Parameters<ConversionImpactFn>[0],
	): Promise<ConversionImpact>;
}

/**
 * Render a committed row migration's park outcome as the note the tool wrapper
 * appends to its success message (see `consumeParkedNote`). Typed
 * structurally so this leaf imports no storage implementation.
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
 * edit (see `recordMutationStages`).
 */
export interface StagedMutationBatch {
	readonly mutations: Mutation[];
	readonly stage: string;
}
