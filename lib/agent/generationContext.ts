/**
 * GenerationContext — shared abstraction for all LLM calls and generation state.
 *
 * Owns the fan-out from a single agent run to every write surface the server
 * produces during generation:
 *
 *  - **SSE (`UIMessageStreamWriter`)** — live wire to the interactive builder.
 *    `emit()` is a pure pass-through for lifecycle/error events (`data-phase`,
 *    `data-fix-attempt`, `data-error`, `data-done`, …). Doc-mutating events
 *    go through `commitBatch`, which commits the batch through the unified
 *    guarded writer and only THEN owns the SSE payload + matching event-log
 *    writes.
 *  - **Event log (`LogWriter`)** — Postgres-backed append-only event stream.
 *    `commitBatch` writes one `MutationEvent` per mutation; `emitConversation`
 *    writes one `ConversationEvent` per assistant/tool/user artifact. The log
 *    powers admin inspection and future replay. It is strictly supplemental —
 *    the blueprint snapshot on `AppDoc` is still authoritative.
 *  - **Usage (`UsageAccumulator`)** — per-request token + cost aggregation
 *    flushed once at request end. Outer agent steps carry `{ step: true }`;
 *    sub-gens (internal `generate` / `streamGenerate` /
 *    `extractDocumentStructured` calls) accumulate tokens without stepping
 *    the counter.
 *
 * Implements `CanonicalMutationHost` — the persistence seam the canonical
 * Tool Workspace executes shared tools over. `recordMutations` /
 * `recordMutationStages` are the host entry points; `commitBatch` (the
 * guarded commit + SSE fan-out) and `emitConversation` are the chat-surface
 * implementations they delegate to. Tool bodies never see this class: they
 * run against `ToolInvocationContext` (lib/agent/workspace/types.ts).
 *
 * Sub-generation prompts/outputs (from `generate`, `streamGenerate`,
 * `extractDocumentStructured`) are intentionally NOT persisted in the event log — only
 * aggregate token usage. The log is supplemental and does not carry
 * per-tool payloads. Admin inspection surfaces should rely on per-run
 * summary docs and on agent-step-granularity conversation events.
 *
 * The context owns nothing stateful beyond a monotonic `seq` counter used to
 * preserve chronological order inside a single millisecond (multiple events
 * in one SSE burst share `ts`).
 */

