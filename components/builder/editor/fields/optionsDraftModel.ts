import {
	isMintedSelectOptionPlaceholder,
	mintSelectOptionPlaceholder,
	type ProseTemplate,
	proseTemplateIsEmpty,
	proseTemplateText,
	repairSelectOptionValue,
	type SelectOption,
	selectOptionValueProblemAmong,
	suffixUntilFree,
	suggestSelectOptionValue,
} from "@/lib/domain";
import type { Media } from "@/lib/domain/multimedia";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

/** Object-key order in a parent snapshot cannot turn its echo into an external edit. */
export function optionsSnapshotKey(options: readonly SelectOption[]): string {
	return canonicalJsonText(options);
}

/** A row worth keeping at commit: anything with a label, a value, or
 *  media. A row carrying media is kept even with blank text so attaching
 *  an image and then blanking the text doesn't silently discard the
 *  asset reference along with the row. */
function rowHasContent(option: SelectOption): boolean {
	return (
		!proseTemplateIsEmpty(option.label) ||
		option.value.trim().length > 0 ||
		option.media !== undefined
	);
}

/**
 * The draft as it will be saved: rows with nothing on them dropped, and a
 * row whose value box was emptied (the sanitizer returns `""` for a lone
 * quote or a cleared box) given the value its label suggests, so a routine
 * clear-and-retype never lands a choice that saves nothing. The minted
 * fallback keeps the row's position, never a sibling's value.
 */
export function settleDraft<T extends SelectOption>(draft: T[]): T[] {
	const kept = draft.filter(rowHasContent);
	const taken = new Set(kept.map((option) => option.value));
	return kept.map((option, index) => {
		if (option.value.length > 0) return option;
		const value = repairSelectOptionValue(
			"",
			proseTemplateText(option.label),
			mintSelectOptionPlaceholder(index + 1).value,
			taken,
		);
		taken.add(value);
		return { ...option, value };
	});
}

/**
 * Why a row's value can't be saved beside its siblings, or `undefined`.
 * The value box already keeps a value inside the wire's grammar as it is
 * typed (`sanitizeSelectOptionValue`); this refuses the one thing a value
 * can't know alone, a value an earlier choice of the list holds, compared
 * exactly as the gate's `SELECT_OPTION_VALUE_DUPLICATE` compares. A blank
 * value is settled at commit, so it is no refusal here.
 */
export function optionValueRefusal(
	draft: readonly SelectOption[],
	index: number,
): string | undefined {
	const value = draft[index]?.value;
	if (value === undefined || value.length === 0) return undefined;
	const earlier = new Set(draft.slice(0, index).map((option) => option.value));
	if (selectOptionValueProblemAmong(value, earlier) !== "duplicate") {
		return undefined;
	}
	const free = suffixUntilFree(
		value,
		new Set(draft.map((option) => option.value)),
	);
	return `Another choice already stores "${value}", so a saved answer couldn't say which was chosen. "${free}" is free here.`;
}

/** Labels name only a fresh generated token; authored values and references stay independent. */
export function replaceOptionLabel<T extends SelectOption>(
	draft: T[],
	index: number,
	label: ProseTemplate,
): T[] {
	return draft.map((option, optionIndex) => {
		if (optionIndex !== index) return option;
		if (!isMintedSelectOptionPlaceholder(option)) return { ...option, label };
		const taken = new Set(
			draft
				.filter((_, otherIndex) => otherIndex !== index)
				.map((other) => other.value),
		);
		return {
			...option,
			label,
			value: suggestSelectOptionValue(
				proseTemplateText(label),
				option.value,
				taken,
			),
		};
	});
}
export function replaceOptionMedia<T extends SelectOption>(
	draft: T[],
	index: number,
	media: Media | undefined,
): T[] {
	return draft.map((option, optionIndex) => {
		if (optionIndex !== index) return option;
		const { media: _previous, ...base } = option;
		return (media ? { ...base, media } : base) as T;
	});
}
export function removeOptionDraft<T extends SelectOption>(
	draft: T[],
	index: number,
): T[] {
	return draft.length <= 2 || index < 0 || index >= draft.length
		? draft
		: draft.filter((_, optionIndex) => optionIndex !== index);
}
