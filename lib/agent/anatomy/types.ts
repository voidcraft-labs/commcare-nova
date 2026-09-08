/**
 * The vocabulary of the agent anatomy: how Nova's model roles are composed,
 * moment by moment, as data a page can render uniformly.
 *
 * Nothing here is authority. Every value is derived at read time from the
 * production constants and functions in `lib/agent`, from a local app's
 * blueprint, or from the persisted model-context ledgers of a local run, and
 * each item says which of those three it came from.
 */

import type { ModelMessage } from "ai";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import type { BlueprintDoc } from "@/lib/domain";

/** The model roles the anatomy describes, one page each. */
export type AnatomyRoleId =
	| "solutions-architect"
	| "design-author"
	| "design-reviewer"
	| "build-executor"
	| "executor-helper"
	| "document-extractor"
	| "translator"
	| "mcp-boot";

export const ANATOMY_ROLE_IDS: readonly AnatomyRoleId[] = [
	"solutions-architect",
	"design-author",
	"design-reviewer",
	"build-executor",
	"executor-helper",
	"document-extractor",
	"translator",
	"mcp-boot",
];

/** Where an item's bytes came from. */
export type Origin =
	/** Rendered by calling the same code production calls. */
	| "composed"
	/** Rendered from a local app's current blueprint through pure functions. */
	| "derived"
	/** Read verbatim from the persisted model-context ledger of a local run. */
	| "recorded";

/** The input a moment needs before every item can be rendered. */
export type InputNeed =
	/** A local app: its blueprint, and its newest thread when one exists. */
	| "app"
	/** A local design session's recorded model contexts. */
	| "design-session"
	/** Only a live call has it: the piece is built per call and never stored. */
	| "live-call";

/** Where a piece lives in the codebase, for the reader who wants to go there. */
export interface SourceRef {
	readonly file: string;
	readonly symbol: string;
}

/** A named piece of a static system prompt, with its provenance. */
export interface PromptSegmentView {
	readonly id: string;
	readonly title: string;
	readonly text: string;
	readonly source: SourceRef;
	readonly generated?: readonly string[];
}

/** One tool as the provider receives it. */
export interface ToolDefinitionView {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: unknown;
	readonly strict: boolean | undefined;
	/** Executor only: whether this slice's `allowedTools` admits the tool. */
	readonly allowed?: boolean;
}

interface ItemBase {
	/** Stable within a role, so two moments can be diffed by id. */
	readonly id: string;
	readonly label: string;
	readonly origin: Origin;
	readonly source: SourceRef;
	/** One sentence a reader needs beside the item, in Nova's voice. */
	readonly note?: string;
}

export type ContextItem =
	| (ItemBase & {
			readonly kind: "system";
			/** The prompt exactly as sent: the segments joined by the role's
			 * separator. */
			readonly text: string;
			readonly segments: readonly PromptSegmentView[];
	  })
	| (ItemBase & {
			readonly kind: "tools";
			readonly tools: readonly ToolDefinitionView[];
			/** The tool names whose definitions feed the persisted toolset digest,
			 * when that set is narrower than the mounted set. */
			readonly digestCovers?: readonly string[];
	  })
	| (ItemBase & {
			readonly kind: "output-schema";
			readonly jsonSchema: unknown;
			readonly strict: boolean;
	  })
	| (ItemBase & {
			readonly kind: "message";
			readonly wireRole: "user" | "assistant" | "tool";
			readonly message: ModelMessage;
			/** The request-local explicit prompt-cache boundary lands here. */
			readonly cacheBoundary?: boolean;
	  })
	/** A provider compaction checkpoint: an opaque encrypted item the provider
	 * substitutes for everything before it. Recorded runs only. */
	| (ItemBase & { readonly kind: "compaction" })
	/** A piece that would sit here but cannot be rendered without an input the
	 * page does not have, or that only a recorded run can show exactly. */
	| (ItemBase & {
			readonly kind: "missing";
			readonly needs: InputNeed;
			readonly explanation: string;
	  });

export type ContextItemKind = ContextItem["kind"];

/** A moment: one point in a role's lifecycle where the set of items the model
 * receives has a distinct shape. */
export interface MomentSpec {
	readonly id: string;
	readonly label: string;
	/** One or two sentences: what happens here and why it matters. */
	readonly why: string;
	readonly needs: readonly InputNeed[];
	/** The code that produces this moment's distinctive items. */
	readonly source: SourceRef;
}

export interface Moment extends MomentSpec {
	readonly items: readonly ContextItem[];
}

/** Inputs a composition may render against. Every field is optional; a
 * composition renders a `missing` item in place of anything it lacks. */