import type { OpenAIProvider } from "@ai-sdk/openai";
import type {
	CallWarning,
	FinishReason,
	LanguageModelUsage,
	StepResultPerformance,
	UIMessageStreamWriter,
} from "ai";
import { generateText, Output, streamText } from "ai";
import type { z } from "zod";
import type { Session } from "@/lib/auth";
import { classifyError as classifyValidityError } from "@/lib/commcare/validator/gate";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	AppAccessError,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import {
	type ChatRunHolderCapability,
	commitGuardedBatch,
	refreshBuildLiveness,
	refreshEditLease,
} from "@/lib/db/apps";
import {
	AppProjectChangedError,
	CommitReauthError,
	type MutationBatchIdCollisionError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { MAX_RUN_MINUTES } from "@/lib/db/constants";
import type { GenerationTarget } from "@/lib/db/generationTargets";
import type { DesignBuildCostPhase } from "@/lib/db/usage";
import { pricingTierForInput, type UsageAccumulator } from "@/lib/db/usage";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	type AdmittedMutationStages,
	admittedMutationSlice,
	encodeAdmittedMutationEnvelope,
} from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import type {
	ClassifiedErrorPayload,
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import type { LogWriter } from "@/lib/log/writer";
import { log } from "@/lib/logger";
import {
	MODEL_DEFAULT,
	OPENAI_BASE_OPTIONS,
	type ReasoningEffort,
	reasoningProviderOptions,
} from "@/lib/models";
import type {
	ExtractDocumentStructuredOpts,
	StructuredExtractResult,
} from "./documentExtraction";
import { type ClassifiedError, classifyError } from "./errorClassifier";
import {
	readToolLookupCatalog,
	readToolLookupDefinitions,
} from "./lookupContext";
import {
	meterSubGenerationUsage,
	runStructuredWith,
	type StructuredModelRunArgs,
	type StructuredModelRunContext,
} from "./modelRunContext";
import { createNovaOpenAI } from "./openaiProvider";
import {
	type SubGenerationObjectResult,
	streamObjectWith,
} from "./subGeneration";
import type {
	ConversionImpactFn,
	RecordMutationsOptions,
	RecordMutationsResult,
} from "./toolExecutionContext";
import { describeParkedOutcome } from "./toolExecutionContext";
import type { CanonicalMutationHost } from "./workspace/canonicalHost";

/**
 * Debounce for the per-step run-lease heartbeat — a live run refreshes its
 * liveness horizon at most this often (a third of the edit lease), so many fast
 * agent steps write a few times per lease rather than once per step, while
 * keeping the horizon comfortably fresh: ~5 min against an edit's 15-min
 * `run_lock` lease AND against a build's 10-min `updated_at` staleness window.
 */
const LEASE_HEARTBEAT_INTERVAL_MS = (MAX_RUN_MINUTES / 3) * 60_000;

/** Log AI SDK warnings to the console if present. */
export function logWarnings(
	label: string,
	warnings: CallWarning[] | undefined,
) {
	if (warnings?.length) {
		for (const w of warnings) {
			console.warn(`[${label}] warning:`, w);
		}
	}
}

/**
 * Constructor options. Two orthogonal collaborators: `LogWriter` owns
 * durable event persistence (fire-and-forget); `UsageAccumulator` owns
 * cost aggregation and exposes the `runId` used on every event envelope.
 *
 * `appId` is required — the chat route creates the app doc via `createApp`
 * before constructing the context (Postgres-down = 503, not an orphaned
 * build). Every `GenerationContext` has a target app because each tool batch
 * commits inline through the guarded writer. The batch-exclusive
 * `renameCaseProperties` command additionally composes its case-schema and
 * row movement into that same physical transaction.
 */
interface GenerationContextOptions {
	/** Server-shared OpenAI API key (resolved by `resolveOpenAIKey`) —
	 * the one credential behind every model this context resolves. */
	apiKey: string;
	/** SSE writer for the live builder. Unchanged wire format. */
	writer: UIMessageStreamWriter;
	/** Event log sink — batched Postgres writer, one row per event. */
	logWriter: LogWriter;
	/** Cost + step/tool-call counter for per-run summary + monthly cap. */
	usage: UsageAccumulator;
	/** Authenticated user session — always present (all users are authenticated). */
	session: Session;
	/** App id. The chat route creates the app doc before this
	 * constructor runs so every context has a valid target app. */
	appId: string;
	/** Project captured with the run's authoritative app admission. */
	projectId: string;
	/** Fresh Better Auth Project role captured by that same admission. */
	projectRole?: string;
	/** Server-minted generation of this exact build/edit claim. */
	holderNonce: string;
	/**
	 * True when this run holds an EDIT `run_lock` (an edit-mode run: a chargeable
	 * edit that claimed, or an edit resume) — it selects WHICH horizon the
	 * per-step + wall-clock heartbeats refresh: the edit `run_lock` lease
	 * (`refreshEditLease`), or, when `false`, a BUILD's `updated_at` staleness
	 * clock (`refreshBuildLiveness`) — so neither mode's live run lapses and is
	 * reaped mid-run during a long no-commit stretch.
	 */
	editLease: boolean;
	/** The retype-impact lookup behind `ToolInvocationContext.conversionImpact`
	 * — the route binds the schema store's `conversionImpact` to this app;
	 * tests stub it so no tool test touches Postgres. */
	conversionImpact: ConversionImpactFn;
}

/**
 * One completed agent step, normalized to the minimum surface the step
 * handler needs. Callers (the SA's `onStepEnd`, tests) map the AI SDK's
 * step-finish argument into this shape so `handleAgentStep` stays stable
 * across SDK minor-version bumps.
 */
export interface AgentStep {
	usage?: LanguageModelUsage;
	text?: string;
	reasoningText?: string;
	toolCalls?: Array<{
		toolCallId: string;
		toolName: string;
		input: unknown;
	}>;
	toolResults?: Array<{
		toolCallId: string;
		output: unknown;
	}>;
	/**
	 * Tool calls that FAILED rather than returned a result — invalid input
	 * rejected before `execute` runs, or an execution throw. The AI SDK
	 * surfaces these as `tool-error` content parts, kept out of
	 * `toolResults`; the caller pulls them from `step.content`. Captured so
	 * a failed call leaves a paired error in the log instead of a bare,
	 * resultless tool-call (the gap that made the omit-then-retry diagnosis
	 * require inference). `toolName` is omitted — it's recovered from the
	 * matching `toolCalls` entry, same as `toolResults`.
	 */
	toolErrors?: Array<{
		toolCallId: string;
		error: unknown;
	}>;
	warnings?: CallWarning[];
	finishReason?: FinishReason;
	rawFinishReason?: string;
	performance?: StepResultPerformance;
	/** Private protocols keep raw tool inputs/results out of the supplemental
	 * event log while retaining usage, tool counts, and pause detection. */
	toolEventMode?: "full" | "metadata-only";
}

export class GenerationContext
	implements CanonicalMutationHost, StructuredModelRunContext
{
	/** The OpenAI provider — the ONE model resolver for every LLM call this
	 *  context issues (the SA, the document summarizer, structured sub-gens).
	 *  Resolves to the Responses API model for each id. */
	private openai: OpenAIProvider;
	readonly writer: UIMessageStreamWriter;
	readonly logWriter: LogWriter;
	readonly usage: UsageAccumulator;
	/** Authenticated user session. */
	readonly session: Session;
	/** App id — required. Created before construction by the
	 * chat route so every context has a valid persistence target. */
	readonly appId: string;
	readonly projectId: string;
	readonly projectRole: string;
	private _holderNonce: string;
	/**
	 * Per-request tiebreaker for same-millisecond SSE bursts. Resets to 0
	 * each request; event row ids are Postgres-assigned, so no cross-request
	 * uniqueness is needed.
	 */
	private seq = 0;
	/** The latest COMMITTED doc — the guarded writer's `result.committedDoc`,
	 * which may carry a peer's concurrent edit merged in (the SA continues
	 * against it). Read by the route's drain-end finalize (`latestPersistedDoc`)
	 * for `data-done` + the case-store sync, and by `warnIfEditRunIncomplete`.
	 * Absent until the first mutation batch commits (a read-only turn). */
	private _latestDoc: BlueprintDoc | undefined;
	/* Flipped true when the SA emits an `askQuestions` tool-call — the client-side
	 * tool with no `execute` that HALTS the agent loop to await the user's answer.
	 * The chat route reads this after the drain to mark the app `awaiting_input`,
	 * so the refunding reaper doesn't mistake a live build paused on a question for
	 * a hard-killed one and refund its still-live hold. */
	private _pausedOnInput = false;
	/** The `mutation_seq` the run's most recent batch committed at — the head
	 * of the durable `appChanges` stream. The route stamps it on
	 * `data-done` so a reconnecting client knows the run's terminal cursor.
	 * Absent until the first mutation batch lands. */
	private _latestSeq: number | undefined;
	/** Set when an authoritative commit or conflict-reload check produced
	 * `CommitReauthError` — the actor lost edit access mid-run. Load-bearing for
	 * finalization: a tool `execute()` throw becomes a NON-fatal AI-SDK chunk,
	 * so the route can't key run failure on it; it reads this flag after the
	 * drain and routes the run through `failRun` (refund, never keep the charge)
	 * instead. TERMINAL — a reload can't restore access, so it's never cleared
	 * within a run. */
	private _reauthError: CommitReauthError | undefined;
	/** A guarded write or authorized conflict reload observed a Project different
	 * from this run's admitted scope. Terminal for this run even when the actor
	 * belongs to both Projects: every later write would reject until the caller
	 * reloads authoritatively. */
	private _projectChangedError: AppProjectChangedError | undefined;
	/** The exact chat holder disappeared or changed while this run was active.
	 * Terminal and replacement-safe: the route refunds/logs this run without
	 * settling, releasing, failing, or otherwise touching the successor. */
	private _holderLostError: RunHolderLostError | undefined;
	/** A server-minted batch id was reused for different content. That is Nova's
	 * own protocol failure, never something the model did or can fix, so the run
	 * ends rather than handing back an error the model reads as retryable and
	 * answers by reminting the id. Terminal and never cleared within a run. */
	private _batchIdCollisionError: MutationBatchIdCollisionError | undefined;
	private _parkedNote: string | undefined;
	/** Which liveness horizon the heartbeats refresh: an edit `run_lock` lease,
	 * or (false) a build's `updated_at` staleness clock.
	 * See {@link GenerationContextOptions.editLease}. Mutable through
	 * {@link setRunMode} alone: the serialize-with-wait path constructs the
	 * context before its claim wins, and a stale-mode rejection there adopts
	 * the locked row's mode after construction. */
	private editLease: boolean;
	/** Epoch-ms of the last run-lease heartbeat, for debounce — the per-step
	 * refresh and the wall-clock timer share it, so a run with many fast steps
	 * (or a step landing right after a timer tick) writes a few times per lease,
	 * not on every signal. */
	private lastLeaseRefreshMs = 0;
	/** The wall-clock lease-heartbeat interval handle. Guarantees a run doing a
	 * single long model turn with NO intermediate step-finish still refreshes its
	 * horizon (the step-fired refresh alone can't cover a no-step stretch).
	 * Started by `startRunLeaseHeartbeat`, cleared by `stopRunLeaseHeartbeat` in
	 * the route's finalize — an uncleared interval is an async leak. */
	private leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

	constructor(opts: GenerationContextOptions) {
		this.openai = createNovaOpenAI(opts.apiKey);
		this.writer = opts.writer;
		this.logWriter = opts.logWriter;
		this.usage = opts.usage;
		this.session = opts.session;
		this.appId = opts.appId;
		this.projectId = opts.projectId;
		this.projectRole = opts.projectRole ?? "viewer";
		this._holderNonce = opts.holderNonce;
		this.editLease = opts.editLease;
		this.conversionImpact = opts.conversionImpact;
	}

	readonly lookupDefinitions: NonNullable<
		CanonicalMutationHost["lookupDefinitions"]
	> = (tableIds) =>
		readToolLookupDefinitions(
			{
				projectId: this.projectId,
				actorId: this.userId,
				role: this.projectRole,
			},
			tableIds,
		);

	readonly lookupCatalog: NonNullable<CanonicalMutationHost["lookupCatalog"]> =
		() =>
			readToolLookupCatalog({
				projectId: this.projectId,
				actorId: this.userId,
				role: this.projectRole,
			});

	/** See {@link CanonicalMutationHost.conversionImpact} — injected at
	 * construction (`GenerationContextOptions.conversionImpact`). */
	readonly conversionImpact: ConversionImpactFn;

	/**
	 * The canonical workspace's conflict recovery — one atomic authorized
	 * snapshot after a `BlueprintCommitRejectedError`, so the run continues
	 * from current server state rather than its stale document. Terminal
	 * scope failures are LATCHED before they throw: lost edit access becomes
	 * `CommitReauthError` (a reload can't restore authorization) and a
	 * Project that no longer matches the run's admitted scope becomes
	 * `AppProjectChangedError` (the reload must not cross the tenant
	 * boundary) — both fence every queued tool and fail the run.
	 */
	async reloadAuthorizedSnapshot(): Promise<{
		doc: BlueprintDoc;
		canonicalSeq: number;
	}> {
		let fresh: Awaited<ReturnType<typeof resolveAuthorizedAppSnapshot>>;
		try {
			fresh = await resolveAuthorizedAppSnapshot(
				this.appId,
				this.userId,
				"edit",
			);
		} catch (reloadError) {
			if (reloadError instanceof AppAccessError) {
				const scopeError = new CommitReauthError(
					"You no longer have edit access.",
				);
				this.latchTerminalScopeError(scopeError);
				throw scopeError;
			}
			throw reloadError;
		}
		if (fresh.projectId !== this.projectId) {
			const scopeError = new AppProjectChangedError();
			this.latchTerminalScopeError(scopeError);
			throw scopeError;
		}
		return {
			doc: hydratePersistedBlueprint(fresh.app.blueprint as PersistableDoc),
			canonicalSeq: fresh.baseSeq,
		};
	}

	/** Resolve an OpenAI model id to a `LanguageModel` (Responses API).
	 *  One credential serves every model, so the SA and the document
	 *  summarizer resolve identically. */
	model(id: string) {
		return this.openai(id);
	}

	/** StructuredModelRunContext accessor — this run's billing/persistence
	 *  scope. An app-bound context always targets its app. */
	get target(): GenerationTarget {
		return { kind: "app", appId: this.appId };
	}

	/**
	 * StructuredModelRunContext implementation — the shared cancellation-aware
	 * structured call (`modelRunContext.ts::runStructuredWith`), metered like
	 * every other sub-generation. The design pipeline uses this seam so an
	 * app-bound edit run and a pre-app design session run the exact same
	 * provider path.
	 */
	async runStructured<T>(
		args: StructuredModelRunArgs<T>,
	): Promise<SubGenerationObjectResult<T>> {
		return runStructuredWith(this.model(args.modelId), args, (usage) =>
			this.trackSubGeneration(usage, args.modelId),
		);
	}

	/**
	 * CanonicalMutationHost accessor — the authenticated Better Auth user
	 * id. Exposed so shared tool bodies can look up user-scoped resources
	 * (e.g. KMS-encrypted HQ credentials) through the interface without
	 * dipping into the concrete class.
	 */
	get userId(): string {
		return this.session.user.id;
	}

	/**
	 * CanonicalMutationHost accessor — the per-run grouping id, sourced
	 * from the `UsageAccumulator` so the run-id stamped on every event
	 * envelope stays consistent with the run-summary doc.
	 */
	get runId(): string {
		return this.usage.runId;
	}

	/** Replace the provisional resume nonce with the app-locked capability
	 * returned by `reacquireLease`. Chargeable runs mint their own and never
	 * need this; a continuation carries only an unproven client value until the
	 * locked resume settles it, so the authoritative one must land here before
	 * any SA tool or heartbeat receives authority. */
	setReacquiredHolderNonce(holderNonce: string): void {
		this._holderNonce = holderNonce;
	}

	/** Adopt the run's authoritative build-vs-edit mode — the serialize-wait
	 * seam parallel to {@link setReacquiredHolderNonce}. The context is built
	 * with the pre-wait derivation, but a `ClaimModeStaleError` retry can win
	 * the claim under the OTHER mode; everything mode-keyed in here — the
	 * `chatRunHolder` capability every commit presents (`(mode, runId, nonce)`
	 * identity: a wrong mode is `RunHolderLostError` on the first batch) and
	 * the lease-heartbeat refresher — must follow the mode the claim actually
	 * booked, so the route calls this the moment its wait-path claim wins. */
	setRunMode(mode: "build" | "edit"): void {
		this.editLease = mode === "edit";
	}

	/** Current exact holder generation. */
	get holderNonce(): string {
		return this._holderNonce;
	}

	/** Chat-only holder capability exposed to shared tools that perform an
	 * authoritative side effect outside the BlueprintDoc transaction. */
	get chatRunHolder(): ChatRunHolderCapability {
		return {
			source: "chat",
			mode: this.editLease ? "edit" : "build",
			runId: this.runId,
			nonce: this._holderNonce,
		};
	}

	/**
	 * Write a `ConversationEvent` to both the event log and the SSE stream.
	 *
	 * The log write is the durable debug artifact (and replay source). The
	 * SSE emission carries the same envelope to the live client so the
	 * session store's event buffer mirrors the persisted log in real time —
	 * every lifecycle derivation (stage, error, status message, validation
	 * attempt) reads from that buffer, so live + replay end up driving the
	 * UI from the same data.
	 *
	 * Returns the built envelope so callers can hand it to downstream
	 * metadata surfaces without rebuilding it — mirrors
	 * `McpContext.recordConversation` so a shared tool body can treat
	 * both implementations identically.
	 */
	emitConversation(payload: ConversationPayload): ConversationEvent {
		const event: ConversationEvent = {
			kind: "conversation",
			runId: this.usage.runId,
			ts: Date.now(),
			seq: this.seq++,
			/* `source: "chat"` is stamped inline so the in-memory event we
			 * hold is schema-valid and self-documenting. The writer re-stamps
			 * it authoritatively on its way to Postgres (see LogWriter), so
			 * this is defense-in-depth, not the canonical value. */
			source: "chat",
			payload,
		};
		this.logWriter.logEvent(event);
		this.writer.write({
			type: "data-conversation-event",
			data: event,
			transient: true,
		});
		return event;
	}

	/**
	 * Emit a transient data part to the live SSE stream. Pure pass-through.
	 *
	 * Used for one-shot lifecycle signals that live outside the
	 * `data-mutations` / `data-conversation-event` streams:
	 *
	 *   - `data-done` — the route's drain-end build-finished signal,
	 *     carrying the final doc snapshot for client reconciliation.
	 *   - `data-blueprint-updated` — edit-mode coarse-tool replacements.
	 *   - `data-app-materialized` — the one-shot genesis receipt that installs
	 *     the exact blueprint/cursor before driving the `/build/new` →
	 *     `/build/{id}` URL swap and multiplayer activation.
	 *   - `data-run-id` — server-minted run identifier the client echoes
	 *     back on follow-up requests.
	 *
	 * Other signposts (start-build, phase, fix-attempt, error) are derived
	 * client-side from the mutation + conversation event streams rather
	 * than emitted here.
	 */
	emit(type: `data-${string}`, data: unknown): void {
		this.writer.write({ type, data, transient: true });
	}

	/**
	 * Emit a classified error as a conversation event. The single
	 * `emitConversation` call handles both the event log write AND the
	 * SSE emission (via `data-conversation-event`), so the client sees
	 * the error in its buffer and derivations pick it up without a
	 * separate `data-error` side channel.
	 *
	 * Wrapped in try/catch because the writer can be broken by the same
	 * failure that triggered the classification; the event log carries
	 * the error either way, so a broken SSE writer is not fatal for
	 * admin observability.
	 *
	 * Logs the underlying cause server-side BEFORE emitting. The
	 * conversation event + event log only carry the user-safe `message`
	 * (`classifiedErrorPayloadSchema` drops `raw` deliberately — the log
	 * is not a stack-trace surface), so without this an `internal`
	 * classification reaches the operator as a bare "Something went wrong
	 * during generation." with no way to see what actually threw.
	 * `internal` (an unexpected failure worth a report) logs at `error`;
	 * the known external conditions (rate limit, auth, overload, …) log at
	 * `warn` so they don't flood Error Reporting with expected states.
	 */
	emitError(
		error: ClassifiedError,
		context?: string,
		opts?: { runContinues?: boolean },
	): void {
		const cause = {
			raw: error.raw ?? "",
			context: context ?? "",
			recoverable: error.recoverable,
		};
		if (error.type === "internal") {
			log.error(
				`[generation] internal error: ${error.message}`,
				undefined,
				cause,
			);
		} else {
			log.warn(`[generation] ${error.type}: ${error.message}`, cause);
		}
		const payload: ClassifiedErrorPayload = {
			type: error.type,
			message: error.message,
			fatal: !error.recoverable,
			...(opts?.runContinues === true && { runContinues: true }),
		};
		try {
			this.emitConversation({ type: "error", error: payload });
		} catch {
			log.error(
				"[emitError] conversation event emission failed — error may not reach the log",
				undefined,
				{ errorMessage: error.message, context: context ?? "" },
			);
		}
	}

	/**
	 * Build the `MutationEvent` envelopes for one batch — PURE: it allocates
	 * from the per-request `seq` counter and returns the array, writing nothing
	 * (no commit, no SSE, no log). `commitBatch` owns the side effects: it
	 * commits the batch through the guarded writer, then emits ONE
	 * `data-mutations` SSE event carrying the raw `mutations` (for
	 * `docStore.applyMany`, one history entry) alongside these
	 * envelopes, and logs one `MutationEvent` per mutation.
	 *
	 * The optional `stage` string is a semantic tag for the log
	 * (`"scaffold"`, `"module:0"`, `"form:0-1"`, `"convert:0-0"`). It's
	 * stamped on every envelope — both log and SSE see the same tag, so
	 * lifecycle derivations over the client buffer match replay derivations
	 * over the persisted log.
	 */
	private buildEnvelopes(
		mutations: AdmittedMutationBatch,
		stage?: string,
	): MutationEvent[] {
		return mutations.map(
			(mutation) =>
				encodeAdmittedMutationEnvelope({
					kind: "mutation",
					runId: this.usage.runId,
					ts: Date.now(),
					seq: this.seq++,
					actor: "agent",
					/* Inline `source: "chat"` so the SSE envelope is schema-valid;
					 * `LogWriter` re-stamps it authoritatively on the way to Postgres. */
					source: "chat",
					/* Include `stage` whenever the caller explicitly passed a value —
					 * empty-string is a valid stage. */
					...(stage !== undefined && { stage }),
					mutation,
				}).value as unknown as MutationEvent,
		);
	}

	/**
	 * Commit one batch through the unified guarded writer (the explicit rename
	 * command composes its case-row movement into that transaction), then —
	 * AFTER the commit resolves — emit the `data-mutations` SSE
	 * event and log the envelopes. Awaited-inline: the SA's `serial()`
	 * mutex serializes tool
	 * bodies, so the commit that lands here always builds on the previous one's
	 * committed doc, and `consumeStream()` resolving implies every commit
	 * settled. A rejection (`commitGuardedBatch` throws) propagates BEFORE
	 * anything is emitted, so the client never sees a batch the doc didn't
	 * absorb. The `data-mutations` payload carries the committed `seq` +
	 * `batchId` so the client reconciler can dedup its own echoes + advance its
	 * cursor. `_latestDoc` becomes the writer's committed `nextDoc` (a
	 * concurrent peer edit merged in), which the next tool body builds on.
	 *
	 * Terminal authority errors (lost access, moved Project, or lost holder) are
	 * latched before RE-THROWING: the tool + SA still see the failure and stop,
	 * while the route can recover the signal after the AI SDK turns a tool throw
	 * into a non-fatal chunk. Any other error rethrows unchanged.
	 */
	private async commitBatch(
		prepared: PreparedMutationCandidate,
		events: MutationEvent[],
		stage: string | undefined,
		options: RecordMutationsOptions | undefined,
	): Promise<RecordMutationsResult> {
		const mutations = prepared.mutations;
		const batchId = crypto.randomUUID();
		const chatRunHolder = this.chatRunHolder;
		let result: { seq: number; committedDoc: BlueprintDoc };
		try {
			// Explicit property rename and case-type retirement need the
			// cross-store boundary. Rename moves Blueprint, schema, live rows,
			// parked rows, and accepted history together; retirement marks the
			// schema inactive in the same transaction as the Blueprint removal.
			// Other batches keep the guarded writer fast path; drain-end
			// materialization derives their active schemas from the committed doc.
			if (
				(mutations.length === 1 &&
					mutations[0]?.kind === "renameCaseProperties") ||
				mutations.some((mutation) => mutation.kind === "retireCaseType")
			) {
				const changeResult = await applyBlueprintChange({
					appId: this.appId,
					userId: this.session.user.id,
					expectedProjectId: this.projectId,
					runId: this.usage.runId,
					chatRunHolder,
					batchId,
					kind: "chat",
					...(options?.expectedOrganizationRevision !== undefined && {
						expectedOrganizationRevision: options.expectedOrganizationRevision,
					}),
					guard: {
						mutations,
					},
				});
				result = {
					seq: changeResult.seq,
					committedDoc: changeResult.committedDoc,
				};
				// A transaction-bearing case-store change can PARK saved case values.
				// Stash the note for the tool wrapper to append to its
				// success message — and log it, since this boundary has no
				// toast.
				if (
					changeResult.migration !== undefined &&
					changeResult.migration.parked > 0
				) {
					this._parkedNote = describeParkedOutcome(changeResult.migration);
					log.warn("[generationContext] case-store change parked case values", {
						appId: this.appId,
						batchId,
						parked: changeResult.migration.parked,
						failureReasons: changeResult.migration.failureReasons,
					});
				}
			} else {
				result = await commitGuardedBatch({
					appId: this.appId,
					batchId,
					runId: this.usage.runId,
					chatRunHolder,
					mutations,
					actorUserId: this.session.user.id,
					expectedProjectId: this.projectId,
					...(options?.expectedOrganizationRevision !== undefined && {
						expectedOrganizationRevision: options.expectedOrganizationRevision,
					}),
					kind: "chat",
				});
			}
		} catch (err) {
			if (err instanceof RunHolderLostError) {
				this.latchRunHolderLost(err);
			} else if (
				err instanceof CommitReauthError ||
				err instanceof AppProjectChangedError
			) {
				this.latchTerminalScopeError(err);
			}
			throw err;
		}
		this._latestDoc = result.committedDoc;
		this._latestSeq = result.seq;
		this.writer.write(
			encodeAdmittedMutationEnvelope({
				type: "data-mutations",
				data: {
					mutations,
					events,
					seq: result.seq,
					batchId,
					...(stage !== undefined && { stage }),
				},
				transient: true,
			}).value as never,
		);
		for (const e of events) this.logWriter.logEvent(e);
		return { events, committedDoc: result.committedDoc, seq: result.seq };
	}

	/** Read-and-clear the parked-value note the LAST commit's row migration
	 * stashed — consumed by the SA wrapper after each mutating tool result so
	 * a park is never invisible to the person who caused it. */
	consumeParkedNote(): string | undefined {
		const note = this._parkedNote;
		this._parkedNote = undefined;
		return note;
	}

	/**
	 * CanonicalMutationHost implementation. AWAITS the inline guarded commit
	 * (`commitBatch` → `commitGuardedBatch`) and returns its committed doc, so a
	 * tool body sees the writer's `nextDoc` (a concurrent peer edit merged in),
	 * never its own local candidate. Both the inline await here AND the SA's
	 * `serial()` mutex around tool bodies are load-bearing: the mutex is what
	 * makes each commit build on the previous one's committed doc, and the await
	 * is what lets `consumeStream()` resolving imply every commit settled —
	 * removing either reintroduces lost concurrent edits and unsettled writes at
	 * drain end. A rejection propagates (the batch is not emitted).
	 */
	async recordMutations(
		prepared: PreparedMutationCandidate,
		stage?: string,
		options?: RecordMutationsOptions,
	): Promise<RecordMutationsResult> {
		if (prepared.mutations.length === 0) {
			return { events: [], committedDoc: prepared.nextDoc };
		}
		const events = this.buildEnvelopes(prepared.mutations, stage);
		return this.commitBatch(prepared, events, stage, options);
	}

	/**
	 * CanonicalMutationHost implementation. Concatenates the non-empty stages and
	 * AWAITS ONE guarded commit for the whole sequence (one `batchId`, one `seq`),
	 * preserving editField's convert→property-patch atomicity — a rejection commits
	 * zero of the stages. Per-stage envelopes keep their own tags for the log /
	 * replay chapters. Like `recordMutations`, the inline await is load-bearing.
	 */
	async recordMutationStages(
		prepared: PreparedMutationCandidate,
		stages: AdmittedMutationStages,
	): Promise<RecordMutationsResult> {
		if (stages.batch.length === 0) {
			return { events: [], committedDoc: prepared.nextDoc };
		}
		// ONE commit for the whole sequence (one batchId, one seq) — preserves
		// editField's convert→property-patch atomicity. Per-stage envelopes keep
		// their own tags for the log / replay chapters.
		const events = stages.slices.flatMap((slice) =>
			this.buildEnvelopes(admittedMutationSlice(stages, slice), slice.stage),
		);
		return this.commitBatch(prepared, events, undefined, undefined);
	}

	/**
	 * Conversation-event entry point (not part of the host contract). Pure delegator to
	 * `emitConversation`; synchronous by construction (no Postgres
	 * latency to block on for conversation events — the durable persistence
	 * is owned by the batched `LogWriter.flush`).
	 */
	recordConversation(payload: ConversationPayload): ConversationEvent {
		return this.emitConversation(payload);
	}

	/**
	 * Whether the run paused on an `askQuestions` round (the SA emitted the
	 * client-side `askQuestions` tool, halting the loop to await the user). The
	 * route reads this after the drain to mark the app `awaiting_input` so the
	 * reaper skips the live paused build.
	 */
	pausedOnInput(): boolean {
		return this._pausedOnInput;
	}

	/**
	 * The latest post-mutation doc this run persisted, or `undefined` for
	 * a run that landed no mutations (a purely conversational turn). The
	 * route's drain-end build finalize reads it to materialize the
	 * case-store schemas and to carry the final snapshot on `data-done`.
	 */
	latestPersistedDoc(): BlueprintDoc | undefined {
		return this._latestDoc;
	}

	/**
	 * The `mutation_seq` the run's most recent batch committed at, or
	 * `undefined` for a run that landed no mutations. The route's drain-end
	 * finalize stamps it on `data-done` so a reconnecting client knows the
	 * run's terminal stream cursor. No save chain to drain any more — every
	 * commit is awaited inline through `commitGuardedBatch`, so by the time the
	 * SA stream is consumed, every batch has already settled durably.
	 */
	latestCommittedSeq(): number | undefined {
		return this._latestSeq;
	}

	/**
	 * The `CommitReauthError` an authoritative write/reload check produced when
	 * the actor lost edit access mid-run, or `undefined` if none did. The route's
	 * drain-end finalize reads it and routes the run through `failRun` (a
	 * deauthorized run must refund, not keep the charge) — a tool `execute()`
	 * throw alone becomes a non-fatal AI-SDK chunk that can't fail the run.
	 */
	reauthError(): CommitReauthError | undefined {
		return this._reauthError;
	}

	/** Project-scope mismatch captured from a guarded write/reload; see the field. */
	projectChangedError(): AppProjectChangedError | undefined {
		return this._projectChangedError;
	}

	/** Exact holder-loss signal captured from a guarded write or finalizer. */
	holderLostError(): RunHolderLostError | undefined {
		return this._holderLostError;
	}

	/** Batch-id collision captured from a guarded write; see the field. */
	batchIdCollisionError(): MutationBatchIdCollisionError | undefined {
		return this._batchIdCollisionError;
	}

	/** Preserve the first collision object so every run fence rethrows one signal. */
	latchBatchIdCollision(error: MutationBatchIdCollisionError): void {
		this._batchIdCollisionError ??= error;
	}

	/** Preserve the first authoritative holder-loss object for every run fence. */
	latchRunHolderLost(error: RunHolderLostError): void {
		this._holderLostError ??= error;
	}

	/**
	 * Latch an authoritative terminal scope failure discovered outside the
	 * guarded writer. Conflict recovery performs its own authorized snapshot
	 * read after `recordMutations` has already returned a conflict, so that read
	 * cannot rely on `commitBatch`'s catch to make the failure visible to queued
	 * tools, `prepareStep`, and the route's drain-end finalizer. Preserve the
	 * exact error object so every fence rethrows and classifies one signal.
	 */
	latchTerminalScopeError(
		error: CommitReauthError | AppProjectChangedError,
	): void {
		if (error instanceof AppProjectChangedError) {
			this._projectChangedError ??= error;
		} else {
			this._reauthError ??= error;
		}
	}

	/**
	 * Edit-run completeness tripwire — called by the chat route after the
	 * drain on EDIT turns. With every committed batch gated against
	 * introducing completeness findings, an edit run that ends with a NEW
	 * completeness finding on the doc is unreachable except through a bug
	 * (a gate gap, a reducer/validator drift); this warn is the alarm
	 * that finds one in production. Legacy docs can carry pre-existing
	 * findings the run never touched — the warn names the codes so a real
	 * gate gap is distinguishable from inherited history. A no-op when
	 * the run persisted nothing (read-only turn).
	 * Deliberately a warn, never a user-facing signal: the per-commit gate
	 * already protected the user, and the doc on disk is whatever the
	 * accepted commits produced.
	 */
	warnIfEditRunIncomplete(): void {
		if (!this._latestDoc) return;
		const completeness = runValidation(
			this._latestDoc,
			LOOKUP_CONTEXT_UNAVAILABLE,
		)
			.filter((err) => classifyValidityError(err.code) === "completeness")
			.map((err) => err.code);
		if (completeness.length === 0) return;
		log.warn("[chat] edit run ended with completeness findings", {
			appId: this.appId,
			runId: this.runId,
			codes: completeness,
		});
	}

	/**
	 * Process one completed agent step: track usage, emit conversation
	 * events (reasoning, text, tool-call + tool-result pairs), and note
	 * tool-call counts.
	 *
	 * This is the shared fan-in for every `ToolLoopAgent` driven by this
	 * context — the SA's inline `onStepEnd` funnels here; any future
	 * agent should do the same. The caller owns mapping whatever shape
	 * the AI SDK's `onStepEnd` provides into `AgentStep`, so this
	 * method stays stable across SDK minor-version bumps.
	 *
	 * Ordering mirrors the model's own production order: reasoning summary
	 * (if emitted), then visible text, then tool-call + tool-result pairs
	 * keyed by `toolCallId` (the SDK emits results on the same step as the
	 * originating call in the current shape, so a single-pass map lookup
	 * is sufficient — no cross-step bookkeeping needed).
	 *
	 * `label` is used only for the warning-log prefix; not persisted.
	 */
	/**
	 * Refresh the run's LIVENESS HORIZON off SA activity — the shared beat both
	 * the per-step (`handleAgentStep`) and the wall-clock timer
	 * (`startRunLeaseHeartbeat`) fire, so a live run never lapses whether it
	 * commits often, does a long read-only stretch, or sits in a single long
	 * model turn with no step-finish. Per mode: an EDIT refreshes its `run_lock`
	 * lease; a BUILD re-arms its `updated_at` staleness clock — a live build
	 * with no commit for over `MAX_GENERATION_MINUTES` (long planning, document
	 * extraction, an SA loop whose rejected tool calls persist nothing) would
	 * otherwise be reaped mid-run: refunded + flipped to `error` out from under
	 * a build that then finishes and celebrates over an `error` row. Debounced
	 * to at most once per `LEASE_HEARTBEAT_INTERVAL_MS` across BOTH signals.
	 * Both refreshers are ownership-gated through the one liveness reader, so a
	 * run superseded mid-way never re-arms the taker's horizon. Fire-and-forget
	 * — a miss just risks an earlier lapse and the next beat retries.
	 */
	private beatRunLease(): void {
		const nowMs = Date.now();
		if (nowMs - this.lastLeaseRefreshMs < LEASE_HEARTBEAT_INTERVAL_MS) return;
		this.lastLeaseRefreshMs = nowMs;
		const refresh = this.editLease ? refreshEditLease : refreshBuildLiveness;
		refresh(this.appId, this.runId, this.holderNonce).catch((err) =>
			log.error("[generation] run-lease heartbeat failed", err, {
				appId: this.appId,
			}),
		);
	}

	/**
	 * Start the wall-clock lease heartbeat — the guarantee that a single long
	 * no-step model turn can't let the run's liveness horizon lapse (the
	 * per-step beat alone can't cover a stretch with no step-finish). The route
	 * calls this once the run is live and MUST call
	 * {@link stopRunLeaseHeartbeat} in its finalize (an uncleared interval
	 * leaks — and a PAUSED run must stop beating, or an abandoned pause would
	 * never lapse for the reapers). `.unref()` so the interval never keeps the
	 * process alive.
	 */
	startRunLeaseHeartbeat(): void {
		if (this.leaseHeartbeatTimer) return;
		this.leaseHeartbeatTimer = setInterval(
			() => this.beatRunLease(),
			LEASE_HEARTBEAT_INTERVAL_MS,
		);
		this.leaseHeartbeatTimer.unref?.();
	}

	/** Stop the wall-clock lease heartbeat. Idempotent; MUST run in the route's
	 * finalize so the interval is cleared (an uncleared timer is an async leak,
	 * and a paused/finalized run must stop re-arming its liveness horizon). */
	stopRunLeaseHeartbeat(): void {
		if (this.leaseHeartbeatTimer) {
			clearInterval(this.leaseHeartbeatTimer);
			this.leaseHeartbeatTimer = undefined;
		}
	}

	handleAgentStep(
		step: AgentStep,
		label: string,
		model = MODEL_DEFAULT,
		phase?: DesignBuildCostPhase,
	): void {
		logWarnings(`runAgent:${label}`, step.warnings);
		// Refresh the run's liveness horizon off SA activity (debounced) — the
		// cheap early beat; the wall-clock timer covers a long no-step turn.
		this.beatRunLease();
		const { usage } = step;
		if (!usage) return;

		/* Outer agent step — increments stepCount on the run summary. */
		this.usage.track(
			{
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
				cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
			},
			{ step: true, model, ...(phase !== undefined && { phase }) },
		);

		/* Per-step usage annotation — the same numbers the accumulator just
		 * folded into the run aggregate, preserved per step on the event log
		 * so a cost investigation can decompose WHERE a run's uncached input
		 * billed (the run summary alone can't — it sums across steps). Leads
		 * the step's event burst, acting as the step separator for readers. */
		this.emitConversation({
			type: "step-usage",
			model,
			pricingTier: pricingTierForInput(usage.inputTokens ?? 0),
			inputTokens: usage.inputTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0,
			...(usage.inputTokenDetails?.cacheReadTokens !== undefined && {
				cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
			}),
			...(usage.inputTokenDetails?.cacheWriteTokens !== undefined && {
				cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
			}),
			...(step.finishReason !== undefined && {
				finishReason: step.finishReason,
			}),
			...(step.rawFinishReason !== undefined && {
				rawFinishReason: step.rawFinishReason,
			}),
			...(step.performance?.stepTimeMs !== undefined && {
				stepTimeMs: step.performance.stepTimeMs,
			}),
			...(step.performance?.responseTimeMs !== undefined && {
				responseTimeMs: step.performance.responseTimeMs,
			}),
			...(step.toolCalls !== undefined && step.toolCalls.length > 0
				? { toolCallIds: step.toolCalls.map((call) => call.toolCallId) }
				: {}),
		});

		if (step.reasoningText) {
			this.emitConversation({
				type: "assistant-reasoning",
				text: step.reasoningText,
			});
		}
		if (step.text) {
			this.emitConversation({ type: "assistant-text", text: step.text });
		}

		const resultByCallId = new Map<string, unknown>();
		for (const tr of step.toolResults ?? []) {
			resultByCallId.set(tr.toolCallId, tr.output);
		}
		// Fold SDK-surfaced tool errors (invalid input rejected before
		// `execute`, or an execution throw) into the same map as an
		// `{ error }` output — the shape the tool bodies already use for
		// handled errors, so log readers and the chat UI treat both alike.
		// Without this a failed call emits a tool-call with no paired
		// result, leaving the log showing a bare, unexplained invocation.
		// Errored and successful results are mutually exclusive per call, so
		// a present result always wins.
		for (const te of step.toolErrors ?? []) {
			if (resultByCallId.has(te.toolCallId)) continue;
			const message =
				te.error instanceof Error ? te.error.message : String(te.error);
			resultByCallId.set(te.toolCallId, {
				error: step.toolEventMode === "metadata-only" ? "tool-error" : message,
			});
			// Surface it in Cloud Logging too — the fold above only records it in
			// the per-run event log (Postgres). A tool call reaching the SDK's
			// error path (invalid input, or an execution throw) is abnormal: tool
			// bodies normally catch and return a friendly `{ error }`, so an
			// `output-error` means something escaped and is worth a greppable line.
			// `warn`, not `error`: the model occasionally mis-calls a tool then
			// self-corrects on retry, which shouldn't page anyone — but it must not
			// vanish, and it must not reach the user raw (the chat UI shows a
			// friendly line in its place).
			log.warn("[agent] tool call errored", {
				label,
				toolCallId: te.toolCallId,
				toolName: step.toolCalls?.find((c) => c.toolCallId === te.toolCallId)
					?.toolName,
				...(step.toolEventMode === "metadata-only"
					? { code: "private-tool-error" }
					: { error: message }),
			});
		}
		for (const tc of step.toolCalls ?? []) {
			this.usage.noteToolCall();
			/* `askQuestions` (the tool key in `solutionsArchitect.ts`'s tool set) has
			 * no `execute` and halts the loop to await the user, so seeing it means
			 * the run is PAUSING for input, not finishing — the signal the route needs
			 * to mark the app `awaiting_input`. */
			if (tc.toolName === "askQuestions") this._pausedOnInput = true;
			// Clarification questions are user-visible conversation history, not
			// private design protocol payloads. Keep them inspectable even when
			// stage/inspect/finalize calls from the same agent are suppressed.
			if (
				step.toolEventMode === "metadata-only" &&
				tc.toolName !== "askQuestions"
			) {
				continue;
			}
			this.emitConversation({
				type: "tool-call",
				toolCallId: tc.toolCallId,
				toolName: tc.toolName,
				input: tc.input,
			});
			const out = resultByCallId.get(tc.toolCallId);
			if (out !== undefined) {
				this.emitConversation({
					type: "tool-result",
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					output: out,
				});
			}
		}
	}

	/**
	 * Record token usage for a sub-generation LLM call.
	 *
	 * Sub-gens are the inner `generate` / `streamGenerate` /
	 * `extractDocumentStructured` calls the SA's tools issue. They count toward the
	 * run summary's token totals but NOT toward `stepCount` — only outer
	 * agent steps (handled by `handleAgentStep`) produce "steps" in the
	 * run-summary sense.
	 *
	 * The event log does not carry per-tool usage; if sub-gen
	 * prompt/output observability becomes a product requirement, it will
	 * live on a separate admin-only collection, not here.
	 */
	trackSubGeneration(usage: LanguageModelUsage, model = MODEL_DEFAULT): void {
		meterSubGenerationUsage(this.usage, usage, { model });
	}

	/**
	 * The ONE document-extraction call: fills `{ extract, title, summary }` from a
	 * document (decoded text as `prompt`, or a native `file` block for a PDF) in a
	 * single structured generation. Runs on the document summarizer, streamed
	 * through `streamObjectWith` so `onProgress` can pulse the
	 * grid — NOT the `Output.object` path `generate` uses. Usage tracks through the same accumulator as every other sub-generation,
	 * so an extraction shows up on the per-run cost summary alongside the agent loop.
	 *
	 * Returns `{ object, truncated }`. `object` is `null` when the model couldn't
	 * produce a valid object — truncation past `maxOutputTokens` (`truncated: true`)
	 * or a malformed response — which the caller treats as a failed extraction (a
	 * structured call has no partial to salvage). `emitErrors: false` logs a
	 * transport error rather than surfacing it as a user-facing generation error
	 * (the attachment pipeline recovers by inlining the raw document); the error is
	 * still re-thrown so the caller's catch runs.
	 */
	async extractDocumentStructured<T>(
		opts: ExtractDocumentStructuredOpts<T>,
	): Promise<StructuredExtractResult<T>> {
		try {
			// `streamObjectWith` is the shared structured-generation core; a PDF
			// rides as a native `file` block, text/docx/xlsx as a decoded `prompt`.
			// Streaming lets `onProgress` pulse the signal grid with real read
			// progress during the send-time backstop; only the final object is used.
			const result = await streamObjectWith<T>({
				model: this.model(opts.model ?? MODEL_DEFAULT),
				system: opts.system,
				schema: opts.schema,
				prompt: opts.prompt,
				file: opts.file,
				instruction: opts.instruction,
				images: opts.images,
				maxOutputTokens: opts.maxOutputTokens,
				providerOptions: opts.providerOptions,
				onProgress: opts.onProgress,
			});
			logWarnings(`extractDocument:${opts.label}`, result.warnings);
			if (result.usage)
				this.trackSubGeneration(result.usage, opts.model ?? MODEL_DEFAULT);
			return {
				object: result.object,
				truncated: result.finishReason === "length",
			};
		} catch (error) {
			if (opts.emitErrors === false) {
				log.warn(`extractDocument:${opts.label} failed; caller will recover`, {
					error: error instanceof Error ? error.message : String(error),
				});
			} else {
				this.emitError(classifyError(error), `extractDocument:${opts.label}`);
			}
			throw error;
		}
	}

	/** One-shot structured generation with automatic usage tracking. */
	async generate<T>(
		schema: z.ZodType<T>,
		opts: {
			system: string;
			prompt: string;
			label: string;
			model?: string;
			maxOutputTokens?: number;
			reasoning?: { effort: ReasoningEffort };
		},
	): Promise<T | null> {
		try {
			const model = opts.model ?? MODEL_DEFAULT;
			const result = await generateText({
				model: this.model(model),
				output: Output.object({ schema }),
				instructions: opts.system,
				prompt: opts.prompt,
				maxOutputTokens: opts.maxOutputTokens,
				providerOptions: opts.reasoning
					? reasoningProviderOptions(opts.reasoning.effort)
					: { openai: OPENAI_BASE_OPTIONS },
			});
			logWarnings(`generate:${opts.label}`, result.warnings);
			if (result.usage) this.trackSubGeneration(result.usage, model);
			return result.output ?? null;
		} catch (error) {
			this.emitError(classifyError(error), `generate:${opts.label}`);
			throw error;
		}
	}

	/** Streaming structured generation with partial callbacks and automatic usage tracking. */
	async streamGenerate<T>(
		schema: z.ZodType<T>,
		opts: {
			system: string;
			prompt: string;
			label: string;
			model?: string;
			maxOutputTokens?: number;
			onPartial?: (partial: Partial<T>) => void;
			reasoning?: { effort: ReasoningEffort };
		},
	): Promise<T | null> {
		const model = opts.model ?? MODEL_DEFAULT;
		const result = streamText({
			model: this.model(model),
			output: Output.object({ schema }),
			instructions: opts.system,
			prompt: opts.prompt,
			maxOutputTokens: opts.maxOutputTokens,
			providerOptions: opts.reasoning
				? reasoningProviderOptions(opts.reasoning.effort)
				: { openai: OPENAI_BASE_OPTIONS },
			onError: ({ error }) => {
				this.emitError(classifyError(error), `streamGenerate:${opts.label}`);
			},
		});

		let last: T | null = null;
		for await (const partial of result.partialOutputStream) {
			opts.onPartial?.(partial as Partial<T>);
			last = partial as T;
		}

		logWarnings(`streamGenerate:${opts.label}`, await result.warnings);
		const usage = await result.usage;
		if (usage) this.trackSubGeneration(usage, model);
		return last;
	}
}
