/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * Tools are split into two groups: **generation** (schema, scaffold, columns) and
 * **shared** (conversation, read, mutation, validation). In edit mode (existing app),
 * generation tools are excluded — the SA only gets shared tools and an editing prompt
 * with a blueprint summary. In build mode (new app), all tools are available.
 *
 * Vocabulary is domain-native: tool arguments, return shapes, and the
 * system prompt all use `field` / `kind` / `validate` / `validate_msg` /
 * `case_property_on`. Tool args flow straight into the reducer helpers in
 * `blueprintHelpers.ts`. `validateAndFix` (in `validationLoop.ts`) reads
 * the normalized doc directly, runs XForm validation via
 * `lib/commcare/`, and returns a normalized doc with any auto-fixes
 * applied.
 *
 * Stream-event payloads carry fine-grained `data-mutations` events
 * emitted via `ctx.recordMutations` for every tool-level change; the
 * final `data-done` from `validateApp` carries a normalized doc snapshot.
 */
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { type FlexibleSchema, stepCountIs, ToolLoopAgent, tool } from "ai";
import { completeApp } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import { SA_MODEL, SA_REASONING } from "@/lib/models";
import type { GenerationContext } from "./generationContext";
import { buildSolutionsArchitectPrompt } from "./prompts";
import type { ToolExecutionContext } from "./toolExecutionContext";
import { addFieldTool } from "./tools/addField";
import { addFieldsTool } from "./tools/addFields";
import { addModuleTool } from "./tools/addModule";
import { askQuestionsTool } from "./tools/askQuestions";
import type { MutatingToolResult, ReadToolResult } from "./tools/common";
import { createFormTool } from "./tools/createForm";
import { createModuleTool } from "./tools/createModule";
import { editFieldTool } from "./tools/editField";
import { generateScaffoldTool } from "./tools/generateScaffold";
import { generateSchemaTool } from "./tools/generateSchema";
import { getFieldTool } from "./tools/getField";
import { getFormTool } from "./tools/getForm";
import { getModuleTool } from "./tools/getModule";
import { removeFieldTool } from "./tools/removeField";
import { removeFormTool } from "./tools/removeForm";
import { removeModuleTool } from "./tools/removeModule";
import { searchBlueprintTool } from "./tools/searchBlueprint";
import { updateFormTool } from "./tools/updateForm";
import { updateModuleTool } from "./tools/updateModule";
import { validateAppTool } from "./tools/validateApp";

export { validateAndFix } from "./validationLoop";

/**
 * Names of SA tools exposed only in build mode. Declared as string
 * literals so the array is module-scope (the concrete tool record lives
 * inside the factory closure, bound to `ctx` and `doc`).
 *
 * The chat route uses this list to strip build-only tool-use parts from
 * message history on edit-mode requests — Anthropic rejects any tool
 * reference whose name isn't in the current tools array, and a
 * mid-session edit right after a build would otherwise carry these
 * references in its history.
 *
 * `BuildOnlyToolName` pins the list to its literal values; the factory
 * applies a matching `satisfies Record<BuildOnlyToolName, …>` to its
 * generation-tool record so a rename on either side breaks compilation
 * on the other.
 */
export const BUILD_ONLY_TOOL_NAMES = [
	"generateSchema",
	"generateScaffold",
	"addModule",
] as const;

type BuildOnlyToolName = (typeof BUILD_ONLY_TOOL_NAMES)[number];

// ── Solutions Architect Agent ────────────────────────────────────────

/**
 * Create the Solutions Architect agent.
 *
 * @param initialDoc - The SA's starting `BlueprintDoc`. On initial builds
 *   this is the empty doc created by `createApp`; during edits it's the
 *   app's current state loaded from Firestore. The SA owns this doc for
 *   the lifetime of the agent — every tool call mutates it in place.
 * @param editing - True when the app already exists (appReady). The SA gets
 *   the editing preamble + blueprint summary in its prompt and only has access
 *   to read + mutation + validation tools. False during initial builds, where
 *   the SA gets the full tool set and build-mode prompt.
 */
