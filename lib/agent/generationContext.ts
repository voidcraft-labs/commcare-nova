/**
 * GenerationContext — shared abstraction for all LLM calls and generation state.
 *
 * Owns the fan-out from a single agent run to every write surface the server
 * produces during generation:
 *
 *  - **SSE (`UIMessageStreamWriter`)** — live wire to the interactive builder.
 *    `emit()` is a pure pass-through for lifecycle/error events (`data-phase`,
 *    `data-fix-attempt`, `data-error`, `data-done`, …). Doc-mutating events
 *    go through `emitMutations`, which owns both the SSE payload and the
 *    matching event-log writes.
 *  - **Event log (`LogWriter`)** — Firestore-backed append-only event stream.
 *    `emitMutations` writes one `MutationEvent` per mutation; `emitConversation`
 *    writes one `ConversationEvent` per assistant/tool/user artifact. The log
 *    powers admin inspection and future replay. It is strictly supplemental —
 *    the blueprint snapshot on `AppDoc` is still authoritative.
 *  - **Usage (`UsageAccumulator`)** — per-request token + cost aggregation
 *    flushed once at request end. Outer agent steps carry `{ step: true }`;
 *    sub-gens (internal `generate` / `streamGenerate` /
 *    `extractDocumentStructured` calls) accumulate tokens without stepping
 *    the counter.
 *
 * Implements `ToolExecutionContext` — the narrow interface extracted tool
 * modules consume. `recordMutations` + `recordConversation` are the
 * surface-neutral entry points; `emitMutations` + `emitConversation` are
 * the chat-surface implementations (with SSE fan-out) that the interface
 * methods delegate to.
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

import {
	type AnthropicProviderOptions,
	createAnthropic,
} from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type {
	CallWarning,
	LanguageModelUsage,
	UIMessageStreamWriter,
} from "ai";
import { generateText, Output, streamText } from "ai";
import type { z } from "zod";
import type { Session } from "@/lib/auth";
import { classifyError as classifyValidityError } from "@/lib/commcare/validator/gate";
import { runValidation } from "@/lib/commcare/validator/runner";
import { loadBlueprintBasis, updateAppForRun } from "@/lib/db/apps";
import type { UsageAccumulator } from "@/lib/db/usage";
import type { CommitPhase } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	ClassifiedErrorPayload,
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import type { LogWriter } from "@/lib/log/writer";
import { log } from "@/lib/logger";
import { MODEL_DEFAULT, type ReasoningEffort } from "@/lib/models";
import type {
	ExtractDocumentStructuredOpts,
	StructuredExtractResult,
} from "./documentExtraction";
import { type ClassifiedError, classifyError } from "./errorClassifier";
import { streamObjectWith } from "./subGeneration";
import type {
	StagedMutationBatch,
	ToolExecutionContext,
} from "./toolExecutionContext";

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
 * Anthropic provider options for adaptive extended thinking on Opus 4.7+.
 *
 * `effort` is a top-level provider option (NOT nested inside `thinking` — Zod
 * `$strip` silently drops it there). `display: 'summarized'` is required for
 * human-readable summaries to stream back; without it, thinking blocks come
 * through as encrypted/redacted on Opus 4.7.
 */
export function thinkingProviderOptions(effort: ReasoningEffort) {
	const anthropic: AnthropicProviderOptions = {
		thinking: { type: "adaptive", display: "summarized" },
		effort,
	};
	return { anthropic };
}

/**
 * Constructor options. Two orthogonal collaborators: `LogWriter` owns
 * durable event persistence (fire-and-forget); `UsageAccumulator` owns
 * cost aggregation and exposes the `runId` used on every event envelope.
 *
 * `appId` is required — the chat route creates the app doc via `createApp`
 * before constructing the context (Firestore-down = 503, not an orphaned
 * build). Every `GenerationContext` instance has a target app to persist
 * against, so `saveBlueprint` can persist the post-mutation doc threaded
 * in by each caller — the same shape as `McpContext`.
 */
