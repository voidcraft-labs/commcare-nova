/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * ONE shared tool set serves both modes: conversation, the data-model
 * tool (`generateSchema` — a build's first commit, and how a new case
 * type enters an existing app), reads, mutations, case-list /
 * case-search config, media. Build vs edit picks the prompt and the
 * model — never the tool set. Both prompts are static; each turn's
 * blueprint summary rides a per-turn message the route appends
 * (`buildAppStateMessage`), keeping the system prompt cache-stable.
 *
 * Vocabulary is domain-native: tool arguments, return shapes, and the
 * system prompt all use `field` / `kind` / `validate` / `validate_msg` /
 * `caseWrite`. Tool args flow straight into the reducer helpers in
 * `blueprintHelpers.ts`.
 *
 * Stream-event payloads carry fine-grained `data-mutations` events
 * emitted via `ctx.recordMutations` for every tool-level change. There is
 * no finishing tool: the chat route finalizes a build at drain end
 * (status flip + case-store materialize + the `data-done` signal).
 */
import { type FlexibleSchema, stepCountIs, ToolLoopAgent } from "ai";
import type { ZodType } from "zod";
import {
	AppAccessError,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import {
	reasoningProviderOptions,
	SA_BUILD_MODEL,
	SA_BUILD_REASONING,
	SA_EDIT_MODEL,
	SA_EDIT_REASONING,
} from "@/lib/models";
import type { GenerationContext } from "./generationContext";
import { buildSolutionsArchitectPrompt } from "./prompts";
import {
	SHARED_TOOL_REGISTRY,
	type SharedToolRegistryEntry,
} from "./sharedToolRegistry";
import { askQuestionsTool } from "./tools/askQuestions";
import { wireToolSchema } from "./wireSchemas";

// ── Solutions Architect Agent ────────────────────────────────────────

/**
 * Create the Solutions Architect agent.
 *
 * @param initialDoc - The SA's starting `BlueprintDoc`. On initial builds
 *   this is the exact canonical starter returned by `createApp`; during edits
 *   it's the app's current state loaded from Postgres. The SA owns this doc for
 *   the lifetime of the agent — every tool call mutates it in place.
 * @param editing - True when the app already exists (appReady). The SA gets
 *   the editing preamble in its prompt (the blueprint summary arrives as a
 *   per-turn message the route appends). False during initial builds, where
 *   the SA gets the build-mode prompt.
 */
export function createSolutionsArchitect(
	ctx: GenerationContext,
	initialDoc: BlueprintDoc,
	editing = false,
) {
	/* Internal working doc — read + reassigned on every tool call.
	 *
	 * Mutation persistence (SSE + event log + Postgres) happens inside
	 * each extracted tool module via `ctx.recordMutations`. The wrappers
	 * below only reassign `doc` when the extracted tool's `mutations`
	 * array is non-empty, so the next tool call in the same request sees
	 * post-mutation state for its positional-index lookups. Wire-format
	 * snapshots are generated on demand for LLM-facing outputs and for
	 * the CommCare validator. */
	let doc: BlueprintDoc = initialDoc;

	/* Promise-chain mutex serializing every tool execution within this
	 * agent instance.
	 *
	 * The AI SDK invokes parallel `tool_use` blocks from one assistant
	 * turn concurrently via `Promise.all(toolCalls.map(...))`. Without a
	 * serializer, each branch reads the same pre-batch `doc` snapshot
	 * inside its wrapped `execute` and the last branch's `doc = newDoc`
	 * clobbers the others — earlier mutations stream to the wire
	 * correctly but vanish from the SA's own working state, and the SA's
	 * next read tool reports them as missing.
	 *
	 * Every wrapped tool body enters `serial(...)`, which appends to a
	 * single `chain` promise. Each tool's body therefore runs strictly
	 * after the previous tool's body resolved, so reads observe the doc
	 * as left by the previous write and dependent batches (e.g. addFields
	 * creating a group + addFields targeting it as parent) compose
	 * correctly.
	 *
	 * Order in which branches enter `serial()` matches model-emit order
	 * only because every branch traverses an identical async path —
	 * same number of awaits between `Promise.all`'s synchronous dispatch
	 * and the inner `tool.execute` call — so microtask FIFO drains in
	 * the order branches were created. Per-branch variance in that path
	 * (a tool-call lifecycle hook that awaits on branch-specific I/O,
	 * a telemetry integration whose handler awaits, or a future SDK
	 * change that inserts extra awaits on some branches) can reorder
	 * branches relative to model-emit order. The data-loss case is
	 * still prevented under reordering — each tool always sees a
	 * coherent `doc` — but a parent-id lookup might miss a sibling
	 * created earlier in the same parallel batch. If you add tool-call
	 * lifecycle hooks or telemetry, re-verify the microtask-equivalence
	 * property.
	 *
	 * Both `then` handlers swallow their value (success result and
	 * rejection alike) so the chain stays a `Promise<void>` and a failing
	 * ordinary tool failure doesn't poison the chain for subsequent calls;
	 * the `next` promise still rejects to its caller, preserving error
	 * visibility at the AI SDK boundary (it's converted to a `tool-error`
	 * content part). Terminal tenant-scope failures are the exception:
	 * `throwIfTerminalRunError` reads their durable GenerationContext latch
	 * at the start of every queued body, so the recovered promise chain stays
	 * structurally coherent without permitting more work in a dead run. */
	let chain: Promise<void> = Promise.resolve();
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = chain.then(fn);
		chain = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	/**
	 * Fence all work after an authoritative scope failure. A guarded commit or
	 * conflict-reload check stores the exact thrown object on GenerationContext
	 * before rethrowing it. Parallel tool calls from one model step may already
	 * be queued behind that check, so every serialized body must consult the latch
	 * before it reads or writes the working doc. Re-throwing the stored instance
	 * also preserves the route's authoritative error classification.
	 */
	function throwIfTerminalRunError(): void {
		const terminalError =
			ctx.holderLostError() ??
			ctx.projectChangedError() ??
			ctx.reauthError() ??
			ctx.batchIdCollisionError();
		if (terminalError !== undefined) throw terminalError;
	}

	/** Chat-surface wire projection — AST stubs on the wire, full Zod
	 *  validation intact (`wireSchemas.ts`). Every SA tool is Zod-schema'd,
	 *  so the cast holds. */
	function wire<I>(schema: FlexibleSchema<I>): FlexibleSchema<I> {
		return wireToolSchema(schema as ZodType<I>);
	}

	/**
	 * Mount one entry from the canonical shared-tool registry on the SA.
	 *
	 * The same module object is mounted on MCP from the same registry. Its
	 * result discriminator selects the chat projection at runtime: reads expose
	 * `data`, mutations expose `result` and advance the working document. This
	 * makes it impossible to add, remove, rename, or replace a shared tool on
	 * only one surface.
	 */
	function wrapShared(t: SharedToolRegistryEntry["tool"]) {
		return {
			description: t.description,
			inputSchema: wire(t.inputSchema),
			// Opt out of the Responses API's default strict-mode schema
			// normalization, which forces EVERY property present on every
			// call (optionals become required; the model pads unused slots
			// with null — or invents filler where null isn't in the type).
			// Non-strict lets the model omit what doesn't apply — fewer
			// output tokens per call, less context echo on every later step
			// — and our own Zod validation remains the real gate either way.
			strict: false,
			execute: (input: unknown) =>
				serial(async () => {
					throwIfTerminalRunError();
					try {
						const outcome = await t.execute(input, ctx, doc);
						switch (outcome.kind) {
							case "read":
								return outcome.data;
							case "mutate": {
								/* Most no-op results return the invocation doc. A tool may instead
								 * perform an authoritative read to prove that the requested state is
								 * already persisted. Adopt that exact `newDoc` too, so a concurrent
								 * peer edit observed by the proof is not discarded from the SA's
								 * working closure merely because no history row was needed. */
								doc = outcome.newDoc;
								/* A committed row migration that PARKED saved case values stashed a
								 * note on the context — append it to a message-bearing
								 * result so the SA relays the data consequence to the
								 * user, never silently. */
								const parkedNote = ctx.consumeParkedNote?.();
								if (
									parkedNote !== undefined &&
									typeof outcome.result === "object" &&
									outcome.result !== null &&
									"message" in outcome.result &&
									typeof (outcome.result as { message: unknown }).message ===
										"string"
								) {
									return {
										...outcome.result,
										message: `${(outcome.result as { message: string }).message}\n\n${parkedNote}`,
									};
								}
								return outcome.result;
							}
						}
					} catch (err) {
						/* A RETRYABLE conflict — a peer deleted/changed what this
						 * tool targeted between our read and the commit. Surface the
						 * standard `{ error }` envelope to the SA AND reload fresh so
						 * the next tool builds on the current server state, not the
						 * stale closure doc. The reload is one atomic authorized
						 * snapshot, and its Project must still match the run's admitted
						 * scope before the closure adopts the blueprint. (A
						 * pre-commit validity finding does NOT throw — the tool
						 * returns its own `{ error }` and nothing reloads. Terminal
						 * `AppProjectChangedError` and `CommitReauthError` signals are
						 * NOT caught here: both propagate and fail the run, since the
						 * former must not reload across tenant scope and the latter
						 * cannot restore authorization by reloading.) */
						if (err instanceof BlueprintCommitRejectedError) {
							let fresh: Awaited<
								ReturnType<typeof resolveAuthorizedAppSnapshot>
							>;
							try {
								fresh = await resolveAuthorizedAppSnapshot(
									ctx.appId,
									ctx.userId,
									"edit",
								);
							} catch (reloadError) {
								if (reloadError instanceof AppAccessError) {
									const scopeError = new CommitReauthError(
										"You no longer have edit access.",
									);
									ctx.latchTerminalScopeError(scopeError);
									throw scopeError;
								}
								throw reloadError;
							}
							if (fresh.projectId !== ctx.projectId) {
								const scopeError = new AppProjectChangedError();
								ctx.latchTerminalScopeError(scopeError);
								throw scopeError;
							}
							doc = hydratePersistedBlueprint(
								fresh.app.blueprint as PersistableDoc,
							);
							return { error: err.message };
						}
						/* Read-shaped tools can still own external side effects
						 * (currently media deletion). Preserve every authoritative
						 * fence as the same terminal latch a guarded blueprint
						 * commit sets. */
						if (err instanceof RunHolderLostError) {
							ctx.latchRunHolderLost(err);
						} else if (err instanceof MutationBatchIdCollisionError) {
							// A reused batch id is our protocol failure. Latching ends the
							// run: a bare throw becomes a `tool-error` part, which the model
							// reads as retryable and answers by calling again with a fresh
							// server-minted id — the exact loop this exists to stop.
							ctx.latchBatchIdCollision(err);
						} else if (
							err instanceof CommitReauthError ||
							err instanceof AppProjectChangedError
						) {
							ctx.latchTerminalScopeError(err);
						}
						throw err;
					}
				}),
		};
	}

	// `askQuestions` is the one client-side tool, so it intentionally does not
	// appear in the SA/MCP registry. Every executable shared tool comes directly
	// from that registry; the SA and MCP cannot carry divergent module lists.
	const sharedTools = {
		// `askQuestions` is the one client-side tool — no `execute`, the
		// agent stops for user input when the model calls it. Kept as a
		// bare `{ description, inputSchema }` object so the AI SDK can
		// still register the schema without wiring a server handler.
		askQuestions: {
			description: askQuestionsTool.description,
			inputSchema: wire(askQuestionsTool.inputSchema),
			strict: false,
		},
		...Object.fromEntries(
			SHARED_TOOL_REGISTRY.map(({ saName, tool }) => [
				saName,
				wrapShared(tool),
			]),
		),
	};

	// ── Build agent ──────────────────────────────────────────────────
	// One tool set for both modes (generateSchema included — it's how a
	// new case type enters an existing app too). There is no finishing
	// tool — the route finalizes a build when the run's drain ends.

	const agent = new ToolLoopAgent({
		// Build and edit run the same model at different reasoning efforts:
		// a ground-up build reasons at the ceiling, an edit of an existing
		// app at medium (`SA_BUILD_REASONING` / `SA_EDIT_REASONING`).
		model: ctx.model(editing ? SA_EDIT_MODEL : SA_BUILD_MODEL),
		// The doc picks the build-vs-edit branch and contributes no bytes —
		// both prompts are static so the provider's exact-prefix cache
		// survives doc mutations. The current blueprint summary rides
		// the per-turn message the route appends (`buildAppStateMessage`).
		instructions: buildSolutionsArchitectPrompt(editing ? doc : undefined),
		stopWhen: stepCountIs(80),
		/* Provider 5xx / 429 at request establishment retries with the SDK's
		 * exponential backoff — 5 attempts (~30s of patience) instead of the
		 * default 3, so a brief provider outage rides through rather than
		 * failing + refunding the run. Mid-stream failures are past the SDK's
		 * retry layer; the chat route's turn-level re-run (`lib/agent/turnRetry`)
		 * owns those. */
		maxRetries: 4,
		prepareStep: () => {
			// A tool execution error is a non-fatal AI SDK content part. Stop the
			// loop explicitly once an authoritative scope error has been latched;
			// otherwise the SDK would ask the model for another step in a run whose
			// every future commit is guaranteed to fail.
			throwIfTerminalRunError();
			// The canonical reasoning literal
			// (`lib/models.ts::reasoningProviderOptions`) — effort plus the
			// streamed reasoning summaries the live-thinking feed needs, plus
			// the SA's per-app prompt-cache configuration (key + options; the
			// route's `markStablePrefixBoundary` marker is the third piece of
			// the documented triple — see the helper's doc).
			return {
				providerOptions: reasoningProviderOptions(
					(editing ? SA_EDIT_REASONING : SA_BUILD_REASONING).effort,
					{ promptCacheKey: `nova:app:${ctx.appId}` },
				),
			};
		},
		onStepEnd: (step) => {
			/* Delegate step-level fan-out (usage + conversation events +
			 * tool-call counting) to the shared handler on GenerationContext.
			 * We map the AI SDK's step-finish argument into the normalized
			 * AgentStep shape here so the handler stays SDK-version stable.
			 * `toolResults` is loosely typed by the SDK — narrow at the
			 * boundary rather than inside the shared helper. Tool failures
			 * (invalid input / execution throw) arrive as `tool-error`
			 * content parts, NOT in `toolResults`; pull them out so the
			 * handler can log the error instead of dropping it. */
			ctx.handleAgentStep(
				{
					usage: step.usage,
					text: step.text,
					reasoningText: step.reasoningText,
					toolCalls: step.toolCalls?.map((tc) => ({
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						input: tc.input,
					})),
					toolResults: step.toolResults,
					toolErrors: step.content.flatMap((part) =>
						part.type === "tool-error"
							? [{ toolCallId: part.toolCallId, error: part.error }]
							: [],
					),
					warnings: step.warnings,
				},
				"Solutions Architect",
			);
		},
		tools: sharedTools,
	});

	return agent;
}
