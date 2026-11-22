import type { ChoiceLayout } from "./choicePresentation";
import { fieldDisplaySettingsFor } from "./fieldDisplay";
import type { Field, MultiSelectField, SingleSelectField } from "./fields";
import type { Platform } from "./platforms";

/** Settings that a reader recognizes only when they are the control's
 * complete presentation, including its ordinary group-screen setting. */
export function hasOtherDisplay(field: Field, key: string): boolean {
	return (
		fieldDisplaySettingsFor(field.kind).some(
			(setting) =>
				setting.key !== key && Reflect.get(field, setting.key) !== undefined,
		) ||
		(field.kind === "group" && field.fieldList === true)
	);
}

export function usesNumberKeypad(field: Field, platform: Platform): boolean {
	if (!("keypad" in field) || !field.keypad) return false;
	if (platform === "web-apps")
		return (
			field.keypad === "numbers" &&
			!("addressLookup" in field && field.addressLookup)
		);
	return field.kind !== "barcode" && !hasOtherDisplay(field, "keypad");
}

type EffectiveLayout = Exclude<ChoiceLayout, { kind: "platforms" }>;
export function choiceLayoutForPlatform(
	field: SingleSelectField | MultiSelectField,
	platform: Platform,
): EffectiveLayout | undefined {
	const layout = field.choiceLayout;
	if (!layout) return undefined;
	if (layout.kind === "platforms") {
		const effective = platform === "android" ? layout.android : layout.web;
		if (effective.kind === "ordinary") return undefined;
		if (effective.kind === "grid" || effective.kind === "search")
			return effective;
		return { kind: effective.kind };
	}
	if (platform === "web-apps")
		return ["grid", "advance-on-choice", "row"].includes(layout.kind)
			? undefined
			: layout;
	if (layout.kind === "buttons") return undefined;
	if (
		[
			"dropdown",
			"advance-on-choice",
			"row",
			"row-without-label",
			"headings",
		].includes(layout.kind) &&
		hasOtherDisplay(field, "choiceLayout")
	)
		return undefined;
	return layout;
}

/** The kind has the slot structurally. A sender and its receiver still
 * depend on which entry the selected platform actually constructs. */
export function canOfferDisplaySetting(
	field: Field,
	key: string,
	hasRepeat: boolean,
): boolean {
	if (
		Object.hasOwn(field, key) ||
		!fieldDisplaySettingsFor(field.kind).some((setting) => setting.key === key)
	)
		return true;
	if (key === "receiveFrom") {
		if ("addressLookup" in field && field.addressLookup) return false;
		if (field.kind !== "single_select") return true;
		const active = choiceLayoutForPlatform(field, "web-apps");
		return !active || active.kind === "search";
	}
	if (key === "sendTopics") {
		if (
			field.kind === "text" ||
			field.kind === "secret" ||
			field.kind === "barcode"
		)
			return field.addressLookup === true;
		return field.kind !== "image" || !field.webSignature;
	}
	if (
		field.kind === "group" &&
		field.fieldList &&
		["compact", "collapse", "border", "itemsPerRow", "repeatsPerRow"].includes(
			key,
		)
	)
		return false;
	if (key === "repeatsPerRow") return hasRepeat;
	if (field.kind === "signature") return false;
	if (
		field.kind === "label" &&
		!field.banner &&
		["hintPlacement", "itemsPerRow", "textAlignment"].includes(key)
	)
		return false;
	if (key === "webSignature" && field.kind === "image")
		return hasOtherDisplay(field, "webSignature");
	return true;
}

/** Web Apps hides the hint's usual line on every entry using this setting.
 * Only the entry templates with a placeholder can then show its words. */
export function webShowsHintInEntry(field: Field): boolean {
	if (field.kind === "single_select" || field.kind === "multi_select") {
		const active = choiceLayoutForPlatform(field, "web-apps")?.kind;
		return active === "dropdown" || active === "search";
	}
	if (field.kind === "secret") return usesNumberKeypad(field, "web-apps");
	return (
		field.kind === "int" ||
		field.kind === "decimal" ||
		((field.kind === "text" || field.kind === "barcode") &&
			!field.addressLookup)
	);
}
