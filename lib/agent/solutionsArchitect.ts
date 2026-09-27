/** The editor's ToolLoopAgent. Shared tools accept authored values, which are
 * bound inside the authorized private workspace before staging and publication.
 * The workspace serializes calls and preserves pending edits across turns. The
 * route owns run finalization; new-app design and construction live in build/.
 */

import {
	type FlexibleSchema,
	isStepCount,
	ToolLoopAgent,
	type ToolSet,
} from "ai";
import type { ZodType } from "zod";
import { promptCacheKeys } from "@/lib/agent/promptCacheKeys";
import { projectModelHistoryFromNewestCompaction } from "@/lib/chat/compaction";
import { AuthoringAuthorityError } from "@/lib/db/authoringSessions";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";
import type { ChatWork } from "./authoring/chatWork";
import { AuthoringInputError, ReadProjectionError } from "./authoring/errors";
import { WORK_TOOL_DEFINITIONS } from "./authoring/lifecycleTools";
import { authoringToolSchema } from "./authoring/toolSchema";
import {
	ChangeSetStagingRejectedError,
	ChangeSetWorkspaceRevisionStaleError,
} from "./change-set/errors";
import type { GenerationContext } from "./generationContext";
import { novaOpenAITools } from "./openaiProvider";
import { buildSolutionsArchitectPrompt } from "./prompts";
import {
	SHARED_TOOL_REGISTRY,
	type SharedToolRegistryEntry,
} from "./sharedToolRegistry";
import { withoutToolPresentation } from "./toolResults";
import { askQuestionsTool } from "./tools/askQuestions";
import { wireToolSchema } from "./wireSchemas";

// ── Solutions Architect Agent ────────────────────────────────────────

/** The AI SDK invokes each tool's `execute(input, options)`; `toolCallId` is
 *  the only option the wrapper reads (it becomes the invocation's stable
 *  request id). Typed structurally so the wrapper survives SDK minor bumps. */
interface ToolCallOptionsLike {
	toolCallId?: string;
}

/** Chat-surface wire projection — AST stubs on the wire, full Zod
 *  validation intact (`wireSchemas.ts`). Every SA tool is Zod-schema'd,
 *  so the cast holds. */
function wire<I>(schema: FlexibleSchema<I>): FlexibleSchema<I> {
	return wireToolSchema(schema as ZodType<I>);
}

/** Steps per turn: the tool loop stops here whatever the model wants next. */
export const SOLUTIONS_ARCHITECT_MAX_STEPS = 80;

export const EDIT_TURN_LIMIT_MESSAGE =
	"This editing turn reached its limit before I could finish. Saved checkpoints are safe and pending changes are preserved. I can continue from here.";

/** Provider 5xx / 429 at request establishment retries with the SDK's
 * exponential backoff — 5 attempts (~30s of patience) instead of the
 * default 3, so a brief provider outage rides through rather than failing +
 * refunding the run. Mid-stream failures are past the SDK's retry layer; the
 * chat route's turn-level re-run (`lib/agent/turnRetry`) owns those. */
export const SOLUTIONS_ARCHITECT_MAX_RETRIES = 4;

/** The inspection catalog and runtime use these same definitions. Shared tools
 * load through hosted search and retain omission semantics with strict: false.
 * Full canonical validation follows authored-value binding on the server. */
export function solutionsArchitectToolDefinitions(): ToolSet {
	return {
		toolSearch: novaOpenAITools.toolSearch(),
		getWork: {
			...WORK_TOOL_DEFINITIONS.getWork,
			providerOptions: { openai: { deferLoading: true } },
		},
		saveWork: {
			...WORK_TOOL_DEFINITIONS.saveWork,
			providerOptions: { openai: { deferLoading: true } },
		},
		discardWork: {
			...WORK_TOOL_DEFINITIONS.discardWork,
			providerOptions: { openai: { deferLoading: true } },
		},
		askQuestions: {
			description: askQuestionsTool.description,
			inputSchema: wire(askQuestionsTool.inputSchema),
			strict: false,
		},
		...Object.fromEntries(
			SHARED_TOOL_REGISTRY.map((entry) => [
				entry.saName,
				{
					description: entry.tool.description,
					inputSchema: authoringToolSchema(entry.saName, entry.tool.inputSchema)
						.inputSchema,
					strict: false,
					providerOptions: { openai: { deferLoading: true } },
					...(entry.policy.effect !== "read-blueprint" && {
						toModelOutput: ({ output }: { output: unknown }) => ({
							type: "text" as const,
							value: JSON.stringify(withoutToolPresentation(output)),
						}),
					}),
				},
			]),
		),
	};
}

