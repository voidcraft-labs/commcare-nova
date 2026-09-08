/**
 * Helpers every role composition builds its items with, so the eight files
 * read as lists of what the model receives rather than as plumbing.
 */

import { type ModelMessage, zodSchema } from "ai";
import type { z } from "zod";
import type { PromptSegment } from "@/lib/agent/promptSegments";
import { strictWireJsonSchema } from "@/lib/agent/strictStructuredOutput";
import { modelMessagesContainCompaction } from "@/lib/chat/compaction";
import type {
	ContextItem,
	InputNeed,
	Moment,
	MomentSpec,
	Origin,
	PromptSegmentView,
	RecordedItem,
	SourceRef,
	ToolDefinitionView,
} from "../types";

export function segmentViews(
	segments: readonly PromptSegment[],
	file: string,
	symbol: string,
): PromptSegmentView[] {
	return segments.map((segment) => ({
		id: segment.id,
		title: segment.title,
		text: segment.text,
		source: { file, symbol },
		...(segment.generated && { generated: segment.generated }),
	}));
}

export function systemItem(args: {
	id?: string;
	label?: string;
	text: string;
	segments: readonly PromptSegmentView[];
	source: SourceRef;
	origin?: Origin;
	note?: string;
}): ContextItem {
	return {
		kind: "system",
		id: args.id ?? "system",
		label: args.label ?? "System prompt",
		origin: args.origin ?? "composed",
		source: args.source,
		text: args.text,
		segments: args.segments,
		...(args.note && { note: args.note }),
	};
}

/** A tool definition as the roles hold it before mounting: the SDK's
 * `FlexibleSchema` (with a possibly lazy `jsonSchema`) or a plain JSON
 * schema object. */
export interface ToolDefinitionSource {
	readonly description: string;
	readonly inputSchema: unknown;
	readonly strict?: boolean;
}

/** The schema exactly as the wire carries it: its JSON serialization.
 * Zod's emitters hang a non-enumerable `~standard` hook (functions) off the
 * schema object, which never reaches the provider and would refuse to cross
 * into a client component. */
