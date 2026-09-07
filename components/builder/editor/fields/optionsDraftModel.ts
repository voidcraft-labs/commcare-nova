import {
	isMintedSelectOptionPlaceholder,
	mintSelectOptionPlaceholder,
	type ProseTemplate,
	proseTemplateIsEmpty,
	proseTemplateText,
	repairSelectOptionValue,
	type SelectOption,
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
