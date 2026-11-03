/**
 * Format text: what the toggle on a label and the check on a choice say and
 * do. A text's `plainLabel` is one setting shared by all its languages, so
 * the gesture belongs to the source language; a translation shows its
 * source's state read-only.
 */

import { PLATFORM_LABELS, type Platform } from "@/lib/domain/platforms";
import { previewPlatformRules } from "@/lib/preview/platform";

/** The toggle's name, on the label toolbar and in a choice's overflow. */
export const FORMAT_TEXT_NAME = "Format text";
/** Why a formatting button is unavailable while Format text is off. */
export const FORMAT_TEXT_UNAVAILABLE = "Available with Format text on";
/** Why the toggle can't change under a worker language other than the source. */
export const FORMAT_TEXT_FOLLOWS_SOURCE = "Formatting follows the source text";
/** The question asked before formatting is turned off on a text that uses it. */
export const FORMAT_TEXT_CONFIRM =
	"This text uses formatting. With Format text off, workers see its symbols as you typed them.";
export const FORMAT_TEXT_CONFIRM_OFF = "Turn it off";
export const FORMAT_TEXT_CONFIRM_KEEP = "Keep formatting";

/** Which text carries the setting: a question, group, repeat or section
 *  label, or an inline choice. */
export type FormatTextOwner = "label" | "choice";

/**
 * The line under a text with Format text off, for the platforms the app
 * declares. A label shows as typed on every platform. A choice follows each
 * platform's `plainChoice` rule: a platform whose rule is `"markdown"` (Web
 * Apps, whose choice templates render each label through Markdown) formats
 * every choice whatever its setting, and one whose rule is `"literal"`
 * (Android) shows it as typed.
 */
export function formatTextOffLine(
	owner: FormatTextOwner,
	platforms: readonly Platform[],
): string {
	if (owner === "label") {
		return "Workers see this text as you typed it, without formatting.";
	}
	const names = (rule: "markdown" | "literal") =>
		platforms
			.filter((platform) => previewPlatformRules(platform).plainChoice === rule)
			.map((platform) => PLATFORM_LABELS[platform])
			.join(" and ");
	const formats = names("markdown");
	const literal = names("literal");
	if (formats !== "" && literal !== "") {
		return `On ${literal}, workers see this choice as you typed it. ${formats} formats every choice.`;
	}
	if (literal !== "") {
		return "Workers see this choice as you typed it, without formatting.";
	}
	return `${formats} formats every choice, so workers see its formatting either way.`;
}

/** What pressing the toggle does. */
export type FormatTextGesture =
	/** Write `plainLabel`: `true` turns formatting off, `null` turns it on. */
	| { readonly kind: "write"; readonly plainLabel: true | null }
	/** Ask first: the text uses formatting a worker would see as symbols. */
	| { readonly kind: "confirm" }
	/** Nothing changes here: the setting follows the source text. */
	| { readonly kind: "none" };

/**
 * The toggle's gesture. Turning formatting on always writes at once; turning
 * it off asks first only when the text holds formatting, which is read
 * lazily because it walks the text's Markdown reading.
 */
export function formatTextGesture(input: {
	readonly plain: boolean;
	readonly isSource: boolean;
	readonly holdsFormatting: () => boolean;
}): FormatTextGesture {
	if (!input.isSource) return { kind: "none" };
	if (input.plain) return { kind: "write", plainLabel: null };
	return input.holdsFormatting()
		? { kind: "confirm" }
		: { kind: "write", plainLabel: true };
}
