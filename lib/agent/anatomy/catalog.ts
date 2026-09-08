/**
 * The role catalog: one entry per model role, with the facts a reader needs
 * before the prompt text (model and effort, prompt version, cache key,
 * ledger, ceilings, strictness, call site), and the four lifecycles that
 * connect the roles on the map.
 *
 * Every fact is read from the production constant that governs it. A new
 * model role or call site registers here; `__tests__/catalog.test.ts` sweeps
 * the source tree for `MODEL_ROLES.` references so a call site this catalog
 * does not name fails the build.
 */

import { BLOCKER_RESOLUTION_ALLOWANCE } from "@/lib/agent/build/budgets";
import { EXECUTOR_PROMPT_VERSION } from "@/lib/agent/build/executorPrompt";
import {
	DESIGN_LOOP_STEP_BUDGET,
	DESIGN_ROLLOVER_STEP_ALLOWANCE,
} from "@/lib/agent/design/loop/gates";
import { DESIGN_PROMPT_VERSIONS } from "@/lib/agent/design/prompts";
import { DESIGN_REVIEWER_MAX_OUTPUT_TOKENS } from "@/lib/agent/design/reviewer";
import { EXTRACT_MAX_OUTPUT_TOKENS } from "@/lib/agent/documentExtraction";
import {
	TRANSLATION_MAX_OUTPUT_TOKENS,
	TRANSLATION_PROMPT_VERSION,
} from "@/lib/agent/translation/translator";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import {
	MODEL_ROLES,
	OPENAI_COMPACTION_THRESHOLD,
	type ReasoningEffort,
	reasoningProviderOptions,
} from "@/lib/models";
import type { AnatomyRoleId, SourceRef } from "./types";

export type ModelRoleKey = keyof typeof MODEL_ROLES;

export type LedgerKind = "durable-context" | "thread" | "none";

export type CallShape =
	/** A `ToolLoopAgent`: many steps, tools mounted, the SDK loops. */
	| "tool-loop"
	/** One model step per call; Nova's own loop decides the next. */
	| "single-step-loop"
	/** One structured-output call, no tools. */
	| "one-shot-structured"
	/** No Nova model at all: a client agent runs the prompt. */
	| "client-agent";

export interface RoleFact {
	readonly label: string;
	readonly value: string;
	/** A sentence for the tooltip, when the value alone would mislead. */
	readonly detail?: string;
}

export interface RoleFacts {
	readonly role: AnatomyRoleId;
	readonly title: string;
	/** One sentence: what this role does, in Nova's voice. */
	readonly tagline: string;
	readonly modelRole: ModelRoleKey | null;
	readonly modelId: string | null;
	readonly effort: ReasoningEffort | null;
	readonly promptVersion: string | null;
	/** The provider cache-key pattern, or null for one-shot calls. */
	readonly cacheKey: string | null;
	readonly ledger: LedgerKind;
	readonly callShape: CallShape;
	readonly toolStrictness: string;
	readonly outputStrictness: string;
	readonly ceilings: readonly RoleFact[];
	/** The primary call site. */
	readonly source: SourceRef;
}

const MODEL_LABELS: Record<string, string> = {
	"gpt-5.6-sol": "Sol",
	"gpt-5.6-luna": "Luna",
	"gpt-5.6-terra": "Terra",
};

/** "Luna" for `gpt-5.6-luna`; the raw id for anything unfamiliar. */
export function modelLabel(modelId: string): string {
	return MODEL_LABELS[modelId] ?? modelId;
}

