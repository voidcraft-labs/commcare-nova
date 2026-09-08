/**
 * Token estimates for the anatomy.
 *
 * Every number here is an ESTIMATE: the o200k_base tokenizer over the text
 * Nova sends, which is not what the provider bills. The provider re-renders
 * tool schemas server-side into its own grammar, frames each message with
 * its own control tokens, and bills images and files by its own rules. A
 * recorded run shows the billed input beside these estimates so the residual
 * stays visible; nothing here pretends to be a measurement.
 *
 * The encoding loads lazily through one dynamic import so no other route pays
 * for it, and counts memoize by text digest because the same system prompt
 * is weighed on every page view.
 */

import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { bandOf } from "./bands";
import { outlineText } from "./outline";
import { presentableMessage } from "./present";
import type {
	ContextItem,
	Moment,
	WeighedItem,
	WeighedMoment,
	WeighedOutlineSection,
	WeighedSegment,
	WeighedTool,
	Weight,
} from "./types";

type Counter = (text: string) => number;

let counterPromise: Promise<Counter> | undefined;

function loadCounter(): Promise<Counter> {
	counterPromise ??= import("gpt-tokenizer/encoding/o200k_base").then(
		(encoding) => encoding.countTokens,
	);
	return counterPromise;
}

const MEMO_LIMIT = 4096;
const memo = new Map<string, number>();

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Estimated o200k_base tokens for `text`, memoized by content digest. */
export async function estimateTokens(text: string): Promise<number> {
	if (text.length === 0) return 0;
	const key = digest(text);
	const cached = memo.get(key);
	if (cached !== undefined) return cached;
	const count = (await loadCounter())(text);
	if (memo.size >= MEMO_LIMIT) {
		const oldest = memo.keys().next().value;
		if (oldest !== undefined) memo.delete(oldest);
	}
	memo.set(key, count);
	return count;
}

async function weighText(text: string): Promise<Weight> {
	return { chars: text.length, tokens: await estimateTokens(text) };
}

const EMPTY: Weight = { chars: 0, tokens: 0 };
const OPAQUE: Weight = { chars: 0, tokens: null };

function addWeights(weights: readonly Weight[]): Weight {
	let chars = 0;
	let tokens: number | null = 0;
	for (const weight of weights) {
		chars += weight.chars;
		if (tokens !== null) {
			tokens = weight.tokens === null ? null : tokens + weight.tokens;
		}
	}
	return { chars, tokens };
}

/** The text the estimator can count in a model message, and how many parts
 * it could not (images and files, which the provider bills by its own
 * rules). */
export function countableMessageText(message: ModelMessage): {
	text: string;
	uncountedParts: number;
} {
	if (typeof message.content === "string") {
		return { text: message.content, uncountedParts: 0 };
	}
	const chunks: string[] = [];
	let uncountedParts = 0;
	for (const part of message.content) {
		switch (part.type) {
			case "text":
			case "reasoning":
				chunks.push(part.text);
				break;
			case "tool-call":
				chunks.push(part.toolName, JSON.stringify(part.input));
				break;
			case "tool-result":
				chunks.push(part.toolName, JSON.stringify(part.output));
				break;
			case "image":
			case "file":
				uncountedParts += 1;
				break;
			default:
				chunks.push(JSON.stringify(part));
		}
	}
	return { text: chunks.join("\n"), uncountedParts };
}

/** How a tool definition is counted: the JSON the SDK serializes for the
 * provider. The provider's own rendering differs, which is why the estimate
 * is labeled as one. */
export function toolDefinitionText(tool: {
	name: string;
	description: string;
	inputSchema: unknown;
	strict: boolean | undefined;
}): string {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
		strict: tool.strict,
	});
}

async function weighItem(item: ContextItem): Promise<WeighedItem> {
	switch (item.kind) {
		case "system": {
			const segments: WeighedSegment[] = await Promise.all(
				item.segments.map(async (segment) => ({
					...segment,
					weight: await weighText(segment.text),
				})),
			);
			const outline: WeighedOutlineSection[] = await Promise.all(
				outlineText(item.text).map(async (section) => ({
					id: section.id,
					level: section.level,
					title: section.title,
					line: section.line,
					text: section.text,
					weight: await weighText(section.text),
				})),
			);
			return {
				...item,
				segments,
				outline,
				weight: await weighText(item.text),
			};
		}
		case "tools": {
			const tools: WeighedTool[] = await Promise.all(
				item.tools.map(async (tool) => ({
					...tool,
					weight: await weighText(toolDefinitionText(tool)),
				})),
			);
			return {
				...item,
				tools,
				weight: addWeights(tools.map((tool) => tool.weight)),
			};
		}
		case "output-schema":
			return {
				...item,
				weight: await weighText(JSON.stringify(item.jsonSchema)),
			};
		case "message": {
			const { text, uncountedParts } = countableMessageText(item.message);
			const weight = await weighText(text);
			/* Counted over the real message; carried onward as a page can hold
			 * it (a URL as its text, bytes as a labeled placeholder). */
			return {
				...item,
				message: presentableMessage(item.message),
				weight:
					uncountedParts > 0 ? { chars: weight.chars, tokens: null } : weight,
			};
		}
		case "compaction":
			return { ...item, weight: OPAQUE };
		case "missing":
			return { ...item, weight: EMPTY };
	}
}

/** Adds an estimated weight to every item, segment, and tool of a moment and
 * sums the static and variable bands. */
export async function weigh(moment: Moment): Promise<WeighedMoment> {
	const items = await Promise.all(moment.items.map(weighItem));
	const staticItems = items.filter((item) => bandOf(item.kind) === "static");
	const variableItems = items.filter(
		(item) => bandOf(item.kind) === "variable",
	);
	return {
		...moment,
		items,
		bands: {
			static: addWeights(staticItems.map((item) => item.weight)),
			variable: addWeights(variableItems.map((item) => item.weight)),
		},
	};
}
