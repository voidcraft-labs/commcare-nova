/**
 * What Preview does with what a worker types into a Text question with a
 * number keypad, under each platform's rule.
 *
 * Web Apps (`form_entry/entries.js::PhoneEntry`) stores an answer only where
 * it matches `^[+-]?\d*(\.\d+)?$`; otherwise it shows its message and keeps
 * the earlier answer. Android (`views/widgets/StringNumberWidget.java`)
 * limits the keys to the digits, `.`, `-`, `+` and space, and stores what the
 * box keeps. The form engine's state is read through its store and the
 * instance through a Hidden Value calculated from the answer, so these show:
 * Web Apps storing `12 34`, or losing the earlier answer on a refusal, or
 * showing no message; Android keeping a letter. The Android vectors are the
 * four the lane's Android reader enters (`proof/android/test_form_reads.py`,
 * `targeted-number-keypad`), with what a phone keeps of each.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { FormEngine } from "../formEngine";
import {
	numberKeypadStores,
	numberKeypadTyped,
	WEB_APPS_NUMBER_KEYPAD_ANSWER,
} from "../numberKeypad";
import type { PreviewDevice } from "../previewDevice";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const REFUSAL =
	"This answer takes digits, with an optional + or - in front and an optional decimal part.";

/** What Android's box keeps of what a worker enters, read on a device by the lane. */
const ANDROID_KEPT = {
	"+1 555-1234": "+1 555-1234",
	"1.2.3": "1.2.3",
	"12+": "12+",
	a1: "1",
} as const;

function engineOn(device: PreviewDevice): FormEngine {
	return new FormEngine(
		engineFixtureInput(
			[
				{ id: "phone", kind: "text", label: "Phone", keypad: "numbers" },
				{ id: "held", kind: "hidden", calculate: "#form/phone" },
				{ id: "plain", kind: "text", label: "Plain" },
			],
			{ formUuid: testUuid("keypad-form"), formType: "survey" },
		),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device },
	);
}

describe("a number keypad in Web Apps", () => {
	it("stores an answer its pattern matches, a leading zero and a plus sign kept", () => {
		const engine = engineOn(webAppsDevice());
		for (const answer of ["0712", "+254712", "-3.5", ""]) {
			engine.setValue("/data/phone", answer);
			engine.touch("/data/phone");
			expect(engine.getState("/data/held").value).toBe(answer);
			expect(engine.getState("/data/phone")).toMatchObject({
				value: answer,
				valid: true,
			});
		}
	});

	it("refuses an answer its pattern does not match with its message, keeping the earlier answer", () => {
		const engine = engineOn(webAppsDevice());
		engine.setValue("/data/phone", "0712");
		for (const refused of ["12 34", "555-1234", "1.", "a1"]) {
			engine.setValue("/data/phone", refused);
			engine.touch("/data/phone");
			expect(engine.getState("/data/phone")).toMatchObject({
				value: refused,
				valid: false,
				errorMessage: REFUSAL,
			});
			expect(engine.getState("/data/held").value).toBe("0712");
		}
		expect(engine.validateAll()).toBe(false);
		engine.setValue("/data/phone", "0713");
		engine.touch("/data/phone");
		expect(engine.getState("/data/phone").valid).toBe(true);
		expect(engine.getState("/data/held").value).toBe("0713");
		expect(engine.validateAll()).toBe(true);
	});

	it("leaves a Text question without the keypad alone", () => {
		const engine = engineOn(webAppsDevice());
		engine.setValue("/data/plain", "12 34");
		engine.touch("/data/plain");
		expect(engine.getState("/data/plain")).toMatchObject({
			value: "12 34",
			valid: true,
		});
	});
});

describe("a number keypad on Android", () => {
	it.each(Object.entries(ANDROID_KEPT))(
		"keeps %j as a phone's keypad keeps it",
		(entered, kept) => {
			const engine = engineOn(androidDevice());
			engine.setValue("/data/phone", entered);
			engine.touch("/data/phone");
			expect(engine.getState("/data/phone")).toMatchObject({
				value: kept,
				valid: true,
			});
			expect(engine.getState("/data/held").value).toBe(kept);
		},
	);
});

describe("the keypad rules", () => {
	it("hold Web Apps' own pattern", () => {
		expect(WEB_APPS_NUMBER_KEYPAD_ANSWER.source).toBe("^[+-]?\\d*(\\.\\d+)?$");
		expect(numberKeypadStores("pattern", "+.5")).toBe(true);
		expect(numberKeypadStores("pattern", "٣")).toBe(false);
		expect(numberKeypadTyped("pattern", "a1")).toBe("a1");
	});

	it("leave Android's text to its keys and store it whatever it holds", () => {
		expect(numberKeypadTyped("keys", "٣a 1")).toBe(" 1");
		expect(numberKeypadStores("keys", "12 34")).toBe(true);
	});
});
