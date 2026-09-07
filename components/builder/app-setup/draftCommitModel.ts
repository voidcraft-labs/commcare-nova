import type { CommitOutcome } from "@/lib/domain";

export const PEER_CHANGE_MESSAGE =
	"This changed in another editor while you were typing. Press Escape to use the shared value, then make your change again.";
export function firstDraftRefusal(outcome: CommitOutcome): string | undefined {
	return outcome.ok
		? undefined
		: (outcome.messages[0] ?? "That change could not be applied.");
}
export function acceptedValuesFromDraft(draft: string): string[] {
	return draft
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}
export type DraftCommitDecision =
	| { readonly kind: "ignored" }
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "unchanged"; readonly value: string }
	| { readonly kind: "commit"; readonly value: string };
/** Actual shared input/lines commit decision. Callers own the returned mutation. */
export function decideDraftCommit({
	draft,
	baseValue,
	currentValue,
	disabled,
	normalize,
	validate,
	skipPristine = false,
}: {
	readonly draft: string;
	readonly baseValue: string;
	readonly currentValue: string;
	readonly disabled: boolean;
	readonly normalize: (draft: string) => string;
	readonly validate?: (value: string) => string | undefined;
	readonly skipPristine?: boolean;
}): DraftCommitDecision {
	if (disabled || (skipPristine && draft === baseValue))
		return { kind: "ignored" };
	if (currentValue !== baseValue)
		return { kind: "refused", message: PEER_CHANGE_MESSAGE };
	const value = normalize(draft);
	const message = validate?.(value);
	if (message !== undefined) return { kind: "refused", message };
	return { kind: value === currentValue ? "unchanged" : "commit", value };
}
