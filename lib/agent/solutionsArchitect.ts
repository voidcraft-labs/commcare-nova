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
 * The SA owns no document: a `CanonicalMutationWorkspace` over the
 * GenerationContext host holds the current `BlueprintDoc`, serializes every
 * tool invocation by a synchronously allocated ordinal, and adopts each
 * commit's (or conflict reload's) authoritative snapshot — see
 * `lib/agent/workspace/`. Stream-event payloads carry fine-grained
 * `data-mutations` events the host emits after each canonical commit. There
 * is no finishing tool: the chat route finalizes a build at drain end
 * (status flip + case-store materialize + the `data-done` signal).
 */
import { type FlexibleSchema, stepCountIs, ToolLoopAgent } from "ai";
import type { ZodType } from "zod";
import { projectModelHistoryFromNewestCompaction } from "@/lib/chat/compaction";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import type { BlueprintDoc } from "@/lib/domain";
import {
	reasoningProviderOptions,
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
import { CanonicalMutationWorkspace } from "./workspace/canonicalWorkspace";

// ── Solutions Architect Agent ────────────────────────────────────────

/** The AI SDK invokes each tool's `execute(input, options)`; `toolCallId` is
 *  the only option the wrapper reads (it becomes the invocation's stable
 *  request id). Typed structurally so the wrapper survives SDK minor bumps. */
interface ToolCallOptionsLike {
	toolCallId?: string;
}

/**
 * Create the Solutions Architect agent — the direct canonical EDIT executor.
 * A chat BUILD never mounts it: the design pipeline's orchestrator and slice
 * executor (`lib/agent/build/`) own new-app construction, so the SA always
 * runs the edit prompt over an app's current persisted state (the blueprint
 * summary arrives as a per-turn message the route appends).
 *
 * @param initialDoc - The workspace's starting `BlueprintDoc`: the app's
 *   current state loaded from Postgres.
 */
export function createSolutionsArchitect(
	ctx: GenerationContext,
	initialDoc: BlueprintDoc,
) {
	/* The workspace owns the current document and the invocation order.
	 *
	 * The AI SDK invokes parallel `tool_use` blocks from one assistant turn
	 * concurrently via `Promise.all(toolCalls.map(...))`. `workspace.invoke`
	 * allocates each invocation's ordinal SYNCHRONOUSLY at entry — before any
	 * await — and runs bodies strictly in that order, so every body observes
	 * the doc as left by the previous one, and each commit builds on the last
	 * (the data-loss race the retired closure doc suffered is structurally
	 * gone). The ordinal captures DISPATCH order: bodies provably start in
	 * the order `invoke` was called (`canonicalWorkspace.ts` throws on an
	 * out-of-order start), but whether dispatch order matches MODEL-EMIT
	 * order still depends on the SDK calling each tool's `execute` without
	 * per-branch awaits upstream of this wrapper — the same boundary caveat
	 * as before. A lifecycle hook that awaits per branch can reorder
	 * SIBLING calls' dispatch (a dependent parent lookup then misses — a
	 * visible tool error, never a corrupted document), which is why
	 * ordering-dependent creation rides single batched calls. Each commit
	 * adopts the writer's committed doc; an authoritative conflict adopts
	 * one fresh authorized snapshot via the host's reload. */
	const workspace = new CanonicalMutationWorkspace({
		host: ctx,
		initialDoc,
	});

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
	 * `data`, mutations expose `result`; the workspace (not the wrapper) owns
	 * the working document. This makes it impossible to add, remove, rename, or
	 * replace a shared tool on only one surface.
	 */
	function wrapShared(entry: SharedToolRegistryEntry) {
		const { saName, tool: t } = entry;
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
			execute: async (input: unknown, options?: ToolCallOptionsLike) => {
				try {
					return await workspace.invoke({
						toolName: saName,
						...(options?.toolCallId !== undefined && {
							requestId: options.toolCallId,
						}),
						execute: async (invocationCtx) => {
							throwIfTerminalRunError();
							try {
								const outcome = await t.execute(input, invocationCtx);
								switch (outcome.kind) {
									case "read":
										return outcome.data;
									case "mutate": {
										/* A committed row migration that PARKED saved case values
										 * stashed a note on the host — append it to a
										 * message-bearing result so the SA relays the data
										 * consequence to the user, never silently. */
										const parkedNote = ctx.consumeParkedNote?.();
										if (
											parkedNote !== undefined &&
											typeof outcome.result === "object" &&
											outcome.result !== null &&
											"message" in outcome.result &&
											typeof (outcome.result as { message: unknown })
												.message === "string"
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
								/* Read-shaped tools can still own external side effects
								 * (currently media deletion). Preserve every authoritative
								 * fence as the same terminal latch a guarded blueprint
								 * commit sets. (A commit-path terminal error was already
								 * latched by the host; the `??=` latches make this
								 * idempotent.) */
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
						},
					});
				} catch (err) {
					/* A RETRYABLE conflict — a peer deleted/changed what this tool
					 * targeted between its snapshot and the commit. The WORKSPACE
					 * already adopted one fresh authorized snapshot (through the
					 * host's reload, whose Project must still match the run's
					 * admitted scope), so the next tool builds on current server
					 * state; here the failure surfaces to the SA as the standard
					 * `{ error }` envelope. Terminal signals — lost access, moved
					 * Project, lost holder, batch-id collision — are NOT caught:
					 * they propagate (latched above) and fail the run. */
					if (err instanceof BlueprintCommitRejectedError) {
						return { error: err.message };
					}
					throw err;
				}
			},
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
			SHARED_TOOL_REGISTRY.map((entry) => [entry.saName, wrapShared(entry)]),
		),
	};

	// ── Build agent ──────────────────────────────────────────────────
	// One tool set for both modes (generateSchema included — it's how a
	// new case type enters an existing app too). There is no finishing
	// tool — the route finalizes a build when the run's drain ends.

	const agent = new ToolLoopAgent({
		model: ctx.model(SA_EDIT_MODEL),
		// The prompt is static and contributes no per-app bytes, so the
		// provider's exact-prefix cache survives doc mutations. The current
		// blueprint summary rides the per-turn message the route appends
		// (`buildAppStateMessage`).
		instructions: buildSolutionsArchitectPrompt(),
		stopWhen: stepCountIs(80),
		/* Provider 5xx / 429 at request establishment retries with the SDK's
		 * exponential backoff — 5 attempts (~30s of patience) instead of the
		 * default 3, so a brief provider outage rides through rather than
		 * failing + refunding the run. Mid-stream failures are past the SDK's
		 * retry layer; the chat route's turn-level re-run (`lib/agent/turnRetry`)
		 * owns those. */
		maxRetries: 4,
		prepareStep: ({ messages }) => {
			// A tool execution error is a non-fatal AI SDK content part. Stop the
			// loop explicitly once an authoritative scope error has been latched;
			// otherwise the SDK would ask the model for another step in a run whose
			// every future commit is guaranteed to fail.
			throwIfTerminalRunError();
			// The canonical reasoning literal
			// (`lib/models.ts::reasoningProviderOptions`) — effort plus the
			// streamed reasoning summaries the live-thinking feed needs, plus
			// the SA's stable per-app cache affinity (key + options). The route adds
			// one request-local explicit boundary before its volatile state tail;
			// that metadata does not alter the model-visible transcript.
			return {
				messages: projectModelHistoryFromNewestCompaction(messages),
				providerOptions: reasoningProviderOptions(SA_EDIT_REASONING.effort, {
					promptCacheKey: `nova:app:${ctx.appId}`,
				}),
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
				SA_EDIT_MODEL,
			);
		},
		tools: sharedTools,
	});

	return agent;
}
