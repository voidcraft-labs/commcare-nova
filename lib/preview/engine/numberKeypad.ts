// lib/preview/engine/numberKeypad.ts
//
// What each platform does with what a worker types into a Text question with
// a number keypad (`keypad: "numbers"`). The answer is text on both; Web Apps
// refuses an answer its pattern does not match and keeps the earlier one,
// and Android limits the keys, so its box holds only the characters its
// keypad offers. `formEngine.ts` reads both through the platform's
// `numberKeypad` rule.

import type { PreviewPlatformRules } from "../platform";

/** Web Apps' own pattern, `entries.js::PhoneEntry`. */
export const WEB_APPS_NUMBER_KEYPAD_ANSWER = /^[+-]?\d*(\.\d+)?$/;

/** The keys Android's widget accepts, `StringNumberWidget.java`. */
export const ANDROID_NUMBER_KEYPAD_KEYS = "0123456789.-+ ";

/** What typing leaves in the box: on Android, the text without the keys the keypad lacks. */
export function numberKeypadTyped(
	rule: PreviewPlatformRules["numberKeypad"],
	raw: string,
): string {
	if (rule === "pattern") return raw;
	let typed = "";
	for (const character of raw)
		if (ANDROID_NUMBER_KEYPAD_KEYS.includes(character)) typed += character;
	return typed;
}

/** Whether the engine stores the answer: on Web Apps, only one the pattern matches. */
export function numberKeypadStores(
	rule: PreviewPlatformRules["numberKeypad"],
	raw: string,
): boolean {
	if (rule === "keys") return true;
	return raw === "" || WEB_APPS_NUMBER_KEYPAD_ANSWER.test(raw);
}