interface GenerationContextOptions {
	apiKey: string;
	/** SSE writer for the live builder. Unchanged wire format. */
	writer: UIMessageStreamWriter;
	/** Event log sink — batched Firestore writer, one doc per event. */
	logWriter: LogWriter;
	/** Cost + step/tool-call counter for per-run summary + monthly cap. */
	usage: UsageAccumulator;
	/** Authenticated user session — always present (all users are authenticated). */
	session: Session;
	/** Firestore app id. The chat route creates the app doc before this
	 * constructor runs so every context has a valid target app. */
	appId: string;
	/** Validity-gate phase for this run — `"building"` for an initial
	 * build (`appReady` false), `"complete"` for an edit of an existing
	 * app. See `ToolExecutionContext.commitPhase`. */
	commitPhase: CommitPhase;
}

/**
 * One completed agent step, normalized to the minimum surface the step
 * handler needs. Callers (the SA's `onStepFinish`, tests) map the AI SDK's
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
}

export class GenerationContext implements ToolExecutionContext {
	private anthropic: ReturnType<typeof createAnthropic>;
	/** Google provider for the document summarizer (Gemini). `null` when
	 *  `GOOGLE_GENERATIVE_AI_API_KEY` is unset — `resolveModel` then fails loud
	 *  on a Gemini call and the condenser falls back to raw inlining. */
	private google: ReturnType<typeof createGoogleGenerativeAI> | null;
	readonly writer: UIMessageStreamWriter;
	readonly logWriter: LogWriter;
	readonly usage: UsageAccumulator;
	/** Authenticated user session. */
	readonly session: Session;
	/** Firestore app id — required. Created before construction by the
	 * chat route so every context has a valid persistence target. */
	readonly appId: string;
	/** Validity-gate phase for this run. See `ToolExecutionContext.commitPhase`. */
	readonly commitPhase: CommitPhase;
	/**
	 * Per-request tiebreaker for same-millisecond SSE bursts. Resets to 0
	 * each request; doc IDs are Firestore-minted, so no cross-request
	 * uniqueness is needed.
	 */
	private seq = 0;
	/** The most recent post-mutation doc snapshot this run persisted —
	 * what `warnIfEditRunIncomplete` evaluates after the drain. Absent
	 * until the first mutation batch lands (a read-only turn). */
	private _latestDoc: BlueprintDoc | undefined;
	/* Flipped true when the SA emits an `askQuestions` tool-call — the client-side
	 * tool with no `execute` that HALTS the agent loop to await the user's answer.
	 * The chat route reads this after the drain to mark the app `awaiting_input`,
	 * so the refunding reaper doesn't mistake a live build paused on a question for
	 * a hard-killed one and refund its still-live hold. */
	private _pausedOnInput = false;

	constructor(opts: GenerationContextOptions) {
		this.anthropic = createAnthropic({ apiKey: opts.apiKey });
		/* The Google key is a platform env var (the document summarizer is a
		 * platform feature, not BYOK) — distinct from the shared Anthropic key
		 * threaded in via `opts.apiKey`. Built once per request; null-when-unset
		 * so `resolveModel` can fail loud rather than construct a broken client. */
		const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		this.google = googleKey
			? createGoogleGenerativeAI({ apiKey: googleKey })
			: null;
		this.writer = opts.writer;
		this.logWriter = opts.logWriter;
		this.usage = opts.usage;
		this.session = opts.session;
		this.appId = opts.appId;
		this.commitPhase = opts.commitPhase;
	}

	/** Get the Anthropic model provider for a given model ID. The SA always
	 *  runs on Anthropic (Opus), so its factory uses this directly. */
	model(id: string) {
		return this.anthropic(id);
	}

	/**
	 * Resolve a model id to a provider-bound `LanguageModel`. Gemini ids route to
	 * the Google provider (the document summarizer); every other id to Anthropic
	 * (the SA and its structured sub-gens). The Google provider is built from
	 * `GOOGLE_GENERATIVE_AI_API_KEY`; when that's unset a Gemini call fails loud
	 * at ERROR level — so a missing key surfaces in Error Reporting instead of
	 * silently degrading — and the condenser's own catch inlines the raw document
	 * (still never-drop, but slower and far more expensive at the Opus rate).
	 */
	private resolveModel(id: string) {
		if (id.startsWith("gemini")) {
			if (!this.google) {
				log.error(
					"[generation] GOOGLE_GENERATIVE_AI_API_KEY is not set — the Gemini document summarizer cannot run; attachments fall back to raw inlining (slower + far more expensive). Set the key in the environment to restore condensing.",
				);
				throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
			}
			return this.google(id);
		}
		return this.anthropic(id);
	}

	/**
	 * ToolExecutionContext accessor — the authenticated Better Auth user
	 * id. Exposed so shared tool bodies can look up user-scoped resources
	 * (e.g. KMS-encrypted HQ credentials) through the interface without
	 * dipping into the concrete class.
	 */
	get userId(): string {
		return this.session.user.id;
	}

	/**
	 * ToolExecutionContext accessor — the per-run grouping id, sourced
	 * from the `UsageAccumulator` so the run-id stamped on every event
	 * envelope stays consistent with the run-summary doc.
	 */
	get runId(): string {
		return this.usage.runId;
	}

	/**
	 * Fire-and-forget save of the SA's current doc snapshot to Firestore.
	 *
	 * Called by `emitMutations` after every mutation batch so the app
	 * document's `updated_at` advances during generation. This lets the
	 * staleness check in `listApps()` distinguish "still actively
	 * generating" from "process died" — without this, `updated_at ===
	 * created_at` for the entire run.
	 *
	 * Writes `run_id` on every intermediate save (via `updateAppForRun`
	 * rather than `updateApp`) so the app doc's run_id reflects the
	 * current chat run while it's in flight. Without this, an edit run
	 * that mutates the doc but never reaches `completeBuild` leaves
	 * `app.run_id` stuck at the prior `completeApp`'s id, and the MCP
	 * surface's sliding-window run derivation (see
	 * `lib/mcp/runId.ts`) would attach subsequent MCP events to a
	 * closed chat run within the inactivity window.
	 *
	 * `doc` is the post-mutation blueprint, threaded in by the caller.
	 * Chat stays fire-and-forget because the SA's fix-retry discipline
	 * covers missed intermediate saves and we don't want to block the
	 * SSE stream on Firestore latency. Errors are logged; no rejection
	 * ever propagates out of this method. `McpContext.saveBlueprint`
	 * mirrors the same strip via the shared `toPersistableDoc` helper
	 * but awaits the write (its fail-closed contract has no agent loop
	 * to retry).
	 */
	private saveBlueprint(doc: BlueprintDoc): void {
		updateAppForRun(this.appId, toPersistableDoc(doc), this.usage.runId).catch(
			(err) => log.error("[intermediate-save] failed", err),
		);
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
			 * it authoritatively on its way to Firestore (see LogWriter), so
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
	 *   - `data-done` — full-doc reconciliation from completeBuild.
	 *   - `data-blueprint-updated` — edit-mode coarse-tool replacements.
	 *   - `data-app-id` — one-shot appId announcement driving the
	 *     `/build/new` → `/build/{id}` URL swap on new builds.
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
	emitError(error: ClassifiedError, context?: string): void {
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
	 * Emit a fine-grained mutation batch to the client stream and the
	 * event log, and persist the post-mutation doc snapshot to Firestore.
	 *
	 * This is the ONLY sanctioned way for the SA (or its validation loop)
	 * to tell the client that the doc has changed. The mutations payload
	 * is the same `Mutation[]` the SA applied to its own internal doc via
	 * `applyMutations` on an Immer draft — the client applies the
	 * identical array via `docStore.applyMany(mutations)`.
	 *
	 * `doc` is the POST-mutation blueprint — callers apply the mutations
	 * on their working doc FIRST, then thread the resulting value in
	 * here. The persisted snapshot is exactly that value. Matches the
	 * semantic on `McpContext.recordMutations` so a shared tool body can
	 * invoke the interface method uniformly on either surface.
	 *
	 * The optional `stage` string is a semantic tag for the log
	 * (`"scaffold"`, `"module:0"`, `"form:0-1"`, `"rename:0-0"`). It's
	 * stamped on every MutationEvent envelope — both log and SSE see the
	 * same tag, so lifecycle derivations over the client buffer match
	 * replay derivations over the persisted log.
	 *
	 * Writes, in order:
	 * 1. Build MutationEvent envelopes — same values on the wire + log.
	 * 2. SSE — one `data-mutations` event carrying both the raw
	 *    `mutations` (for `docStore.applyMany`, preserving zundo grouping)
	 *    AND the `events` envelope array (for the session events buffer).
	 * 3. Firestore intermediate save — advances `updated_at` on the app
	 *    doc so listApps can distinguish in-progress from orphaned runs.
	 *    Fire-and-forget; this method does not await the Firestore write.
	 * 4. Event log — one `MutationEvent` per mutation, reusing the same
	 *    envelopes that went out on SSE.
	 *
	 * Returns the built envelopes so callers can forward them to
	 * downstream metadata without rebuilding. No-op on empty batches,
	 * returning `[]`.
	 */
	emitMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): MutationEvent[] {
		if (mutations.length === 0) return [];

		/* Build MutationEvent envelopes once; the same values ship on SSE
		 * (client pushes to the events buffer) and on the log writer.
		 * `seq` is allocated monotonically per envelope — contiguous with
		 * conversation events emitted in the same run. */
		const events: MutationEvent[] = mutations.map((mutation) => ({
			kind: "mutation",
			runId: this.usage.runId,
			ts: Date.now(),
			seq: this.seq++,
			actor: "agent",
			/* Inline `source: "chat"` so the envelope we ship on SSE
			 * (via `data-mutations` → session events buffer) is
			 * schema-valid. LogWriter re-stamps it on the way to
			 * Firestore regardless; this is the client-facing value. */
			source: "chat",
			/* Include `stage` whenever the caller explicitly passed a value —
			 * empty-string is a valid stage. Mirrors McpContext.recordMutations. */
			...(stage !== undefined && { stage }),
			mutation,
		}));

		this.writer.write({
			type: "data-mutations",
			data: {
				mutations,
				events,
				...(stage !== undefined && { stage }),
			},
			transient: true,
		});
		/* Fire-and-forget intermediate save advances `updated_at` so the
		 * staleness detector distinguishes "still generating" from "process
		 * died". The caller owns the doc shape; we just persist whatever
		 * post-mutation snapshot they handed us. */
		this._latestDoc = doc;
		this.saveBlueprint(doc);
		/* Event log — write the same envelopes we just sent on SSE. */
		for (const e of events) this.logWriter.logEvent(e);
		return events;
	}

	/**
	 * ToolExecutionContext implementation. Delegates to `emitMutations`,
	 * which takes `doc` directly and persists it via `saveBlueprint`.
	 * The chat surface's intermediate save is fire-and-forget (SA
	 * fix-retry discipline covers missed saves), so the returned promise
	 * resolves as soon as the synchronous SSE write + log enqueue
	 * complete — matching the interface's asynchronous signature while
	 * preserving the chat surface's "don't block the stream on
	 * Firestore" invariant.
	 *
	 * The `async` keyword is load-bearing for the interface's
	 * `Promise<MutationEvent[]>` return type; the body is synchronous
	 * because `emitMutations` is synchronous and `saveBlueprint` is
	 * fire-and-forget. No `await` appears inside this method by design.
	 */
	async recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): Promise<MutationEvent[]> {
		return this.emitMutations(mutations, doc, stage);
	}

	/**
	 * ToolExecutionContext implementation. The chat surface's save is
	 * fire-and-forget per stage (the SA's retry discipline covers a missed
	 * intermediate save), so "one save for the whole sequence" needs no
	 * special handling here — each stage emits its own SSE batch + log
	 * envelopes under its own tag, and the last stage's snapshot is the
	 * one that settles on Firestore. The atomicity contract this method
	 * exists for lives on the MCP implementation, whose transactional
	 * write can reject (`McpContext.recordMutationStages`).
	 */
	async recordMutationStages(
		stages: StagedMutationBatch[],
	): Promise<MutationEvent[]> {
		const events: MutationEvent[] = [];
		for (const s of stages) {
			events.push(...this.emitMutations(s.mutations, s.doc, s.stage));
		}
		return events;
	}

	/**
	 * ToolExecutionContext implementation. Pure delegator to
	 * `emitConversation`; synchronous by construction (no Firestore
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
	 * ToolExecutionContext implementation — the chat surface captures the
	 * completion basis with a FRESH read at `completeBuild` call time. The
	 * SA's working doc is the snapshot "as of this call": the run's own
	 * intermediate saves never rotate the token, so the compare inside
	 * `completeAppGuardedByBasis` flags exactly the rotating writers (a
	 * builder tab's save, an MCP commit) that land during the evaluation
	 * window. (The MCP surface instead injects the token from the same
	 * load that produced the tool's doc — see `McpContext`.)
	 */
	async getCompletionBasis(): Promise<string | null> {
		return loadBlueprintBasis(this.appId);
	}

	/**
	 * Edit-run completeness tripwire — called by the chat route after the
	 * drain on EDIT turns. With every committed batch gated under the
	 * complete-phase ratchet, an edit run that ends with a completeness
	 * finding on the doc is unreachable except through a bug (a gate gap,
	 * a reducer/validator drift); this warn is the alarm that finds one in
	 * production. A no-op when the run persisted nothing (read-only turn).
	 * Deliberately a warn, never a user-facing signal: the per-commit gate
	 * already protected the user, and the doc on disk is whatever the
	 * accepted commits produced.
	 */
	warnIfEditRunIncomplete(): void {
		if (!this._latestDoc) return;
		const completeness = runValidation(this._latestDoc)
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
	 * context — the SA's inline `onStepFinish` funnels here; any future
	 * agent should do the same. The caller owns mapping whatever shape
	 * the AI SDK's `onStepFinish` provides into `AgentStep`, so this
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
	handleAgentStep(step: AgentStep, label: string): void {
		logWarnings(`runAgent:${label}`, step.warnings);
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
			{ step: true },
		);

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
			resultByCallId.set(te.toolCallId, { error: message });
			// Surface it in Cloud Logging too — the fold above only records it in
			// the per-run event log (Firestore). A tool call reaching the SDK's
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
				error: message,
			});
		}
		for (const tc of step.toolCalls ?? []) {
			this.usage.noteToolCall();
			/* `askQuestions` (the tool key in `solutionsArchitect.ts`'s tool set) has
			 * no `execute` and halts the loop to await the user, so seeing it means
			 * the run is PAUSING for input, not finishing — the signal the route needs
			 * to mark the app `awaiting_input`. */
			if (tc.toolName === "askQuestions") this._pausedOnInput = true;
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
	private trackSubGeneration(usage: {
		inputTokens?: number;
		outputTokens?: number;
		inputTokenDetails?: {
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
		};
	}): void {
		this.usage.track({
			inputTokens: usage.inputTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0,
			cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
		});
	}

	/**
	 * The ONE document-extraction call: fills `{ extract, title, summary }` from a
	 * document (decoded text as `prompt`, or a native `file` block for a PDF) in a
	 * single structured generation. Routes via `resolveModel` (Gemini → Google for
	 * the summarizer) and the provider's controlled generation (`streamObjectWith`,
	 * streamed so `onProgress` can pulse the grid), NOT the Anthropic `Output.object`
	 * path `generate` uses — extraction runs on the document summarizer, not the SA's
	 * model. Usage tracks through the same accumulator as every other sub-generation,
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
			// `resolveModel` routes the id to its provider (Gemini → Google for the
			// summarizer). `streamObjectWith` is the shared structured-generation core;
			// a PDF rides as a native `file` block, text/docx/xlsx as a decoded
			// `prompt`. Streaming lets `onProgress` pulse the signal grid with real read
			// progress during the send-time backstop; only the final object is used.
			const result = await streamObjectWith<T>({
				model: this.resolveModel(opts.model ?? MODEL_DEFAULT),
				system: opts.system,
				schema: opts.schema,
				prompt: opts.prompt,
				file: opts.file,
				instruction: opts.instruction,
				maxOutputTokens: opts.maxOutputTokens,
				providerOptions: opts.providerOptions,
				onProgress: opts.onProgress,
			});
			logWarnings(`extractDocument:${opts.label}`, result.warnings);
			if (result.usage) this.trackSubGeneration(result.usage);
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
				model: this.anthropic(model),
				output: Output.object({ schema }),
				system: opts.system,
				prompt: opts.prompt,
				maxOutputTokens: opts.maxOutputTokens,
				...(opts.reasoning && {
					providerOptions: thinkingProviderOptions(opts.reasoning.effort),
				}),
			});
			logWarnings(`generate:${opts.label}`, result.warnings);
			if (result.usage) this.trackSubGeneration(result.usage);
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
			model: this.anthropic(model),
			output: Output.object({ schema }),
			system: opts.system,
			prompt: opts.prompt,
			maxOutputTokens: opts.maxOutputTokens,
			...(opts.reasoning && {
				providerOptions: thinkingProviderOptions(opts.reasoning.effort),
			}),
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
		if (usage) this.trackSubGeneration(usage);
		return last;
	}
}
