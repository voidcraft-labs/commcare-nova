/**
 * Turning a recorded agent context into context items: one
 * label per append-key family, the compaction checkpoint as its own item,
 * and the assistant's responses labeled by wire role.
 */

import type {
	ContextItem,
	RecordedContext,
	RecordedItem,
	RecordedItemKind,
	SourceRef,
} from "../types";
import { messageLead, recordedItem } from "./shared";

export const RECORDED_KIND_LABELS: Readonly<Record<RecordedItemKind, string>> =
	{
		source: "Source material",
		plan: "Plan and app context",
		response: "Model response",
		"tool-result": "Tool result",
		feedback: "Peer or completion feedback",
		"previous-conversation": "Previous conversation",
		unknown: "Conversation item",
	};
export function recordedLabel(item: RecordedItem): string {
	return item.itemKind === "unknown"
		? messageLead(item.message, `Conversation item ${item.ordinal}`)
		: RECORDED_KIND_LABELS[item.itemKind];
}
export function recordedItems(
	items: readonly RecordedItem[],
	source: SourceRef,
): ContextItem[] {
	return items.map((item) => recordedItem(item, recordedLabel(item), source));
}

/** The newest context of a kind, by generation then by insertion. */
export function newestContext(
	contexts: readonly RecordedContext[],
	kind: RecordedContext["kind"],
): RecordedContext | undefined {
	return contexts
		.filter((context) => context.kind === kind)
		.sort((a, b) => b.generation - a.generation)
		.at(0);
}

/** Items up to and including the first of a kind, or undefined when the
 * context has none. */
export function throughFirst(
	items: readonly RecordedItem[],
	kind: RecordedItemKind,
): readonly RecordedItem[] | undefined {
	const index = items.findIndex((item) => item.itemKind === kind);
	return index === -1 ? undefined : items.slice(0, index + 1);
}

/** Every item of a recorded context as context items, for the runs pages. */
export function recordedItemsOf(context: RecordedContext): ContextItem[] {
	return recordedItems(context.items, {
		file: "lib/agent/build/modelContextStore.ts",
		symbol: "appendDesignModelContext",
	});
}

/** Items from the newest compaction checkpoint onward, or undefined when the
 * context never compacted. */
export function fromNewestCompaction(
	items: readonly RecordedItem[],
): readonly RecordedItem[] | undefined {
	let index = -1;
	items.forEach((item, position) => {
		if (item.compaction) index = position;
	});
	return index === -1 ? undefined : items.slice(index);
}
