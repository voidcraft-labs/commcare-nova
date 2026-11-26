import {
	type Field,
	type Form,
	fieldProseTemplate,
	helpShowsAsTyped,
	labelShowsAsTyped,
	type SelectOption,
} from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";
import { choiceLayoutForPlatform } from "@/lib/domain/questionDisplay";

/** Core's normal text reader prefers the extended form. Android's help dialog
 * asks for the Markdown form before calling that reader. */
export function workerFieldProseSlot(
	field: Field,
	slot: "hint" | "help" | "validate_msg",
	form: Pick<Form, "plainText">,
	platform: Platform,
) {
	switch (slot) {
		case "hint":
			return fieldProseTemplate(field, "extended_hint") === undefined
				? "hint"
				: "extended_hint";
		case "help":
			return fieldProseTemplate(field, "extended_help") === undefined ||
				(platform === "android" &&
					!helpShowsAsTyped(form, "plainHelp" in field ? field : {}))
				? "help"
				: "extended_help";
		case "validate_msg":
			return fieldProseTemplate(field, "extended_validate_msg") === undefined
				? "validate_msg"
				: "extended_validate_msg";
	}
}

/** Formplayer, Android spinners and the Android combobox use Core's normal
 * choice text. Android radio, checkbox, list and heading widgets try Markdown
 * first. Compact Android single-select draws an image grid, and multi-select
 * uses the normal text when it lacks an image. */
export function workerChoiceProse(
	field: Extract<Field, { kind: "single_select" | "multi_select" }>,
	option: SelectOption,
	form: Pick<Form, "plainText">,
	platform: Platform,
) {
	const layout = choiceLayoutForPlatform(field, platform)?.kind;
	const nativeMarkdown =
		platform === "android" &&
		!labelShowsAsTyped(form, option) &&
		layout !== "dropdown" &&
		layout !== "search" &&
		layout !== "grid";
	return option.extended_text !== undefined && !nativeMarkdown
		? { slot: "option_extended_text" as const, template: option.extended_text }
		: { slot: "option_label" as const, template: option.label };
}
