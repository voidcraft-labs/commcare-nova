import { type Literal, literal } from "@/lib/domain/predicate";
import { rebuildLiteralPreservingDataType } from "./literalRebuild";

export function finiteLiteralDraft(
	draft: string,
	integerOnly = false,
): number | undefined {
	if (draft.trim() === "") return undefined;
	const parsed = Number(draft);
	return Number.isFinite(parsed) && (!integerOnly || Number.isInteger(parsed))
		? parsed
		: undefined;
}

export type LiteralDraftPlan =
	| { readonly kind: "unchanged" }
	| { readonly kind: "rejected"; readonly reason: string }
	| { readonly kind: "commit"; readonly value: Literal };

/** The text/numeric input's commit boundary. Drafts stay local until this
 * accepts them; immutable literal qualifiers survive the accepted edit. */
export function planLiteralDraft({
	value,
	draft,
	kind,
	nonEmpty = false,
}: {
	readonly value: Literal | undefined;
	readonly draft: string;
	readonly kind: "text" | "int" | "decimal";
	readonly nonEmpty?: boolean;
}): LiteralDraftPlan {
	const initial =
		kind === "text"
			? typeof value?.value === "string"
				? value.value
				: ""
			: typeof value?.value === "number"
				? String(value.value)
				: "";
	let next: string | number | null;
	if (kind === "text") {
		if (nonEmpty && draft === "")
			return { kind: "rejected", reason: "Enter a value" };
		next = draft;
	} else if (kind === "decimal" && draft.trim() === "") {
		next = null;
	} else {
		const parsed = finiteLiteralDraft(draft, kind === "int");
		if (parsed === undefined)
			return {
				kind: "rejected",
				reason: kind === "int" ? "Enter a whole number" : "Enter a number",
			};
		next = parsed;
	}
	if (draft === initial) return { kind: "unchanged" };
	return {
		kind: "commit",
		value:
			value === undefined
				? literal(next)
				: rebuildLiteralPreservingDataType(value, next),
	};
}
