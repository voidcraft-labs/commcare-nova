import type {
	ContextItemKind,
	InputNeed,
	Origin,
	Weight,
} from "@/lib/agent/anatomy";
import { formatTokenCount } from "@/lib/utils/format";

/** Why a piece is absent from a composed moment, in the reader's terms. */
export const NEED_LABELS: Readonly<Record<InputNeed, string>> = {
	app: "needs a local app",
	"design-session": "needs a recorded run",
	"live-call": "only a live call has it",
};

export function formatTokens(tokens: number | null): string {
	return tokens === null ? "unknown" : formatTokenCount(tokens);
}

export function formatExactTokens(tokens: number | null): string {
	return tokens === null ? "unknown" : tokens.toLocaleString("en-US");
}

export function formatWeight(weight: Weight): string {
	return weight.tokens === null
		? `${weight.chars.toLocaleString("en-US")} chars, tokens unknown`
		: `${formatExactTokens(weight.tokens)} estimated tokens`;
}

export const ORIGIN_LABELS: Readonly<Record<Origin, string>> = {
	composed: "Composed from code",
	derived: "Derived from a local app",
	recorded: "Recorded from a local run",
};

export const KIND_LABELS: Readonly<Record<ContextItemKind, string>> = {
	system: "System prompt",
	tools: "Tool definitions",
	"output-schema": "Output schema",
	message: "Message",
	compaction: "Compaction",
	missing: "Not available here",
};

/** The one hue per item kind, used by the token bar, the list, and the
 * reading pane so a piece keeps its color across the page. */
export const KIND_FILL: Readonly<Record<ContextItemKind, string>> = {
	system: "bg-nova-violet",
	tools: "bg-nova-periwinkle",
	"output-schema": "bg-nova-iris",
	message: "bg-nova-orchid",
	compaction: "bg-nova-amber",
	missing: "bg-transparent",
};

export const KIND_TEXT: Readonly<Record<ContextItemKind, string>> = {
	system: "text-nova-violet-bright",
	tools: "text-nova-periwinkle",
	"output-schema": "text-nova-iris",
	message: "text-nova-orchid",
	compaction: "text-nova-amber",
	missing: "text-nova-text-muted",
};
