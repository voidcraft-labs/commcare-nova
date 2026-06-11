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
 * Run-id semantics: the adapter derives a runId from app-doc state (see
 * `lib/mcp/runId.ts`) and hands it to this class. Every event-log envelope
 * carries the runId, so subsequent mutations within the sliding-window
 * group under the same id on admin surfaces.
 *
 * Fail-closed persistence: `recordMutations` awaits `saveBlueprint` before
 * resolving. This is the key divergence from `GenerationContext.emitMutations`,
 * which intentionally fires the save and-forgets — the SA has retry + fix
 * discipline that can recover from a missed intermediate save. The MCP
 * surface has no agent loop to retry, so we block the tool return on the
 * Firestore write. If the Firestore save rejects, `recordMutations`
 * propagates the rejection to its caller. This class does not swallow
 * persistence errors — callers are responsible for mapping them to their
 * surface's error shape.
 *
 * The event log writer is fire-and-forget: `logWriter.logEvent(event)` queues
 * events but does not await persistence. Callers MUST `await logWriter.flush()`
 * in a `finally` block before returning from the MCP tool handler — otherwise
 * conversation events and mutation event log entries may be lost when the
 * request terminates. The blueprint save (via `recordMutations`) is awaited;
 * the event log is not.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
	StagedMutationBatch,
	ToolExecutionContext,
} from "@/lib/agent/toolExecutionContext";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import { LogWriter } from "@/lib/log/writer";
import { createProgressEmitter, type ProgressEmitter } from "./progress";
import type { ToolContext } from "./types";

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
	/** Run id — derived by the adapter from the app doc's current state. */
	runId: string;
	/** Event-log sink. Always constructed with `source: "mcp"` by the adapter. */
	logWriter: LogWriter;
	/** MCP progress-notification emitter. No-op if the client didn't opt in. */
	progress: ProgressEmitter;
}

export class McpContext implements ToolExecutionContext {
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
	 *    guarantee). If the Firestore save rejects, `recordMutations`
	 *    propagates the rejection to its caller. This class does not
	 *    swallow persistence errors — callers are responsible for mapping
	 *    them to their surface's error shape.
	 *
	 * No-op on empty batches — callers may route an unconditional call
	 * through here without an upstream length check.
	 *
	 * @returns The envelopes that were enqueued, for callers that want
	 *   to inspect the sequence that was just persisted.
	 */
	async recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): Promise<MutationEvent[]> {
		if (mutations.length === 0) return [];
		/* Persist FIRST, log second: the guarded transactional commit can
		 * still reject (or throw on a transport fault), and an event log
		 * that recorded a batch the blueprint never absorbed would make a
		 * replay diverge from the persisted doc. */
		await this.saveBlueprint(doc, mutations);
		const events = this.buildEnvelopes(mutations, stage);
		for (const e of events) this.logWriter.logEvent(e);
		return events;
	}

	/**
	 * Persist a multi-stage sequence as ONE transactional guarded save.
	 *
	 * The whole point of this method on the MCP surface: the guarded
	 * commit re-applies the batch to the FRESH stored blueprint and
	 * re-runs the validity verdict inside the Firestore transaction, and
	 * that re-verdict must see the SAME candidate the optimistic gate
	 * approved — the concatenated sequence, once. Saving stage-by-stage
	 * would instead run an independent transaction per stage, so a
	 * mid-sequence rejection (a concurrent commit landing between
	 * transactions) would leave the earlier stages PERSISTED while the
	 * tool reports "nothing was saved" — and an intermediate-state finding
	 * a later stage resolves would reject at a per-stage re-verdict even
	 * though the whole edit is valid. One save, one re-verdict, zero
	 * committed prefix on any rejection.
	 *
	 * The persisted snapshot is the final stage's doc; the event-log
	 * envelopes keep each stage's own tag. Same persist-first/log-second
	 * ordering as `recordMutations`.
	 */
	async recordMutationStages(
		stages: StagedMutationBatch[],
	): Promise<MutationEvent[]> {
		const nonEmpty = stages.filter((s) => s.mutations.length > 0);
		if (nonEmpty.length === 0) return [];
		const finalDoc = nonEmpty[nonEmpty.length - 1].doc;
		const allMutations = nonEmpty.flatMap((s) => s.mutations);
		await this.saveBlueprint(finalDoc, allMutations);
		const events = nonEmpty.flatMap((s) =>
			this.buildEnvelopes(s.mutations, s.stage),
		);
		for (const e of events) this.logWriter.logEvent(e);
		return events;
	}

	/** Build the `MutationEvent` envelopes for one batch under one stage
	 *  tag, allocating from the per-request `seq` counter. */
	private buildEnvelopes(
		mutations: Mutation[],
		stage?: string,
	): MutationEvent[] {
		return mutations.map((mutation) => ({
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
			...(stage !== undefined && { stage }),
			mutation,
		}));
	}

	/**
	 * Write a single conversation event to the log.
	 *
	 * Synchronous: unlike `recordMutations`, this does not touch Firestore
	 * directly — the log writer's own batched flush handles persistence,
	 * and conversation events don't carry blueprint state, so there's no
	 * intermediate save to block on.
	 *
	 * Writes to the event log are fire-and-forget. The caller's `finally`
	 * block is responsible for awaiting `logWriter.flush()` before returning.
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
	 * Persist the blueprint snapshot to Firestore along with the current
	 * run id. `toPersistableDoc` strips the derived `fieldParent` index;
	 * see the class-level fail-closed contract for why this is awaited.
	 *
	 * Routes through the cross-store saga so a property-surface
	 * mutation in this MCP tool call (rename / retype / option add)
	 * syncs the Postgres `case_type_schemas` row before Firestore
	 * commits. Pure non-case-type edits fast-path through the saga
	 * without touching the case store. See
	 * `lib/db/applyBlueprintChange.ts` for the compensation contract.
	 *
	 * Writing `run_id` on every mutation is load-bearing for the
	 * sliding-window derivation in `lib/mcp/runId.ts` — the next MCP
	 * tool call reads `app.run_id` + `app.updated_at` to decide whether
	 * to continue this run or start a new one. The saga's `runId`
	 * argument routes the Firestore commit through `updateAppForRun`
	 * so the run id persists alongside the blueprint.
	 */
	private async saveBlueprint(
		doc: BlueprintDoc,
		mutations: Mutation[],
	): Promise<void> {
		await applyBlueprintChange({
			appId: this.appId,
			userId: this.userId,
			prospective: toPersistableDoc(doc),
			runId: this.runId,
			/* Guarded commit: the saga's Firestore write re-reads the stored
			 * blueprint, re-applies this batch, and re-runs the validity
			 * verdict inside a transaction — two concurrent gate-approved
			 * batches serialize instead of last-writer-wins, and a batch the
			 * fresh doc rejects throws (the tool returns its `{ error }`
			 * envelope) rather than erasing the concurrent commit. */
			guard: { mutations },
		});
	}
}