function roleModel(key: ModelRoleKey) {
	const config = MODEL_ROLES[key];
	return {
		modelRole: key,
		modelId: config.modelId,
		effort: config.reasoningEffort,
	} as const;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export const ROLE_FACTS: Readonly<Record<AnatomyRoleId, RoleFacts>> = {
	"solutions-architect": {
		role: "solutions-architect",
		title: "Solutions architect",
		tagline:
			"Edits a complete app in conversation, one tool call at a time, against the full thread history.",
		...roleModel("followUpEditor"),
		promptVersion: null,
		cacheKey: "nova:app:<appId>",
		ledger: "thread",
		callShape: "tool-loop",
		toolStrictness: "strict: false on every tool",
		outputStrictness: "no structured output",
		ceilings: [
			{
				label: "Steps per turn",
				value: "80",
				detail: "stopWhen: stepCountIs(80) in createSolutionsArchitect.",
			},
			{
				label: "Establishment retries",
				value: "4",
				detail:
					"The SDK retries a failed request; a mid-stream fault re-drives the whole turn instead.",
			},
			{
				label: "Step pace",
				value: minutes(MODEL_ROLES.followUpEditor.msPerModelStep),
			},
		],
		source: {
			file: "lib/agent/solutionsArchitect.ts",
			symbol: "createSolutionsArchitect",
		},
	},
	"design-author": {
		role: "design-author",
		title: "Design author",
		tagline:
			"Turns the source package into a reviewed Design Contract through one durable model context.",
		...roleModel("designAuthor"),
		promptVersion: DESIGN_PROMPT_VERSIONS.agent,
		cacheKey: "nova:design:<designSessionId>",
		ledger: "durable-context",
		callShape: "tool-loop",
		toolStrictness:
			"strict: true on the 19 loop tools and waitForInput; strict: false on askQuestions",
		outputStrictness: "no structured output",
		ceilings: [
			{
				label: "Steps per session",
				value: String(DESIGN_LOOP_STEP_BUDGET),
				detail: `Plus ${DESIGN_ROLLOVER_STEP_ALLOWANCE} per contract rollover, at most two rollovers.`,
			},
			{
				label: "Compaction",
				value: `${(OPENAI_COMPACTION_THRESHOLD / 1000).toFixed(0)}k tokens`,
				detail:
					"Provider-side. After a checkpoint Nova appends a fresh state packet.",
			},
			{
				label: "Step pace",
				value: minutes(MODEL_ROLES.designAuthor.msPerModelStep),
			},
		],
		source: {
			file: "lib/agent/build/designLoopRunner.ts",
			symbol: "createDesignAgent",
		},
	},
	"design-reviewer": {
		role: "design-reviewer",
		title: "Design reviewer",
		tagline:
			"Critiques one exact contract revision from a fresh context, with no author reasoning in view.",
		...roleModel("designReviewer"),
		promptVersion: DESIGN_PROMPT_VERSIONS.reviewer,
		cacheKey: null,
		ledger: "none",
		callShape: "one-shot-structured",
		toolStrictness: "no tools",
		outputStrictness:
			"strict projection of the per-session reviewer schema (symbols on the wire)",
		ceilings: [
			{
				label: "Output tokens",
				value: DESIGN_REVIEWER_MAX_OUTPUT_TOKENS.toLocaleString("en-US"),
			},
			{
				label: "Step pace",
				value: minutes(MODEL_ROLES.designReviewer.msPerModelStep),
			},
		],
		source: {
			file: "lib/agent/design/reviewer.ts",
			symbol: "runDesignReviewer",
		},
	},
	"build-executor": {
		role: "build-executor",
		title: "Build executor",
		tagline:
			"Compiles one reviewed workflow slice into a private change set, one fresh context per attempt.",
		...roleModel("buildExecutor"),
		promptVersion: EXECUTOR_PROMPT_VERSION,
		cacheKey: "nova:design-executor:<designSessionId>",
		ledger: "durable-context",
		callShape: "single-step-loop",
		toolStrictness:
			"strict: false on every tool; allowedTools narrows per slice",
		outputStrictness: "no structured output",
		ceilings: [
			{
				label: "Steps per slice",
				value: "10 to 40",
				detail:
					"budgetForSlice: a base of 10, plus 3 per construction group and a risk allowance, capped at 40.",
			},
			{
				label: "Mutation calls",
				value: "16 to 96",
			},
			{
				label: "Commit attempts",
				value: "3",
			},
			{
				label: "Blocker allowance",
				value: `${BLOCKER_RESOLUTION_ALLOWANCE.modelSteps} steps each, 2 max`,
			},
			{
				label: "Step pace",
				value: minutes(MODEL_ROLES.buildExecutor.msPerModelStep),
			},
		],
		source: {
			file: "lib/agent/build/executorLoop.ts",
			symbol: "productionExecutorStep",
		},
	},
	"executor-helper": {
		role: "executor-helper",
		title: "Executor helper",
		tagline:
			"Decides what a blocked executor should do next from the accepted brief and exact diagnostics.",
		...roleModel("executorHelper"),
		promptVersion: null,
		cacheKey: null,
		ledger: "none",
		callShape: "one-shot-structured",
		toolStrictness: "no tools",
		outputStrictness: "strict projection of the blocker-decision schema",
		ceilings: [
			{ label: "Output tokens", value: "12,000" },
			{
				label: "Step pace",
				value: minutes(MODEL_ROLES.executorHelper.msPerModelStep),
			},
		],
		source: {
			file: "lib/agent/build/executionBlocker.ts",
			symbol: "resolveExecutionBlocker",
		},
	},
	"document-extractor": {
		role: "document-extractor",
		title: "Document extractor",
		tagline:
			"Relays every requirement in an attached document as markdown the architect reads instead of the file.",
		...roleModel("documentExtractor"),
		promptVersion: `extractor v${EXTRACTOR_VERSION}`,
		cacheKey: null,
		ledger: "none",
		callShape: "one-shot-structured",
		toolStrictness: "no tools",
		outputStrictness:
			"provider default (strict: true) over the flat extract schema, no Nova projection",
		ceilings: [
			{
				label: "Output tokens",
				value: EXTRACT_MAX_OUTPUT_TOKENS.toLocaleString("en-US"),
			},
			{
				label: "Step pace",
				value: minutes(MODEL_ROLES.documentExtractor.msPerModelStep),
			},
		],
		source: {
			file: "lib/agent/documentExtraction.ts",
			symbol: "extractDocument",
		},
	},
	translator: {
		role: "translator",
		title: "Translator",
		tagline:
			"Translates one batch of worker-facing content into a target language after the last slice commits.",
		...roleModel("translator"),
		promptVersion: TRANSLATION_PROMPT_VERSION,
		cacheKey: null,
		ledger: "none",
		callShape: "one-shot-structured",
		toolStrictness: "no tools",
		outputStrictness: "strict projection of the translation batch schema",
		ceilings: [
			{
				label: "Output tokens",
				value: TRANSLATION_MAX_OUTPUT_TOKENS.toLocaleString("en-US"),
			},
			{
				label: "Step pace",
				value: minutes(MODEL_ROLES.translator.msPerModelStep),
			},
		],
		source: {
			file: "lib/agent/translation/translator.ts",
			symbol: "createProductionTranslationBatchRunner",
		},
	},
	"mcp-boot": {
		role: "mcp-boot",
		title: "MCP boot prompt",
		tagline:
			"Hands an external client agent the same prompt and shared tools, with no Nova loop behind them.",
		modelRole: null,
		modelId: null,
		effort: null,
		promptVersion: null,
		cacheKey: null,
		ledger: "none",
		callShape: "client-agent",
		toolStrictness: "the client's choice; Nova serves canonical schemas",
		outputStrictness: "none",
		ceilings: [],
		source: { file: "lib/mcp/prompts.ts", symbol: "renderAgentPrompt" },
	},
};

/** The provider options literal a role's calls carry, rendered from the one
 * canonical helper so the page can never show a drifted copy. */
export function providerOptionsFor(role: AnatomyRoleId): unknown {
	const facts = ROLE_FACTS[role];
	if (facts.effort === null) return null;
	return reasoningProviderOptions(
		facts.effort,
		facts.cacheKey === null ? undefined : { promptCacheKey: facts.cacheKey },
	);
}

// ── The lifecycles on the map ────────────────────────────────────────────

export type LifecycleId = "chat-build" | "chat-edit" | "attachment" | "mcp";

export type LifecycleStep =
	| {
			readonly kind: "role";
			readonly role: AnatomyRoleId;
			/** How this role is entered here, when the map needs to say. */
			readonly note?: string;
	  }
	| {
			readonly kind: "server";
			readonly label: string;
			readonly note?: string;
	  }
	| { readonly kind: "input"; readonly label: string }
	| { readonly kind: "handoff"; readonly label: string };

export interface Lifecycle {
	readonly id: LifecycleId;
	readonly title: string;
	readonly summary: string;
	readonly steps: readonly LifecycleStep[];
}

export const LIFECYCLES: readonly Lifecycle[] = [
	{
		id: "chat-build",
		title: "Chat build",
		summary:
			"A conversation becomes a reviewed design, then a plan, then an app, before anyone can edit it.",
		steps: [
			{ kind: "input", label: "Source package: thread, attachments, answers" },
			{
				kind: "role",
				role: "design-author",
				note: "loops until finishDesign, pausing for askQuestions or waitForInput",
			},
			{ kind: "handoff", label: "hands: a contract revision" },
			{
				kind: "role",
				role: "design-reviewer",
				note: "a fresh context per revision; blockers send it back",
			},
			{ kind: "handoff", label: "hands: an accepted revision" },
			{
				kind: "server",
				label: "Lookup materialization and deterministic plan",
				note: "No model call. One slice per included workflow, in topological order.",
			},
			{ kind: "handoff", label: "hands: one slice brief at a time" },
			{
				kind: "role",
				role: "build-executor",
				note: "a fresh context per slice attempt",
			},
			{ kind: "handoff", label: "on a blocker: exact diagnostics" },
			{
				kind: "role",
				role: "executor-helper",
				note: "guidance returns inside the failed tool result",
			},
			{
				kind: "handoff",
				label: "after the last slice: the canonical snapshot",
			},
			{
				kind: "server",
				label: "Localization finalizer",
				note: "Copy-only targets never call a model.",
			},
			{
				kind: "role",
				role: "translator",
				note: "translate-with-nova targets only, batched by screen",
			},
			{ kind: "server", label: "Complete: the app is edit-shaped" },
		],
	},
	{
		id: "chat-edit",
		title: "Chat edit",
		summary:
			"Every later turn sends the whole thread plus a fresh app-state snapshot to one tool-loop agent.",
		steps: [
			{ kind: "input", label: "Thread history and the current blueprint" },
			{
				kind: "role",
				role: "solutions-architect",
				note: "the shared tool set, commits gated per batch",
			},
			{ kind: "server", label: "Drain end: schemas converge, the run settles" },
		],
	},
	{
		id: "attachment",
		title: "Attachment",
		summary:
			"A document is read once, at upload or as the send-time backstop, and its extract rides every later turn.",
		steps: [
			{ kind: "input", label: "One document: text, docx, xlsx, or pdf" },
			{
				kind: "role",
				role: "document-extractor",
				note: "one structured call, figures ride as image parts",
			},
			{ kind: "handoff", label: "hands: a stored extract the architect reads" },
		],
	},
	{
		id: "mcp",
		title: "MCP",
		summary:
			"An external client agent asks for the boot prompt and drives the shared tools itself.",
		steps: [
			{ kind: "input", label: "get_agent_prompt from an MCP client" },
			{
				kind: "role",
				role: "mcp-boot",
				note: "build or edit, interactive or autonomous",
			},
			{ kind: "handoff", label: "the client mounts the shared tools directly" },
		],
	},
];

/** The lifecycles a role appears in, for the role page's context line. */
export function lifecyclesFor(role: AnatomyRoleId): readonly Lifecycle[] {
	return LIFECYCLES.filter((lifecycle) =>
		lifecycle.steps.some((step) => step.kind === "role" && step.role === role),
	);
}

/** Every `MODEL_ROLES` key, mapped to the anatomy role that calls it. */
export const MODEL_ROLE_TO_ANATOMY: Readonly<
	Record<ModelRoleKey, AnatomyRoleId>
> = {
	designAuthor: "design-author",
	designReviewer: "design-reviewer",
	executorHelper: "executor-helper",
	buildExecutor: "build-executor",
	followUpEditor: "solutions-architect",
	documentExtractor: "document-extractor",
	translator: "translator",
};

/** Source files that read `MODEL_ROLES` to make a model call. Every other
 * `MODEL_ROLES.` reference under `lib/` and `app/` must be in
 * `MODEL_ROLE_NON_CALL_SITES` or the catalog test fails. */
export const MODEL_ROLE_CALL_SITES: readonly string[] = [
	"lib/agent/solutionsArchitect.ts",
	"lib/agent/design/loop/designAgent.ts",
	"lib/agent/build/designLoopRunner.ts",
	"lib/agent/design/reviewer.ts",
	"lib/agent/build/orchestrator.ts",
	"lib/agent/build/executionBlocker.ts",
	"lib/agent/documentExtraction.ts",
	"lib/agent/translation/translator.ts",
];

/** Files that read a role's model id for pricing, labeling, or budgets, and
 * never construct a model call. */
export const MODEL_ROLE_NON_CALL_SITES: readonly string[] = [
	"lib/agent/build/budgets.ts",
	"lib/agent/design/loop/artifacts.ts",
	"lib/agent/documentExtractionStore.ts",
	"lib/agent/translation/finalizer.ts",
	"app/api/chat/route.ts",
];
