/**
 * The role catalog: one entry per model role, with the facts a reader needs
 * before the prompt text (model and effort, prompt version, cache key,
 * ledger, ceilings, strictness, call site), and the four lifecycles that
 * connect the roles on the map.
 *
 * Facts come from the production constants that govern each call site.
 */

import {
	ARCHITECT_MAX_STEPS,
	PEER_MAX_STEPS,
} from "@/lib/agent/build/architectLoop";
import { EXTRACT_MAX_OUTPUT_TOKENS } from "@/lib/agent/documentExtraction";
import { promptCacheKeys } from "@/lib/agent/promptCacheKeys";
import {
	buildArchitectPeerPrompt,
	buildArchitectPrompt,
} from "@/lib/agent/prompts";
import {
	SOLUTIONS_ARCHITECT_MAX_RETRIES,
	SOLUTIONS_ARCHITECT_MAX_STEPS,
} from "@/lib/agent/solutionsArchitect";
import { TRANSLATION_MAX_STEPS } from "@/lib/agent/translation/translateLanguage";
import {
	TRANSLATION_MAX_OUTPUT_TOKENS,
	TRANSLATION_SYSTEM,
} from "@/lib/agent/translation/translator";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import {
	MODEL_ROLES,
	OPENAI_COMPACTION_THRESHOLD,
	type ReasoningEffort,
	reasoningProviderOptions,
} from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
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

export const ROLE_FACTS: Readonly<Record<AnatomyRoleId, RoleFacts>> = {
	"solutions-architect": {
		role: "solutions-architect",
		title: "Solutions architect",
		tagline:
			"Edits a complete app in conversation, one tool call at a time, against the full thread history.",
		...roleModel("followUpEditor"),
		promptVersion: null,
		cacheKey: promptCacheKeys.app("<appId>"),
		ledger: "thread",
		callShape: "tool-loop",
		toolStrictness: "strict: false on every tool",
		outputStrictness: "no structured output",
		ceilings: [
			{
				label: "Steps per turn",
				value: String(SOLUTIONS_ARCHITECT_MAX_STEPS),
				detail: "stopWhen: isStepCount in createSolutionsArchitect.",
			},
			{
				label: "Establishment retries",
				value: String(SOLUTIONS_ARCHITECT_MAX_RETRIES),
				detail:
					"The SDK retries a failed request; a mid-stream fault re-drives the whole turn instead.",
			},
		],
		source: {
			file: "lib/agent/solutionsArchitect.ts",
			symbol: "createSolutionsArchitect",
		},
	},
	architect: {
		role: "architect",
		title: "Architect",
		tagline: "Plans and builds the app in one durable conversation.",
		...roleModel("architect"),
		promptVersion: canonicalJsonDigest(buildArchitectPrompt()),
		cacheKey: "nova:architect:<designSessionId>",
		ledger: "durable-context",
		callShape: "single-step-loop",
		toolStrictness: "strict: false on function tools",
		outputStrictness: "no structured output",
		ceilings: [{ label: "Steps per turn", value: String(ARCHITECT_MAX_STEPS) }],
		source: {
			file: "lib/agent/build/orchestrator.ts",
			symbol: "runBuildOrchestration",
		},
	},
	peer: {
		role: "peer",
		title: "Peer",
		tagline:
			"Independently reviews the plan or saved app and edits the same plan.",
		...roleModel("peer"),
		promptVersion: canonicalJsonDigest(buildArchitectPeerPrompt()),
		cacheKey: "nova:peer:<designSessionId>",
		ledger: "durable-context",
		callShape: "single-step-loop",
		toolStrictness: "strict: false on function tools",
		outputStrictness: "no structured output",
		ceilings: [{ label: "Steps per review", value: String(PEER_MAX_STEPS) }],
		source: {
			file: "lib/agent/build/orchestrator.ts",
			symbol: "runBuildOrchestration",
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
			"Translates batches of worker-facing content from the current app.",
		...roleModel("translator"),
		promptVersion: canonicalJsonDigest(TRANSLATION_SYSTEM),
		cacheKey: "nova:translator:<designSessionId>",
		ledger: "durable-context",
		callShape: "single-step-loop",
		toolStrictness: "no tools",
		outputStrictness: "strict projection of the translation batch schema",
		ceilings: [
			{ label: "Steps per batch", value: String(TRANSLATION_MAX_STEPS) },
			{
				label: "Output tokens",
				value: TRANSLATION_MAX_OUTPUT_TOKENS.toLocaleString("en-US"),
			},
		],
		source: {
			file: "lib/agent/translation/translateLanguage.ts",
			symbol: "translateLanguage",
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
		toolStrictness: "the client's choice; Nova serves shared authoring schemas",
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
			"One architect develops a plan and builds the app, with independent peer review and atomic saved workflows.",
		steps: [
			{ kind: "input", label: "User requests and attachments" },
			{
				kind: "role",
				role: "architect",
				note: "Plans before construction; carries the same conversation through the build.",
			},
			{
				kind: "role",
				role: "peer",
				note: "Reads the sources and edits the plan while the architect is paused.",
			},
			{
				kind: "server",
				label: "Validated private workspace and atomic saved workflows",
			},
			{
				kind: "role",
				role: "peer",
				note: "Exercises the saved app and retains its own evidence across corrections; feedback returns to the architect.",
			},
			{ kind: "server", label: "Complete app and settled usage" },
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
	Partial<Record<ModelRoleKey, AnatomyRoleId>>
> = {
	architect: "architect",
	peer: "peer",
	followUpEditor: "solutions-architect",
	documentExtractor: "document-extractor",
	translator: "translator",
};

/** The one sentence about provider options every call shares, rendered from
 * the constants so the map's footer cannot drift from `lib/models.ts`. */
export const OPENAI_COMPACTION_NOTE = `Every call runs stateless (store: false) with the provider's automatic compaction at ${OPENAI_COMPACTION_THRESHOLD.toLocaleString("en-US")} input tokens and reasoning summaries on. Token counts on these pages are estimates from the o200k_base tokenizer over the text Nova sends; the provider renders tool schemas in its own grammar and bills images by its own rules, so a recorded run shows the billed input beside the estimate.`;
