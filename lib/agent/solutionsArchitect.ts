/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * ONE shared tool set serves both modes: conversation, the data-model
 * tool (`generateSchema` — a build's first commit, and how a new case
 * type enters an existing app), reads, mutations, case-list /
 * case-search config, media. Build vs edit picks the prompt (an edit
 * prompt carries the blueprint summary) and the model — never the tool
 * set.
 *
 * Vocabulary is domain-native: tool arguments, return shapes, and the
 * system prompt all use `field` / `kind` / `validate` / `validate_msg` /
 * `case_property_on`. Tool args flow straight into the reducer helpers in
 * `blueprintHelpers.ts`.
 *
 * Stream-event payloads carry fine-grained `data-mutations` events
 * emitted via `ctx.recordMutations` for every tool-level change. There is
 * no finishing tool: the chat route finalizes a build at drain end
 * (status flip + case-store materialize + the `data-done` signal).
 */
import { type FlexibleSchema, stepCountIs, ToolLoopAgent } from "ai";
import type { ZodType } from "zod";
import { loadApp } from "@/lib/db/apps";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import {
	reasoningProviderOptions,
	SA_BUILD_MODEL,
	SA_EDIT_MODEL,
	SA_REASONING,
} from "@/lib/models";
import type { GenerationContext } from "./generationContext";
import { buildSolutionsArchitectPrompt } from "./prompts";
import type { ToolExecutionContext } from "./toolExecutionContext";
import { addFieldsTool } from "./tools/addFields";
import { askQuestionsTool } from "./tools/askQuestions";
import { addCaseListColumnsTool } from "./tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "./tools/case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "./tools/case-list-config/removeCaseListColumn";
import { removeSearchInputTool } from "./tools/case-list-config/removeSearchInput";
import { reorderCaseListColumnsTool } from "./tools/case-list-config/reorderCaseListColumns";
import { reorderSearchInputsTool } from "./tools/case-list-config/reorderSearchInputs";
import { setCaseListFilterTool } from "./tools/case-list-config/setCaseListFilter";
import { updateCaseListColumnTool } from "./tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "./tools/case-list-config/updateSearchInput";
import { setCaseSearchAdvancedTool } from "./tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "./tools/case-search-config/setCaseSearchDisplay";
import type { MutatingToolResult, ReadToolResult } from "./tools/common";
import { createFormTool } from "./tools/createForm";
import { createModuleTool } from "./tools/createModule";
import { editFieldTool } from "./tools/editField";
import { generateSchemaTool } from "./tools/generateSchema";
import { getFieldTool } from "./tools/getField";
import { getFormTool } from "./tools/getForm";
import { getModuleTool } from "./tools/getModule";
import { attachFieldMediaTool } from "./tools/media/attachFieldMedia";
import { attachOptionMediaTool } from "./tools/media/attachOptionMedia";
import { listMediaAssetsTool } from "./tools/media/listMediaAssets";
import { removeMediaAssetTool } from "./tools/media/removeMediaAsset";
import { setAppLogoTool } from "./tools/media/setAppLogo";
import { setMenuMediaTool } from "./tools/media/setMenuMedia";
import { removeFieldTool } from "./tools/removeField";
import { removeFormTool } from "./tools/removeForm";
import { removeModuleTool } from "./tools/removeModule";
import { searchBlueprintTool } from "./tools/searchBlueprint";
import { updateAppTool } from "./tools/updateApp";
import { updateFormTool } from "./tools/updateForm";
import { updateModuleTool } from "./tools/updateModule";
import { wireToolSchema } from "./wireSchemas";

// ── Solutions Architect Agent ────────────────────────────────────────

