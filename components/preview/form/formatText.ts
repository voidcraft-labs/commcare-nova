/**
 * Format text: what the toggle on a label or a help text, the check on a
 * choice and the form's own switch say and do. A text's `plainLabel` or
 * `plainHelp` is one setting shared by all its languages, so the gesture
 * belongs to the source language; a translation shows its source's state
 * read-only. A form's `plainText` turns formatting off for every label,
 * choice and help text in it; while it is on, each text's toggle shows off
 * and changes nothing, and the text's own setting is kept for when the
 * form's switch goes back on (`lib/domain/plainText.ts`).
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
/** Why a text's toggle can't change while its form's text formatting is off. */
export const FORMAT_TEXT_FORM_OFF =
	"Text formatting is off for this whole form";
/** The form's own switch, in its settings. */
export const FORM_FORMAT_TEXT_NAME = "Format text in this form";
/** The question asked before formatting is turned off for a form where some
 *  text uses it. */
export const FORM_FORMAT_TEXT_CONFIRM =
	"Some text in this form uses formatting. With Format text off, workers see its symbols as you typed them.";

/** Which text carries the setting: a question, group, repeat or section
 *  label, an inline choice, a help text, or the whole form. */
export type FormatTextOwner = "label" | "choice" | "help" | "form";

/**
 * The line under a text with Format text off, and under the form's own
 * switch, for the platforms the app declares. A label shows as typed on every
 * platform. A choice follows each platform's `plainChoice` rule and a help
 * text its `plainHelp` rule: a platform whose rule is `"markdown"` (Web Apps,
 * whose templates render every choice and every help text through Markdown)
 * formats it whatever its setting, and one whose rule is `"literal"`
 * (Android) shows it as typed. The form's line says what its switch does to
 * each of the three.
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
			.filter((platform) => {
				const rules = previewPlatformRules(platform);
				return (
					(owner === "choice" ? rules.plainChoice : rules.plainHelp) === rule
				);
			})
			.map((platform) => PLATFORM_LABELS[platform])
			.join(" and ");
	const formats = names("markdown");
	const literal = names("literal");
	if (owner === "form") {
		if (formats !== "" && literal !== "") {
			return `Off shows every label exactly as typed, and every choice and help text too on ${literal}. ${formats} still formats those two. It also keeps CommCare HQ's form builder from adding formatting.`;
		}
		if (literal !== "") {
			return "Off shows every label, choice and help text exactly as typed, and keeps CommCare HQ's form builder from adding formatting.";
		}
		return `Off shows every label exactly as typed. ${formats} still formats choices and help text. It also keeps CommCare HQ's form builder from adding formatting.`;
	}
	const text = owner === "choice" ? "choice" : "help";
	const every = owner === "choice" ? "every choice" : "every help text";
	if (formats !== "" && literal !== "") {
		return `On ${literal}, workers see this ${text} as you typed it. ${formats} formats ${every}.`;
	}
	if (literal !== "") {
		return `Workers see this ${text} as you typed it, without formatting.`;
	}
	return `${formats} formats ${every}, so workers see its formatting either way.`;
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
