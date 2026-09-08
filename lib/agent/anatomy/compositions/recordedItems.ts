/**
 * Turning a recorded design or executor context into context items: one
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
		seed: "Seed: the projected thread",
		"user-turn": "User turn",
		answer: "Answered questions",
		"state-packet": "Design session state packet",
		"compaction-state": "State packet after compaction",
		"compaction-reseed": "Reseed after compaction",
		"required-questions": "Required questions demanded",
		"question-card": "Question card response",
		correction: "Server correction",
		wait: "Wait for input",
		response: "Model response",
		"slice-brief": "Accepted execution brief",
		"candidate-checkpoint": "Private Blueprint checkpoint",
		"slice-focus": "Slice focus and inventory",
		"tool-result": "Tool result",
		"empty-step-nudge": "Empty-step nudge",
		blocker: "Blocker decision",
		"auto-blocker": "Repeated-failure guidance",
		unknown: "Ledger item",
	};

/** A recorded item's label: the family, or the wire role for a response. */
export function recordedLabel(item: RecordedItem): string {
	if (item.itemKind === "response" || item.itemKind === "question-card") {
		if (item.message.role === "assistant") return "Assistant response";
		if (item.message.role === "tool") return "Tool result";
	}
	if (item.itemKind === "unknown") {
		return messageLead(item.message, `Ledger item ${item.appendKey}`);
	}
	return RECORDED_KIND_LABELS[item.itemKind];
}

const NOTES: Partial<Record<RecordedItemKind, string>> = {
	seed: "Appended once when the context opens: the thread converted to model messages with the source package rendered into it.",
	"state-packet":
		"Server-derived before every provider call: artifact ancestry, gate verdicts, open findings, and workspace state. Authority after any compaction.",
	"compaction-state":
		"Appended after the provider's checkpoint so the compacted suffix carries authoritative state again.",
	"compaction-reseed":
		"The executor appends its three seed packets again after a checkpoint.",
	"required-questions":
		"The server demands an exact askQuestions round and refuses design updates until it is answered.",
	correction:
		"One server-authored correction after a clean response with no update, question, wait, or finalizer.",
	wait: "The explicit terminal when more requirements are coming but no question is ready.",
	"slice-brief":
		"Immutable for the attempt. The semantic checklist, relevant constraints, and the exact tool profile.",
	"candidate-checkpoint":
		"The complete private Blueprint projected through durable handles. This is how a slice learns what earlier slices built.",
	"slice-focus": "Short slice focus plus a compact inventory of the workspace.",
	"empty-step-nudge":
		"A response with no tool call gets one nudge; three in a row stop the attempt.",
	blocker:
		"The architect's decision for a reportExecutionBlocker call, returned inside the tool result.",
	"auto-blocker":
		"Guidance the server bought after a repeated substantive failure, returned inside the failed tool result.",
};

export function recordedItems(
	items: readonly RecordedItem[],
	source: SourceRef,
): ContextItem[] {
	return items.map((item) =>
		recordedItem(item, recordedLabel(item), source, NOTES[item.itemKind]),
	);
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