/**
 * Create the Solutions Architect agent.
 *
 * @param initialDoc - The SA's starting `BlueprintDoc`. On initial builds
 *   this is the empty doc created by `createApp`; during edits it's the
 *   app's current state loaded from Postgres. The SA owns this doc for
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
	 * tool doesn't poison the chain for subsequent calls; the `next`
	 * promise still rejects to its caller, preserving error visibility at
	 * the AI SDK boundary (it's converted to a `tool-error` content
	 * part). */
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
	 * branches that don't change state.
	 *
	 * The generic input type `I` is carried through `FlexibleSchema<I>` so
	 * the returned `execute` callback hands the exact Zod-output type to
	 * the shared tool module — no `unknown` fallback.
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
	/** Chat-surface wire projection — AST stubs on the wire, full Zod
	 *  validation intact (`wireSchemas.ts`). Every SA tool is Zod-schema'd,
	 *  so the cast holds. */
	function wire<I>(schema: FlexibleSchema<I>): FlexibleSchema<I> {
		return wireToolSchema(schema as ZodType<I>);
	}

	function wrapMutating<I, R>(t: {
		description: string;
		inputSchema: FlexibleSchema<I>;
		execute(
			input: I,
			ctx: ToolExecutionContext,
			doc: BlueprintDoc,
		): Promise<MutatingToolResult<R>>;
	}) {
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
			execute: (input: I) =>
				serial(async () => {
					try {
						/* `kind: "mutate"` discriminator is internal to the shared
						 * tool contract — the chat-side AI SDK tool surface only
						 * sees `result`. Destructure-and-discard. On success the SA
						 * continues against `newDoc` — the guarded writer's committed
						 * doc, which may carry a peer's concurrent edit merged in. */
						const { mutations, newDoc, result } = await t.execute(
							input,
							ctx,
							doc,
						);
						if (mutations.length > 0) doc = newDoc;
						return result;
					} catch (err) {
						/* A RETRYABLE conflict — a peer deleted/changed what this
						 * tool targeted, or the app moved Projects, between our read
						 * and the commit. Surface the standard `{ error }` envelope
						 * to the SA AND reload fresh so the next tool builds on the
						 * current server state, not the stale closure doc. (A
						 * pre-commit validity finding does NOT throw — the tool
						 * returns its own `{ error }` and nothing reloads. A terminal
						 * `CommitReauthError` — the actor lost access — is NOT caught
						 * here: it propagates and fails the run, since reloading can't
						 * restore authorization.) */
						if (err instanceof BlueprintCommitRejectedError) {
							const fresh = await loadApp(ctx.appId);
							if (fresh) {
								doc = hydratePersistedBlueprint(
									fresh.blueprint as PersistableDoc,
								);
							}
							return { error: err.message } as R;
						}
						throw err;
					}
				}),
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
			inputSchema: wire(t.inputSchema),
			// Same strict-mode opt-out as `wrapMutating` — see the note there.
			strict: false,
			execute: (input: I) =>
				serial(async () => {
					/* `kind: "read"` discriminator is internal to the shared
					 * tool contract — the AI SDK tool surface sees the bare
					 * `data`. Unwrap. */
					const { data } = await t.execute(input, ctx, doc);
					return data;
				}),
		};
	}

	// ── Shared tools (all modes) ─────────────────────────────────────
	// Conversation, batch add, read, mutation, and validation tools.

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

		addFields: wrapMutating(addFieldsTool),

		// ── Data model ─────────────────────────────────────────────────
		// Commits the case-type catalog (and the app name) onto the doc —
		// a build's first call, and how a NEW case type enters an existing
		// app. `createModule` references the recorded types by name.

		generateSchema: wrapMutating(generateSchemaTool),

		// ── Read ────────────────────────────────────────────────────────

		searchBlueprint: wrapRead(searchBlueprintTool),
		getModule: wrapRead(getModuleTool),
		getForm: wrapRead(getFormTool),
		getField: wrapRead(getFieldTool),

		// ── Field mutations ────────────────────────────────────────

		editField: wrapMutating(editFieldTool),
		removeField: wrapMutating(removeFieldTool),

		// ── Structural mutations ──────────────────────────────────────

		updateApp: wrapMutating(updateAppTool),
		updateModule: wrapMutating(updateModuleTool),
		updateForm: wrapMutating(updateFormTool),
		createForm: wrapMutating(createFormTool),
		removeForm: wrapMutating(removeFormTool),
		createModule: wrapMutating(createModuleTool),
		removeModule: wrapMutating(removeModuleTool),

		// ── Case list config mutations ─────────────────────────────────
		// Two arrays (`columns`, `searchInputs`) decompose into atomic
		// add / update / remove / reorder ops; the `filter` slot stays
		// wholesale (one Predicate). Each atomic mutation tool returns
		// the affected uuid both in the success message and in a
		// structured `result.uuid` field so the SA can target follow-
		// up edits without re-reading. Atomic ops route their array-
		// walk through the case-list mutation builders in
		// `blueprintHelpers.ts`; SA-boundary input shapes live in
		// `tools/case-list-config/shared.ts`.

		addCaseListColumns: wrapMutating(addCaseListColumnsTool),
		updateCaseListColumn: wrapMutating(updateCaseListColumnTool),
		removeCaseListColumn: wrapMutating(removeCaseListColumnTool),
		reorderCaseListColumns: wrapMutating(reorderCaseListColumnsTool),
		setCaseListFilter: wrapMutating(setCaseListFilterTool),
		addSearchInputs: wrapMutating(addSearchInputsTool),
		updateSearchInput: wrapMutating(updateSearchInputTool),
		removeSearchInput: wrapMutating(removeSearchInputTool),
		reorderSearchInputs: wrapMutating(reorderSearchInputsTool),

		// ── Case-search config mutations ──────────────────────────────
		// Two wholesale tools — one per cluster of `caseSearchConfig`.
		// `setCaseSearchDisplay` owns the search-screen labels;
		// `setCaseSearchAdvanced` owns niche search-side filters (the
		// `excludedOwnerIds` expression). Search inputs themselves
		// remain on `caseListConfig.searchInputs` (cross-bound with the
		// case-list search affordance) and are authored through the
		// existing case-list-config family — these two tools never touch
		// them.

		setCaseSearchAdvanced: wrapMutating(setCaseSearchAdvancedTool),
		setCaseSearchDisplay: wrapMutating(setCaseSearchDisplayTool),

		// ── Media authoring ───────────────────────────────────────────
		// The dedicated surface for attaching asset ids to carriers — the
		// generic mutation tools (`addFields`, `editField`,
		// case-list-config) omit every media slot, so the SA can neither
		// mint nor reference an asset id there. Four doc-mutation tools,
		// each batch-shaped where the carrier repeats (field message
		// slots / select options / module + form menu tiles / app logo)
		// plus two library tools: `listMediaAssets` discovers the asset
		// ids the others need (read), `removeMediaAsset` deletes one with
		// a live-reference guard (read-shaped — its side effect is on the
		// library, not the doc). The MCP-only `uploadMediaAsset` is not
		// here: the browser uploads through the library UI.

		attachFieldMedia: wrapMutating(attachFieldMediaTool),
		attachOptionMedia: wrapMutating(attachOptionMediaTool),
		setMenuMedia: wrapMutating(setMenuMediaTool),
		setAppLogo: wrapMutating(setAppLogoTool),
		listMediaAssets: wrapRead(listMediaAssetsTool),
		removeMediaAsset: wrapRead(removeMediaAssetTool),
	};

	// ── Build agent ──────────────────────────────────────────────────
	// One tool set for both modes (generateSchema included — it's how a
	// new case type enters an existing app too). There is no finishing
	// tool — the route finalizes a build when the run's drain ends.

	const agent = new ToolLoopAgent({
		// Build and edit run different tiers: a ground-up build gets the
		// flagship model, an edit of an existing app the mid-tier one.
		model: ctx.model(editing ? SA_EDIT_MODEL : SA_BUILD_MODEL),
		// The prompt summary is rendered from the current normalized doc
		// when the app already exists. `buildSolutionsArchitectPrompt`
		// walks the normalized doc directly and produces a domain-vocab
		// summary.
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
			// The canonical reasoning literal
			// (`lib/models.ts::reasoningProviderOptions`) — effort plus the
			// streamed reasoning summaries the live-thinking feed needs. No
			// cache option: OpenAI prompt caching is implicit (managed
			// breakpoints, 30-min TTL).
			return {
				providerOptions: reasoningProviderOptions(SA_REASONING.effort),
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
					providerMetadata: step.providerMetadata,
				},
				"Solutions Architect",
			);
		},
		tools: sharedTools,
	});

	return agent;
}
