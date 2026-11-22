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
