// lib/commcare/xform/appearance.ts
//
// The one writer of an XForm control's `appearance` attribute. CommCare holds
// how a control is drawn in one attribute, a string of space-separated
// tokens; Nova holds each choice as its own typed fact: a kind (`label`,
// `signature`), a container's shape (a section, a group holding `fieldList`)
// and the display settings of `lib/domain/fieldDisplay.ts`. This file turns
// those facts into the string, total over `Field`, and `builder.ts` writes
// whatever it returns and holds no token of its own.
//
// The suite's `<prompt appearance>` is a Search field's widget, which the
// Search input's own kind decides, and is written by
// `suite/case-search/searchPrompts.ts`.

import {
	type FIELD_DISPLAY_SETTINGS,
	type Field,
	type FieldDisplaySettingKey,
	fieldDisplayValues,
	isCaptureFieldKind,
} from "@/lib/domain";
import { UPLOAD_APPEARANCE_BY_CAPTURE_KIND } from "./captureUpload";

/** The token each value of each display setting writes. */
export const FIELD_DISPLAY_SETTING_TOKENS: {
	readonly [K in FieldDisplaySettingKey]: Readonly<
		Record<
			keyof Extract<
				(typeof FIELD_DISPLAY_SETTINGS)[number],
				{ key: K }
			>["values"],
			string
		>
	>;
} = {
	/* Vellum's Phone Number or Numeric ID question (`src/mugs/types/text.js::PhoneNumber`)
	 * is a Text mug whose appearance is the whole string `numeric`; Web Apps
	 * draws `PhoneEntry` for the token and Android `StringNumberWidget`. */
	keypad: { numbers: "numeric" },
};

/** The token a field's own kind or shape carries, before any setting. */
function kindToken(field: Field): string | undefined {
	if (field.kind === "label") return "minimal";
	if (field.kind === "section") return "field-list";
	if (field.kind === "group" && field.fieldList === true) return "field-list";
	if (isCaptureFieldKind(field.kind))
		return UPLOAD_APPEARANCE_BY_CAPTURE_KIND[field.kind];
	return undefined;
}

/** The `appearance` a field's control carries, or undefined for none. The kind's own token first,
 *  then each display setting's token in `FIELD_DISPLAY_SETTINGS` order, joined by one space. */
export function fieldAppearance(field: Field): string | undefined {
	const tokens: string[] = [];
	const own = kindToken(field);
	if (own !== undefined) tokens.push(own);
	for (const { key, value } of fieldDisplayValues(field)) {
		const byValue: Readonly<Record<string, string>> =
			FIELD_DISPLAY_SETTING_TOKENS[key];
		const token = Object.hasOwn(byValue, value) ? byValue[value] : undefined;
		if (token !== undefined) tokens.push(token);
	}
	return tokens.length === 0 ? undefined : tokens.join(" ");
}
