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
 * `case_property`. Tool args flow straight into the reducer helpers in
 * `blueprintHelpers.ts`. `validateAndFix` (in `validationLoop.ts`) reads
 * the normalized doc directly, runs XForm validation via
 * `lib/commcare/`, and returns a normalized doc with any auto-fixes
 * applied.
 *
 * Stream-event payloads carry fine-grained `data-mutations` events
 * emitted via `ctx.emitMutations` for every tool-level change; the
 * final `data-done` from `validateApp` carries a normalized doc snapshot.
 */
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { errorToString } from "@/lib/commcare/validator/errors";
import { completeApp } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import { SA_MODEL, SA_REASONING } from "@/lib/models";
import { removeModuleMutations } from "./blueprintHelpers";
import type { GenerationContext } from "./generationContext";
import { buildSolutionsArchitectPrompt } from "./prompts";
import { addFieldTool } from "./tools/addField";
import { addFieldsTool } from "./tools/addFields";
import { addModuleTool } from "./tools/addModule";
import { askQuestionsTool } from "./tools/askQuestions";
import { applyToDoc } from "./tools/common";
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
import { searchBlueprintTool } from "./tools/searchBlueprint";
import { updateFormTool } from "./tools/updateForm";
import { updateModuleTool } from "./tools/updateModule";
import { validateAndFix } from "./validationLoop";

export { validateAndFix } from "./validationLoop";

/**
 * Names of SA tools exposed only in build mode. Sourced from the tool
 * modules themselves (each exports a literal-typed `name`) so a rename
 * at the tool module is the only edit needed to keep this list in sync.
 *
 * The chat route uses this list to strip build-only tool-use parts from
 * message history on edit-mode requests — Anthropic rejects any tool
 * reference whose name isn't in the current tools array, and a
 * mid-session edit right after a build would otherwise carry these
 * references in its history.
 */
export const BUILD_ONLY_TOOL_NAMES = [
	generateSchemaTool.name,
	generateScaffoldTool.name,
	addModuleTool.name,
] as const;

// ── Doc helpers ───────────────────────────────────────────────────────

/**
 * `FormSnapshot` is the domain-vocab form-plus-fields shape the SA's
 * `getForm` tool returns. The type and its builder live in
 * `blueprintHelpers.ts` alongside other positional `BlueprintDoc`
 * readers; re-exporting here lets agent-layer consumers import the
 * type from the same surface they import the SA factory.
 */