/** The ordinary editor stages private changes in the thread's durable work.
 * Only saveWork publishes a fully valid checkpoint to the app. */
export function createSolutionsArchitect(
	ctx: GenerationContext,
	work: ChatWork,
) {
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

	const definitions = solutionsArchitectToolDefinitions();

	/**
	 * Mount one entry from the canonical shared-tool registry on the SA.
	 *
	 * The same module object is mounted on MCP from the same registry. Its
	 * result discriminator selects the chat projection at runtime: reads expose
	 * `data`, mutations expose `result`; the workspace (not the wrapper) owns
	 * the working document. This makes it impossible to add, remove, rename, or
	 * replace a shared tool on only one surface.
	 */
	function wrapShared(
		entry:
			| Pick<SharedToolRegistryEntry, "saName">
			| { saName: "getWork" | "saveWork" | "discardWork" },
	) {
		const { saName } = entry;
		const definition = definitions[saName];
		if (definition === undefined) {
			throw new Error(
				`The shared tool ${saName} has no provider definition. solutionsArchitectToolDefinitions() must list every registry entry.`,
			);
		}
		return {
			...definition,
			execute: async (input: unknown, options?: ToolCallOptionsLike) => {
				try {
					throwIfTerminalRunError();
					if (!options?.toolCallId)
						throw new Error(
							"An authoring call needs its stable tool-call identity.",
						);
					return await work.invoke(saName, input, options.toolCallId);
				} catch (err) {
					if (err instanceof AuthoringAuthorityError)
						ctx.latchTerminalScopeError(new CommitReauthError(err.message));
					else if (err instanceof RunHolderLostError)
						ctx.latchRunHolderLost(err);
					else if (err instanceof MutationBatchIdCollisionError)
						ctx.latchBatchIdCollision(err);
					else if (
						err instanceof CommitReauthError ||
						err instanceof AppProjectChangedError
					)
						ctx.latchTerminalScopeError(err);
					// Expected input or pending-work findings remain editable. Scope failures
					// stay latched and terminal; no failure silently rebases private work.
					if (
						err instanceof ChangeSetStagingRejectedError ||
						err instanceof ChangeSetWorkspaceRevisionStaleError ||
						err instanceof BlueprintCommitRejectedError ||
						err instanceof AuthoringInputError ||
						// Already recorded at the read boundary. The SA hears that the
						// read failed on Nova's side, so it does not retry with new input.
						err instanceof ReadProjectionError
					) {
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
		toolSearch: definitions.toolSearch,
		getWork: wrapShared({ saName: "getWork" }),
		saveWork: wrapShared({ saName: "saveWork" }),
		discardWork: wrapShared({ saName: "discardWork" }),
		// `askQuestions` is the one client-side tool — no `execute`, the
		// agent stops for user input when the model calls it. Kept as a
		// bare `{ description, inputSchema }` object so the AI SDK can
		// still register the schema without wiring a server handler.
		askQuestions: definitions.askQuestions,
		...Object.fromEntries(
			SHARED_TOOL_REGISTRY.map((entry) => [entry.saName, wrapShared(entry)]),
		),
	};

	// The ordinary editor owns private work for this conversation. A final
	// answer is available after publication or deliberate discard; pending
	// edits require another tool step or a question for the user.

	const agent = new ToolLoopAgent({
		model: ctx.model(MODEL_ROLES.followUpEditor.modelId),
		// The prompt is static and contributes no per-app bytes, so the
		// provider's exact-prefix cache survives doc mutations. The current
		// blueprint summary rides the per-turn message the route appends
		// (`buildWorkStateMessage`).
		instructions: buildSolutionsArchitectPrompt(),
		stopWhen: isStepCount(SOLUTIONS_ARCHITECT_MAX_STEPS),
		maxRetries: SOLUTIONS_ARCHITECT_MAX_RETRIES,
		prepareStep: async ({ messages }) => {
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
			const pending = await work.status();
			return {
				...(pending.pendingChanges > 0 && { toolChoice: "required" as const }),
				messages: projectModelHistoryFromNewestCompaction(messages),
				providerOptions: reasoningProviderOptions(
					MODEL_ROLES.followUpEditor.reasoningEffort,
					{
						promptCacheKey: promptCacheKeys.app(ctx.appId),
					},
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
				},
				"Solutions Architect",
				MODEL_ROLES.followUpEditor.modelId,
			);
		},
		tools: sharedTools,
	});

	return agent;
}