/**
 * Bundle of the four per-call collaborators every MCP tool handler
 * allocates the same way: an `McpContext`, its underlying `LogWriter`,
 * the resolved `runId`, and a `ProgressEmitter` bound to the client's
 * optional `progressToken`. Returned as a single record so each
 * handler's collaborator wiring is one function call rather than a
 * five-line preamble.
 */
export interface InitMcpCallResult {
	mcpCtx: McpContext;
	logWriter: LogWriter;
	runId: string;
	progress: ProgressEmitter;
}

/**
 * Narrow shape the adapter consumes from the SDK's `RequestHandlerExtra`.
 *
 * The MCP SDK's `_meta` is `Record<string, unknown>` post-validation, but
 * `progressToken` is the only field we read. RFC 6802 (MCP progress) types
 * it as `string | number`. Declaring the shape locally keeps the import
 * surface small and removes the `as` cast at the read site without forcing
 * a deep import of the SDK's `RequestMeta` schema.
 */
interface McpCallExtra {
	_meta?: {
		progressToken?: string | number;
	};
}

/**
 * Build the per-call collaborators for an MCP tool handler.
 *
 * Takes `runId` as an input rather than minting it internally: every
 * handler resolves `runId` at the top (via `resolveRunId`) so it's in
 * scope for the outer `catch` block's `toMcpErrorResult(err, { appId,
 * runId })` envelope — which has to fire even when a failure predates
 * the per-call collaborator allocation.
 *
 * The `LogWriter` is stamped `"mcp"` so every event lands with the
 * authoritative source tag; the emitter no-ops when the client did
 * not supply a `progressToken`.
 *
 * @see `sharedToolAdapter.ts` and `uploadAppToHq.ts` for the canonical
 *   usage pattern — call with the pre-resolved `runId`, then wrap the
 *   tool's work in a `try`/`finally` that awaits `logWriter.flush()`.
 */
export function initMcpCall(
	server: McpServer,
	ctx: ToolContext,
	appId: string,
	runId: string,
	extra: McpCallExtra | undefined,
): InitMcpCallResult {
	const progressToken = extra?._meta?.progressToken;
	const logWriter = new LogWriter(appId, "mcp");
	const progress = createProgressEmitter(server, progressToken);
	const mcpCtx = new McpContext({
		appId,
		userId: ctx.userId,
		runId,
		logWriter,
		progress,
	});
	return { mcpCtx, logWriter, runId, progress };
}