export type { FormSnapshot } from "./blueprintHelpers";

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
	// Internal doc state — the SA reads + mutates this on every tool call.
	// It's the single source of truth; wire-format snapshots are generated
	// on demand for LLM-facing outputs and for the CommCare validator.
	let doc: BlueprintDoc = initialDoc;

	/**
	 * Apply a mutation batch to the SA's working doc AND emit it on the
	 * context in one step. Every tool handler routes mutations through
	 * this helper so both steps stay atomic at the call site:
	 *
	 *   1. Compute the post-mutation doc via `applyToDoc` (Immer).
	 *   2. Emit the batch through `ctx.emitMutations(muts, newDoc, stage)`
	 *      — the SSE write + log enqueue + fire-and-forget Firestore save
	 *      all run against the SAME snapshot we're about to adopt.
	 *   3. Reassign `doc` so the next tool call reads the new state.
	 *
	 * Ordering matters: emit BEFORE reassign so no race exists between
	 * the SSE payload the client applies and the working doc we advance
	 * to. Empty batches short-circuit before any emission happens, so
	 * callers can invoke this unconditionally after a helper that may
	 * return `[]`.
	 *
	 * `stage` is required at this layer — every SA call site explicitly
	 * tags its batch. The underlying `ctx.emitMutations` leaves stage
	 * optional for callers outside the SA that don't have a meaningful
	 * tag.
	 */
	const emit = (muts: Mutation[], stage: string): void => {
		if (muts.length === 0) return;
		const newDoc = applyToDoc(doc, muts);
		ctx.emitMutations(muts, newDoc, stage);
		doc = newDoc;
	};

	// ── Generation tools (build mode only) ────────────────────────────
	// These drive the initial build sequence: schema → scaffold → columns → fields.
	// Excluded in edit mode — the SA uses mutation tools instead.
	//
	// Every mutating-tool wrapper below delegates to a shared module in
	// `./tools/`. The shared module computes mutations, emits them on SSE
	// + log, and persists via `ctx.recordMutations`. Each wrapper advances
	// the SA's working doc closure when the batch is non-empty so the next
	// tool call in the same request sees updated state for index → uuid
	// resolution.

	const generationTools = {
		generateSchema: tool({
			description: generateSchemaTool.description,
			inputSchema: generateSchemaTool.inputSchema,
			strict: generateSchemaTool.strict,
			execute: async (input) => {
				const { mutations, newDoc, result } = await generateSchemaTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		generateScaffold: tool({
			description: generateScaffoldTool.description,
			inputSchema: generateScaffoldTool.inputSchema,
			strict: generateScaffoldTool.strict,
			execute: async (input) => {
				const { mutations, newDoc, result } =
					await generateScaffoldTool.execute(input, ctx, doc);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		addModule: tool({
			description: addModuleTool.description,
			inputSchema: addModuleTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await addModuleTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),
	};

	// ── Shared tools (all modes) ─────────────────────────────────────
	// Conversation, batch add, read, mutation, and validation tools.

	const sharedTools = {
		askQuestions: {
			description: askQuestionsTool.description,
			inputSchema: askQuestionsTool.inputSchema,
			// No execute → client-side tool, agent stops for user input
		},

		addFields: tool({
			description: addFieldsTool.description,
			inputSchema: addFieldsTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await addFieldsTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		// ── Read ────────────────────────────────────────────────────────

		searchBlueprint: tool({
			description: searchBlueprintTool.description,
			inputSchema: searchBlueprintTool.inputSchema,
			execute: async (input) => searchBlueprintTool.execute(input, ctx, doc),
		}),

		getModule: tool({
			description: getModuleTool.description,
			inputSchema: getModuleTool.inputSchema,
			execute: async (input) => getModuleTool.execute(input, ctx, doc),
		}),

		getForm: tool({
			description: getFormTool.description,
			inputSchema: getFormTool.inputSchema,
			execute: async (input) => getFormTool.execute(input, ctx, doc),
		}),

		getField: tool({
			description: getFieldTool.description,
			inputSchema: getFieldTool.inputSchema,
			execute: async (input) => getFieldTool.execute(input, ctx, doc),
		}),

		// ── Field mutations ────────────────────────────────────────

		editField: tool({
			description: editFieldTool.description,
			inputSchema: editFieldTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await editFieldTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		addField: tool({
			description: addFieldTool.description,
			inputSchema: addFieldTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await addFieldTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		removeField: tool({
			description: removeFieldTool.description,
			inputSchema: removeFieldTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await removeFieldTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		// ── Structural mutations ──────────────────────────────────────

		updateModule: tool({
			description: updateModuleTool.description,
			inputSchema: updateModuleTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await updateModuleTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		updateForm: tool({
			description: updateFormTool.description,
			inputSchema: updateFormTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await updateFormTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		createForm: tool({
			description: createFormTool.description,
			inputSchema: createFormTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await createFormTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		removeForm: tool({
			description: removeFormTool.description,
			inputSchema: removeFormTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await removeFormTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		createModule: tool({
			description: createModuleTool.description,
			inputSchema: createModuleTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await createModuleTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		removeModule: tool({
			description: "Remove a module from the app.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
			}),
			execute: async ({ moduleIndex }) => {
				try {
					const moduleUuid = doc.moduleOrder[moduleIndex];
					const name = moduleUuid
						? (doc.modules[moduleUuid]?.name ?? null)
						: null;
					// Only emit + apply when the module actually exists; mirror
					// the removeForm guard for consistency.
					if (moduleUuid) {
						const muts = removeModuleMutations(doc, moduleUuid);
						emit(muts, `module:remove:${moduleIndex}`);
					}
					return `Successfully removed module "${name ?? `module ${moduleIndex}`}". App now has ${doc.moduleOrder.length} module${doc.moduleOrder.length === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		// ── Validation ────────────────────────────────────────────────

		validateApp: tool({
			description:
				"Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing. If validation fails with remaining errors, use your mutation tools (removeField, editField, etc.) to fix them, then call validateApp again.",
			inputSchema: z.object({}),
			execute: async () => {
				// `validateAndFix` owns the XForm-compiler boundary: it takes
				// our doc, runs CommCare-flavored validation + auto-fixes on a
				// blueprint snapshot, and hands back a doc with any fix-registry
				// mutations folded in. We replace our working doc with that
				// result so subsequent tool calls see the patched state.
				const result = await validateAndFix(ctx, doc);
				if (result.success) {
					doc = result.doc;

					const persistable = toPersistableDoc(doc);

					ctx.emit("data-done", {
						doc: persistable,
						hqJson: result.hqJson ?? {},
						success: true,
					});

					/* Update the app with the final validated doc (fire-and-forget).
					 * The app document was created at the start of the request by
					 * the route handler — `ctx.appId` is always present by
					 * construction. We persist the normalized doc shape directly;
					 * `completeApp` accepts `PersistableDoc`. The runId is the
					 * same value the event log uses; `UsageAccumulator` is the
					 * single source of truth. */
					completeApp(ctx.appId, persistable, ctx.usage.runId).catch((err) =>
						log.error("[validateApp] app update failed", err),
					);

					return { success: true as const };
				}
				// Keep the SA's doc aligned with the fix loop's output even on
				// failure — later tool calls should see any partial fixes the
				// registry managed to apply before giving up.
				doc = result.doc;
				// Surface remaining errors as strings so the SA can read and fix them.
				return {
					success: false as const,
					errors: (result.errors ?? []).map(errorToString),
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
		prepareStep: ({ steps: _steps }) => {
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
					toolResults:
						(step.toolResults as Array<{
							toolCallId: string;
							output: unknown;
						}>) ?? undefined,
					warnings: step.warnings,
				},
				"Solutions Architect",
			);
		},
		tools,
	});

	return agent;
}