export function createSolutionsArchitect(
	ctx: GenerationContext,
	initialDoc: BlueprintDoc,
	editing = false,
) {
	/* Internal working doc — read + reassigned on every tool call.
	 *
	 * Mutation persistence (SSE + event log + Firestore) happens inside
	 * each extracted tool module via `ctx.recordMutations`. The wrappers
	 * below only reassign `doc` when the extracted tool's `mutations`
	 * array is non-empty, so the next tool call in the same request sees
	 * post-mutation state for its positional-index lookups. Wire-format
	 * snapshots are generated on demand for LLM-facing outputs and for
	 * the CommCare validator. */
	let doc: BlueprintDoc = initialDoc;

	/**
	 * Wrap an extracted mutating-tool module into the AI SDK tool-shape
	 * the `ToolLoopAgent` expects.
	 *
	 * Closes over the factory's `ctx` and mutable `doc` binding so each
	 * wrapper entry in the tool sets below collapses to `wrapMutating(x)`.
	 * The mutations are already persisted by the extracted tool's
	 * `ctx.recordMutations(...)` call before it returns; this helper's only
	 * job is to advance the SA's working-doc closure when the batch was
	 * non-empty, so the next tool call sees updated index → uuid
	 * resolution. Empty batches leave `doc` alone — matters for success
	 * branches that don't change state (e.g. the survey-only module
	 * branch in `addModule`).
	 *
	 * The generic input type `I` is carried through `FlexibleSchema<I>` so
	 * the returned `execute` callback hands the exact Zod-output type to
	 * the shared tool module — no `unknown` fallback. `strict` is
	 * forwarded only when the tool module declares it; omitting the key
	 * leaves the AI SDK's own default in place.
	 *
	 * Returns a plain object literal rather than routing through `tool()`:
	 * the AI SDK's `tool()` function is identity at runtime (`(t) => t`)
	 * and exists only for type inference. Inside this generic helper the
	 * `tool()` overload resolver can't bind its own `INPUT`/`OUTPUT` type
	 * params because `R` stays abstract until each concrete call site —
	 * `wrapMutating(addFieldsTool)`, etc. — lands on the agent's
	 * `tools` record, at which point structural inference on the
	 * `ToolSet` accepts the object without further annotation.
	 */
	function wrapMutating<I, R>(t: {
		description: string;
		inputSchema: FlexibleSchema<I>;
		strict?: boolean;
		execute(
			input: I,
			ctx: ToolExecutionContext,
			doc: BlueprintDoc,
		): Promise<MutatingToolResult<R>>;
	}) {
		return {
			description: t.description,
			inputSchema: t.inputSchema,
			...(t.strict !== undefined && { strict: t.strict }),
			execute: async (input: I) => {
				/* `kind: "mutate"` discriminator is internal to the shared
				 * tool contract — the chat-side AI SDK tool surface only
				 * sees `result`. Destructure-and-discard. */
				const { mutations, newDoc, result } = await t.execute(input, ctx, doc);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		};
	}

	/**
	 * Wrap an extracted read-only tool module into the AI SDK tool-shape.
	 * Reads the working doc and returns the tool's result; the SA's
	 * closure is never advanced (reads don't mutate state).
	 *
	 * Separate from `wrapMutating` because read tools return a
	 * `ReadToolResult<R>` envelope — the `kind: "read"` discriminator is
	 * the contract the MCP adapter dispatches on; the chat-side wrapper
	 * unwraps `data` so the AI SDK tool surface still sees the bare
	 * payload the model expects.
	 */
	function wrapRead<I, R>(t: {
		description: string;
		inputSchema: FlexibleSchema<I>;
		execute(
			input: I,
			ctx: ToolExecutionContext,
			doc: BlueprintDoc,
		): Promise<ReadToolResult<R>>;
	}) {
		return {
			description: t.description,
			inputSchema: t.inputSchema,
			execute: async (input: I) => {
				/* `kind: "read"` discriminator is internal to the shared
				 * tool contract — the AI SDK tool surface sees the bare
				 * `data`. Unwrap. */
				const { data } = await t.execute(input, ctx, doc);
				return data;
			},
		};
	}

	// ── Generation tools (build mode only) ────────────────────────────
	// These drive the initial build sequence: schema → scaffold → columns → fields.
	// Excluded in edit mode — the SA uses mutation tools instead.
	//
	// `satisfies Record<BuildOnlyToolName, unknown>` ties the record's keys
	// to `BUILD_ONLY_TOOL_NAMES`: adding, removing, or renaming a key
	// (without updating the module-scope list) is a compile error. That
	// keeps the chat route's history-strip filter aligned with whatever
	// the factory actually registers.

	const generationTools = {
		generateSchema: wrapMutating(generateSchemaTool),
		generateScaffold: wrapMutating(generateScaffoldTool),
		addModule: wrapMutating(addModuleTool),
	} satisfies Record<BuildOnlyToolName, unknown>;

	// ── Shared tools (all modes) ─────────────────────────────────────
	// Conversation, batch add, read, mutation, and validation tools.

	const sharedTools = {
		// `askQuestions` is the one client-side tool — no `execute`, the
		// agent stops for user input when the model calls it. Kept as a
		// bare `{ description, inputSchema }` object so the AI SDK can
		// still register the schema without wiring a server handler.
		askQuestions: {
			description: askQuestionsTool.description,
			inputSchema: askQuestionsTool.inputSchema,
		},

		addFields: wrapMutating(addFieldsTool),

		// ── Read ────────────────────────────────────────────────────────

		searchBlueprint: wrapRead(searchBlueprintTool),
		getModule: wrapRead(getModuleTool),
		getForm: wrapRead(getFormTool),
		getField: wrapRead(getFieldTool),

		// ── Field mutations ────────────────────────────────────────

		editField: wrapMutating(editFieldTool),
		addField: wrapMutating(addFieldTool),
		removeField: wrapMutating(removeFieldTool),

		// ── Structural mutations ──────────────────────────────────────

		updateModule: wrapMutating(updateModuleTool),
		updateForm: wrapMutating(updateFormTool),
		createForm: wrapMutating(createFormTool),
		removeForm: wrapMutating(removeFormTool),
		createModule: wrapMutating(createModuleTool),
		removeModule: wrapMutating(removeModuleTool),

		// ── Validation ────────────────────────────────────────────────

		/* `validateApp` stays bespoke because its wrapper layers two
		 * chat-only side effects on top of the flat shared result: the
		 * final `data-done` SSE part carrying the full doc + HQ JSON, and
		 * the `completeApp` Firestore update that flips the app record to
		 * its final state. Both side effects depend on `ctx.usage.runId`
		 * and `ctx.emit`, which only exist on `GenerationContext` — so
		 * they can't live inside the shared tool module. */
		validateApp: tool({
			description: validateAppTool.description,
			inputSchema: validateAppTool.inputSchema,
			execute: async (input) => {
				const result = await validateAppTool.execute(input, ctx, doc);
				// Advance the working doc unconditionally — `validateAndFix`
				// returns the post-loop doc even on failure so later tool
				// calls see whatever partial fixes the registry applied
				// before stopping.
				doc = result.doc;

				if (result.success) {
					const persistable = toPersistableDoc(doc);
					ctx.emit("data-done", {
						doc: persistable,
						hqJson: result.hqJson ?? {},
						success: true,
					});
					/* Flip the app record to its final state (fire-and-forget).
					 * The app doc was created at the start of the request by
					 * the route handler; `ctx.appId` is always present by
					 * construction. `completeApp` accepts `PersistableDoc`,
					 * so we pass the already-computed persistable value.
					 * `ctx.usage.runId` is the shared run id the event log
					 * already carries. */
					completeApp(ctx.appId, persistable, ctx.usage.runId).catch((err) =>
						log.error("[validateApp] app update failed", err),
					);
					return { success: true as const };
				}
				return {
					success: false as const,
					errors: result.errors ?? [],
				};
			},
		}),
	};

	// ── Compose tools and build agent ────────────────────────────────
	// Edit mode: only shared tools (read + mutation + validate).
	// Build mode: shared tools + generation tools (schema → scaffold → columns).

	const tools = editing ? sharedTools : { ...sharedTools, ...generationTools };

	const agent = new ToolLoopAgent({
		model: ctx.model(SA_MODEL),
		// The prompt summary is rendered from the current normalized doc
		// when the app already exists. `buildSolutionsArchitectPrompt`
		// walks the normalized doc directly and produces a domain-vocab
		// summary.
		instructions: buildSolutionsArchitectPrompt(editing ? doc : undefined),
		stopWhen: stepCountIs(80),
		prepareStep: () => {
			// Adaptive thinking with `display: 'summarized'` is required on Opus 4.7
			// for human-readable thinking summaries to stream back. `effort` is a
			// top-level provider option (sibling of `thinking`), not nested inside
			// it — Zod silently strips nested unknown fields.
			const anthropic: AnthropicProviderOptions = {
				cacheControl: { type: "ephemeral" },
				thinking: { type: "adaptive", display: "summarized" },
				effort: SA_REASONING.effort,
			};
			return { providerOptions: { anthropic } };
		},
		onStepFinish: (step) => {
			/* Delegate step-level fan-out (usage + conversation events +
			 * tool-call counting) to the shared handler on GenerationContext.
			 * We map the AI SDK's step-finish argument into the normalized
			 * AgentStep shape here so the handler stays SDK-version stable.
			 * `toolResults` is loosely typed by the SDK — narrow at the
			 * boundary rather than inside the shared helper. */
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
					warnings: step.warnings,
				},
				"Solutions Architect",
			);
		},
		tools,
	});

	return agent;
}
