/** Form control display projection. The receiving editors and workers distinguish
 * exact strings, substrings and positional words. Settings do not sort their
 * words globally; each widget builds the order the receiving controls need. */

import type { z } from "zod";
import type { BlueprintDoc, Field, FieldKind } from "@/lib/domain";
import { isCaptureFieldKind } from "@/lib/domain";
import type { ChoiceLayout } from "@/lib/domain/choicePresentation";
import type { displaySchemas } from "@/lib/domain/questionDisplaySchemas";
import { UPLOAD_APPEARANCE_BY_CAPTURE_KIND } from "./captureUpload";
import { writeChoiceLayout } from "./choiceAppearance";

export const FIELD_DISPLAY_SETTING_TOKENS = {
	keypad: { numbers: "numeric", "android-numbers": "numbers" },
	inputWidth: { short: "short", medium: "medium" },
	calendar: {
		ethiopian: "ethiopian",
		nepali: "nepali",
		gregorian: "gregorian",
		"gregorian-with-clear": "gregorian cancel",
	},
	clock: { "twelve-hour": "12-hour" },
	locationPicker: { map: "maps" },
	captureSource: {
		camera: "acquire",
		"face-camera": "face",
		"record-or-choose": "acquire-or-upload",
	},
	overlaySize: { small: "overlay-small" },
	recorder: { legacy: "legacy" },
	banner: {
		good: "floating-good",
		caution: "floating-caution",
		bad: "floating-bad",
		hidden: "floating-hidden",
	},
	collapse: { closed: "group-collapse", open: "group-collapse collapse-open" },
	textAlignment: { center: "text-align-center", right: "text-align-right" },
} as const;

export type DisplaySettings = {
	[K in Exclude<keyof typeof displaySchemas, "choiceLayout">]?: z.infer<
		(typeof displaySchemas)[K]
	>;
} & {
	choiceLayout?: ChoiceLayout;
	fieldList?: true;
	askForConfirmation?: boolean;
};

export function kindAppearanceToken(
	kind: FieldKind,
	shape: { readonly fieldList?: true } = {},
): string | undefined {
	if (kind === "label") return "minimal";
	if (kind === "section" || (kind === "group" && shape.fieldList))
		return "field-list";
	if (isCaptureFieldKind(kind)) return UPLOAD_APPEARANCE_BY_CAPTURE_KIND[kind];
	return undefined;
}

/** This also takes a reader's proposed settings so its spelling can be
 * re-classified before accepting a non-canonical source. */
export function writeFieldAppearance(
	kind: FieldKind,
	settings: DisplaySettings,
): string | undefined {
	const words: string[] = [];
	const kindToken = kindAppearanceToken(kind, settings);
	if (
		kindToken &&
		!(kind === "label" && settings.askForConfirmation) &&
		!(kind === "label" && (settings.selectableText || settings.banner))
	)
		words.push(kindToken);
	// The first word of a floating label determines Android visibility; the
	// complete value decides whether a colored banner is actually shown.
	if (settings.banner)
		words.push(FIELD_DISPLAY_SETTING_TOKENS.banner[settings.banner]);
	if (settings.selectableText) words.push("selectable");
	if (settings.webSignature) words.push("signature");
	if (settings.choiceLayout)
		words.push(writeChoiceLayout(settings.choiceLayout));
	if (settings.keypad)
		words.push(FIELD_DISPLAY_SETTING_TOKENS.keypad[settings.keypad]);
	if (settings.addressLookup) words.push("address");
	if (settings.scanOnOpen) words.push("quick");
	if (settings.canEditScan) words.push("editable");
	if (settings.calendar)
		words.push(FIELD_DISPLAY_SETTING_TOKENS.calendar[settings.calendar]);
	if (settings.clock) words.push("12-hour");
	if (settings.locationPicker) words.push("maps");
	if (settings.captureSource)
		words.push(
			FIELD_DISPLAY_SETTING_TOKENS.captureSource[settings.captureSource],
		);
	if (settings.overlaySize) words.push("overlay-small");
	if (settings.recorder) words.push("legacy");
	if (settings.pauseRecording) words.push("long");
	if (settings.compact) words.push("compact");
	if (settings.collapse)
		words.push(FIELD_DISPLAY_SETTING_TOKENS.collapse[settings.collapse]);
	if (settings.border) words.push("group-border");
	if (settings.inputWidth) words.push(settings.inputWidth);
	if (settings.hintPlacement) words.push("hint-as-placeholder");
	if (settings.textAlignment)
		words.push(
			FIELD_DISPLAY_SETTING_TOKENS.textAlignment[settings.textAlignment],
		);
	if (settings.itemsPerRow !== undefined)
		words.push(`${settings.itemsPerRow}-per-row`);
	if (settings.repeatsPerRow !== undefined)
		words.push(`${settings.repeatsPerRow}-per-row-repeat`);
	for (const topic of settings.sendTopics ?? [])
		words.push(`broadcast-${topic}`);
	if (settings.receiveFrom)
		words.push(
			`receive-${settings.receiveFrom.channel}-${settings.receiveFrom.field}`,
		);
	return words.length ? words.join(" ") : undefined;
}

function androidAppAppearance(
	field: Field,
	fields?: BlueprintDoc["fields"],
): string | undefined {
	const answer = "androidApp" in field ? field.androidApp : undefined;
	if (!answer) return undefined;
	const source = answer.kind === "open-app" ? field : fields?.[answer.question];
	if (source?.kind !== "text" || source.androidApp?.kind !== "open-app")
		throw new Error(`Question ${field.id} has no Android app to open.`);
	return `intent:${source.id}`;
}

export function fieldAppearance(
	field: Field,
	fields?: BlueprintDoc["fields"],
): string | undefined {
	return (
		androidAppAppearance(field, fields) ??
		writeFieldAppearance(field.kind, field as DisplaySettings)
	);
}