export interface CompositionInputs {
	readonly app?: AppInput;
	readonly session?: DesignSessionInput;
}

export interface AppInput {
	readonly appId: string;
	readonly appName: string;
	/** The app's current blueprint. */
	readonly doc: BlueprintDoc;
	/** The app's newest chat thread, when one exists. */
	readonly thread?: {
		readonly threadId: string;
		readonly messages: readonly NovaUIMessage[];
	};
}

/** The recorded ledger of one local design session, read once and reused by
 * every composition and page that needs it. */
export interface DesignSessionInput {
	readonly designSessionId: string;
	readonly appName: string | null;
	readonly contexts: readonly RecordedContext[];
}

export interface RecordedContext {
	readonly contextId: string;
	readonly kind: "design" | "executor";
	readonly generation: number;
	readonly supersedesContextId: string | null;
	readonly modelId: string;
	readonly promptVersion: string;
	readonly toolsetDigest: string;
	readonly contextVersion: string;
	/** Executor only: the slice attempt this generation belongs to, parsed
	 * from the context version's semantic scope and joined to the attempt row. */
	readonly slice?: {
		readonly attemptId: string;
		readonly sliceId: string | null;
		readonly attempt: number | null;
		readonly status: string | null;
	};
	readonly items: readonly RecordedItem[];
	readonly steps: readonly RecordedStep[];
}

/** The family an append key belongs to, so a timeline can chip it. */
export type RecordedItemKind =
	| "seed"
	| "user-turn"
	| "answer"
	| "state-packet"
	| "compaction-state"
	| "compaction-reseed"
	| "required-questions"
	| "question-card"
	| "correction"
	| "wait"
	| "response"
	| "slice-brief"
	| "candidate-checkpoint"
	| "slice-focus"
	| "tool-result"
	| "empty-step-nudge"
	| "blocker"
	| "auto-blocker"
	| "unknown";

export interface RecordedItem {
	readonly ordinal: number;
	readonly appendKey: string;
	readonly appendIndex: number;
	readonly itemKind: RecordedItemKind;
	readonly message: ModelMessage;
	/** True when the message carries the provider's opaque compaction part. */
	readonly compaction: boolean;
	readonly createdAt: string;
	readonly createdByRunId: string;
}

export interface RecordedStep {
	readonly stepKey: string;
	readonly startedAt: string | null;
	readonly completedAt: string | null;
	readonly requestDigest: string | null;
	readonly responseDigest: string | null;
	readonly usage: RecordedUsage | null;
}

/** Billed usage as the provider reported it for one completed step. */
export interface RecordedUsage {
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cachedInputTokens: number | null;
	readonly reasoningTokens: number | null;
	readonly totalTokens: number | null;
}

/** A role's composition: its moments and the pure function that renders one. */
export interface RoleComposition {
	readonly role: AnatomyRoleId;
	readonly moments: readonly MomentSpec[];
	/** Pure over its inputs. Throws only on an unknown moment id. */
	compose(momentId: string, inputs: CompositionInputs): Promise<Moment>;
}

/** Weights added to every item, segment, and tool by the estimator. */
export interface Weight {
	readonly chars: number;
	/** Estimated with the o200k_base tokenizer. `null` for image and file
	 * parts, which the provider bills by its own rules. */
	readonly tokens: number | null;
}

export type WeighedSegment = PromptSegmentView & { readonly weight: Weight };
export type WeighedTool = ToolDefinitionView & { readonly weight: Weight };

/** One heading section of a system prompt, with its weight. */
export interface WeighedOutlineSection {
	readonly id: string;
	readonly level: number;
	readonly title: string;
	readonly line: number;
	/** The section's text including its heading line. */
	readonly text: string;
	readonly weight: Weight;
}

export type WeighedItem =
	| (Omit<Extract<ContextItem, { kind: "system" }>, "segments"> & {
			readonly weight: Weight;
			readonly segments: readonly WeighedSegment[];
			/** The heading outline of the whole text. */
			readonly outline: readonly WeighedOutlineSection[];
	  })
	| (Omit<Extract<ContextItem, { kind: "tools" }>, "tools"> & {
			readonly weight: Weight;
			readonly tools: readonly WeighedTool[];
	  })
	| (Exclude<ContextItem, { kind: "system" | "tools" }> & {
			readonly weight: Weight;
	  });

export interface WeighedMoment extends MomentSpec {
	readonly items: readonly WeighedItem[];
	/** The three bands of the token bar. */
	readonly bands: {
		/** System prompt, tool definitions, output schema: the same on every call. */
		readonly static: Weight;
		/** Messages: the part that changes between turns and moments. */
		readonly variable: Weight;
	};
}
