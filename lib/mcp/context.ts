/**
 * McpContext — request-scoped glue for MCP tool adapters.
 *
 * Mirrors `lib/agent/generationContext.ts` for the MCP surface: owns the
 * event-log writer and progress emitter so tool adapters can persist
 * mutations, record conversation artifacts, and announce progress through
 * a single API. Every MCP tool call gets its own `McpContext`; the adapter
 * constructs it after verifying ownership and stamps `source: "mcp"` on
 * every envelope that flows through it.
 *
 * Diverges from `GenerationContext` in three ways:
 *   - No Anthropic client. The MCP server does not reason; the client does.
 *   - No `UsageAccumulator`. There are no LLM tokens to bill on this surface
 *     (no SA-style step aggregation happens here).
 *   - Progress goes out as MCP `notifications/progress` events, not SSE.
 *
 * Run-id semantics: the adapter decides whether to thread a client-supplied
 * `_meta.run_id` or mint a fresh one per call. This class accepts whatever
 * runId the adapter hands it and stamps it onto every envelope, so a
 * multi-call subagent build groups coherently under one runId in the admin
 * run-summary surface when the client threads a runId consistently.
 *
 * Fail-closed persistence: `recordMutations` awaits `saveBlueprint` before
 * resolving. This is the key divergence from `GenerationContext.emitMutations`,
 * which intentionally fires the save and-forgets — the SA has retry + fix
 * discipline that can recover from a missed intermediate save. The MCP
 * surface has no agent loop to retry, so we block the tool return on the
 * Firestore write. If the write fails, the adapter's try/catch surfaces it
 * to the client as a tool error rather than returning "success" against a
 * stale on-disk blueprint.
 *
 * Phase D will retroactively declare `McpContext implements ToolExecutionContext`
 * — that interface is introduced in the same commit that adds it to the chat
 * side, so we do NOT predeclare it here.
 */

import { updateApp } from "@/lib/db/apps";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import type { LogWriter } from "@/lib/log/writer";

/**
 * Temporary local definition of `ProgressEmitter`.
 *
 * TODO(Phase C4): `lib/mcp/progress.ts` will export this interface along
 * with `createProgressEmitter`. When C4 lands, DELETE this block and
 * replace with `import type { ProgressEmitter } from "./progress";`.
 * The shape below is intentionally a subset of the C4 interface so the
 * forward-compatibility story is: C4 widens `stage` to the
 * `ProgressStage` union; callers already typed against this narrower
 * `string` shape keep compiling because `ProgressStage extends string`.
 */
export interface ProgressEmitter {
	notify(stage: string, message: string, extra?: Record<string, unknown>): void;
}

/**
 * Constructor options for `McpContext`.
 *
 * Exported alongside the class so adapters and tests can type collaborators
 * (e.g. `mockLogWriter()` in tests) without having to re-derive this shape
 * from the constructor signature.
 */
export interface McpContextOptions {
	/** Firestore app id the tool call is targeting. Already ownership-checked. */
	appId: string;
	/** Better Auth user id from the verified JWT's `sub` claim. */
	userId: string;
	/** Run id — threaded from the client via `_meta.run_id` or minted per call. */
	runId: string;
	/** Event-log sink. Always constructed with `source: "mcp"` by the adapter. */
	logWriter: LogWriter;
	/** MCP progress-notification emitter. No-op if the client didn't opt in. */
	progress: ProgressEmitter;
}

export class McpContext {
	readonly appId: string;
	readonly userId: string;
	readonly runId: string;
	readonly logWriter: LogWriter;
	readonly progress: ProgressEmitter;
	/**
	 * Per-request monotonic tiebreaker for events that share a millisecond
	 * timestamp. Reset to 0 per instance (one instance per tool call), so
	 * cross-request ordering is recovered via `ts` + doc-id at read time.
	 * `recordMutations` and `recordConversation` both allocate from this
	 * counter, so mutation and conversation envelopes interleave in the
	 * same monotonic sequence.
	 */
	private seq = 0;

	constructor(opts: McpContextOptions) {
		this.appId = opts.appId;
		this.userId = opts.userId;
		this.runId = opts.runId;
		this.logWriter = opts.logWriter;
		this.progress = opts.progress;
	}

	/**
	 * Persist a batch of mutations to the event log + Firestore blueprint.
	 *
	 * 1. Builds one `MutationEvent` envelope per mutation, inline-stamping
	 *    `source: "mcp"` so the in-memory return value is schema-valid
	 *    (the `LogWriter` re-stamps it authoritatively on its way to
	 *    Firestore — this inline value is defense-in-depth).
	 * 2. Emits each envelope to the log writer (fire-and-forget batched
	 *    Firestore write — see `LogWriter.flush` for drain semantics).
	 * 3. Awaits the blueprint save so the tool cannot return success before
	 *    Firestore acknowledges the write (fail-closed persistence
	 *    guarantee). If the save rejects, the adapter's try/catch surfaces
	 *    the failure to the client as a tool error.
	 *
	 * No-op on empty batches — callers may route an unconditional call
	 * through here without an upstream length check.
	 *
	 * @returns The envelopes that were enqueued, for callers that want to
	 *   echo them in a tool-result's `_meta` or otherwise inspect the
	 *   sequence that was just persisted.
	 */
	async recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): Promise<MutationEvent[]> {
		if (mutations.length === 0) return [];
		const events: MutationEvent[] = mutations.map((mutation) => ({
			kind: "mutation",
			runId: this.runId,
			ts: Date.now(),
			seq: this.seq++,
			actor: "agent",
			/* Inline `source: "mcp"` so the envelope satisfies the schema
			 * at the type level — `LogWriter.logEvent` overwrites this
			 * with its constructor-provided source on the way to the
			 * sink, so the persisted value can never drift. */
			source: "mcp",
			...(stage && { stage }),
			mutation,
		}));
		for (const e of events) this.logWriter.logEvent(e);
		await this.saveBlueprint(doc);
		return events;
	}

	/**
	 * Write a single conversation event to the log.
	 *
	 * Synchronous: unlike `recordMutations`, this does not touch Firestore
	 * directly — the log writer's own batched flush handles persistence,
	 * and conversation events don't carry blueprint state, so there's no
	 * intermediate save to block on.
	 *
	 * Returns the built envelope so adapters can pass it into response
	 * metadata or correlate it with downstream tool calls.
	 */
	recordConversation(payload: ConversationPayload): ConversationEvent {
		const event: ConversationEvent = {
			kind: "conversation",
			runId: this.runId,
			ts: Date.now(),
			seq: this.seq++,
			/* See `recordMutations` for why `source: "mcp"` is stamped inline
			 * even though the writer re-stamps authoritatively. */
			source: "mcp",
			payload,
		};
		this.logWriter.logEvent(event);
		return event;
	}

	/**
	 * Persist the current blueprint snapshot to Firestore.
	 *
	 * Strips `fieldParent` before writing — that field is a reverse index
	 * derived from `fieldOrder` on load (see `lib/doc/fieldParent.ts`);
	 * persisting it would bloat the doc and create a second source of
	 * truth that could drift from `fieldOrder`. Mirrors
	 * `GenerationContext.saveBlueprint`'s strip.
	 */
	private async saveBlueprint(doc: BlueprintDoc): Promise<void> {
		const { fieldParent, ...persistable } = doc;
		/* `void fieldParent` acknowledges the discard explicitly —
		 * cleaner than an underscore-prefixed ghost variable and mirrors
		 * the pattern used in `GenerationContext.saveBlueprint`. */
		void fieldParent;
		await updateApp(this.appId, persistable);
	}
}