export function wireJson(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function resolveJsonSchema(inputSchema: unknown): Promise<unknown> {
	if (
		typeof inputSchema === "object" &&
		inputSchema !== null &&
		"jsonSchema" in inputSchema
	) {
		return wireJson(await (inputSchema as { jsonSchema: unknown }).jsonSchema);
	}
	return wireJson(inputSchema);
}

export async function toolViews(
	definitions: Readonly<Record<string, ToolDefinitionSource>>,
	allowed?: ReadonlySet<string>,
): Promise<ToolDefinitionView[]> {
	return Promise.all(
		Object.entries(definitions).map(async ([name, definition]) => ({
			name,
			description: definition.description,
			inputSchema: await resolveJsonSchema(definition.inputSchema),
			strict: definition.strict,
			...(allowed && { allowed: allowed.has(name) }),
		})),
	);
}

export function toolsItem(args: {
	id?: string;
	label?: string;
	tools: readonly ToolDefinitionView[];
	source: SourceRef;
	note?: string;
	digestCovers?: readonly string[];
}): ContextItem {
	return {
		kind: "tools",
		id: args.id ?? "tools",
		label: args.label ?? "Tool definitions",
		origin: "composed",
		source: args.source,
		tools: args.tools,
		...(args.note && { note: args.note }),
		...(args.digestCovers && { digestCovers: args.digestCovers }),
	};
}

export function outputSchemaItem(args: {
	id?: string;
	label?: string;
	schema: z.ZodType;
	/** `strict`: Nova's projection into the strict subset (the default for
	 * `runStructured`). `provider-default`: the raw Zod emission, which the
	 * provider still marks strict. */
	projection: "strict" | "provider-default";
	source: SourceRef;
	note?: string;
}): ContextItem {
	return {
		kind: "output-schema",
		id: args.id ?? "output-schema",
		label: args.label ?? "Output schema",
		origin: "composed",
		source: args.source,
		jsonSchema: wireJson(
			args.projection === "strict"
				? strictWireJsonSchema(args.schema)
				: // The SDK's own emission, as `Output.object` serializes it.
					zodSchema(args.schema).jsonSchema,
		),
		strict: true,
		...(args.note && { note: args.note }),
	};
}

export function messageItem(args: {
	id: string;
	label: string;
	message: ModelMessage;
	source: SourceRef;
	origin: Origin;
	note?: string;
	cacheBoundary?: boolean;
}): ContextItem {
	return {
		kind: "message",
		id: args.id,
		label: args.label,
		origin: args.origin,
		source: args.source,
		wireRole: args.message.role === "system" ? "user" : args.message.role,
		message: args.message,
		...(args.note && { note: args.note }),
		...(args.cacheBoundary && { cacheBoundary: true }),
	};
}

export function compactionItem(args: {
	id: string;
	source: SourceRef;
	origin: Origin;
	note?: string;
}): ContextItem {
	return {
		kind: "compaction",
		id: args.id,
		label: "Compaction checkpoint",
		origin: args.origin,
		source: args.source,
		note:
			args.note ??
			"The provider's opaque encrypted checkpoint. Everything before it is gone from the model's view; Nova keeps the full transcript for people.",
	};
}

export function missingItem(args: {
	id: string;
	label: string;
	needs: InputNeed;
	explanation: string;
	source: SourceRef;
}): ContextItem {
	return {
		kind: "missing",
		id: args.id,
		label: args.label,
		// The origin the piece would carry once its input is present.
		origin:
			args.needs === "app"
				? "derived"
				: args.needs === "design-session"
					? "recorded"
					: "composed",
		source: args.source,
		needs: args.needs,
		explanation: args.explanation,
	};
}

/** Whether a model message carries the provider's compaction part. */
export function messageHasCompaction(message: ModelMessage): boolean {
	return modelMessagesContainCompaction([message]);
}

/** Whether a message or one of its parts carries the explicit prompt-cache
 * breakpoint `markStablePrefixBoundary` sets. */
export function messageHasCacheBoundary(message: ModelMessage): boolean {
	const marks = (options: unknown): boolean =>
		typeof options === "object" &&
		options !== null &&
		"openai" in options &&
		typeof (options as { openai: unknown }).openai === "object" &&
		(options as { openai: object | null }).openai !== null &&
		"promptCacheBreakpoint" in (options as { openai: object }).openai;
	if (marks(message.providerOptions)) return true;
	if (typeof message.content === "string") return false;
	return message.content.some((part) =>
		marks((part as { providerOptions?: unknown }).providerOptions),
	);
}

/** A recorded ledger item as a context item, labeled by its family. */
export function recordedItem(
	item: RecordedItem,
	label: string,
	source: SourceRef,
	note?: string,
): ContextItem {
	const id = `recorded:${item.ordinal}`;
	if (item.compaction) {
		return compactionItem({ id, source, origin: "recorded" });
	}
	return messageItem({
		id,
		label,
		message: item.message,
		source,
		origin: "recorded",
		...(note && { note }),
	});
}

export function moment(
	spec: MomentSpec,
	items: readonly ContextItem[],
): Moment {
	return { ...spec, items };
}

export function specById(
	specs: readonly MomentSpec[],
	momentId: string,
	role: string,
): MomentSpec {
	const spec = specs.find((candidate) => candidate.id === momentId);
	if (spec === undefined) {
		throw new Error(
			`The ${role} composition has no moment "${momentId}". Its moments are ${specs.map((candidate) => candidate.id).join(", ")}.`,
		);
	}
	return spec;
}

/** One-line label for a model message from its leading text. */
export function messageLead(message: ModelMessage, fallback: string): string {
	const text =
		typeof message.content === "string"
			? message.content
			: (
					message.content.find((part) => part.type === "text") as
						| { text: string }
						| undefined
				)?.text;
	const first = text?.split("\n").find((line) => line.trim().length > 0);
	if (!first) return fallback;
	const trimmed = first.replace(/^#+\s*/, "").trim();
	return trimmed.length > 64 ? `${trimmed.slice(0, 63)}…` : trimmed;
}
