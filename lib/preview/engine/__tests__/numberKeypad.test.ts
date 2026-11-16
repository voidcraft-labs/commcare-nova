/**
 * What Preview does with what a worker types into a Text question with a
 * number keypad, under each platform's rule.
 *
 * Web Apps (`form_entry/entries.js::PhoneEntry`) stores an answer only where
 * it matches `^[+-]?\d*(\.\d+)?$`; otherwise it shows its message and keeps
 * the earlier answer. Android (`views/widgets/StringNumberWidget.java`)
 * limits the keys to the digits, `.`, `-`, `+` and space, keeps a `+` or `-`
 * only as the box's first character and only its first period, and stores
 * what the box keeps. The form engine's state is read through its store and the
 * instance through a Hidden Value calculated from the answer, so these show:
 * Web Apps storing `12 34`, or losing the earlier answer on a refusal or a
 * rebuild after one, or showing no message, or opening a request for a
 * refused answer on the worker runtime Preview runs on; Android keeping a
 * letter, a sign after the first character or a second period. The Android
 * vectors are the
 * four the lane's Android reader enters (`proof/android/test_form_reads.py`,
 * `targeted-number-keypad`), with what a phone keeps of each.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import type { XPathWorkerEvaluateRequest } from "../../xpath/workerProtocol";
import { EngineController } from "../engineController";
import { FormEngine, type FormEngineAsyncEvaluator } from "../formEngine";
import {
	numberKeypadStores,
	numberKeypadTyped,
	WEB_APPS_NUMBER_KEYPAD_ANSWER,
} from "../numberKeypad";
import type { PreviewDevice } from "../previewDevice";
import { admittedControllerDoc } from "./fixtures/controllerDoc";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const REFUSAL =
	"This answer takes digits, with an optional + or - in front and an optional decimal part.";

/** What Android's box keeps of what a worker enters, read on a device by the lane. */
const ANDROID_KEPT = {
	"+1 555-1234": "+1 5551234",
	"1.2.3": "1.23",
	"12+": "12",
	a1: "1",
} as const;

function keypadInput() {
	return engineFixtureInput(
		[
			{ id: "phone", kind: "text", label: "Phone", keypad: "numbers" },
			{ id: "held", kind: "hidden", calculate: "#form/phone" },
			{ id: "plain", kind: "text", label: "Plain" },
		],
		{ formUuid: testUuid("keypad-form"), formType: "survey" },
	);
}

function engineOn(
	device: PreviewDevice,
	input = keypadInput(),
	stagedAsync = false,
): FormEngine {
	return new FormEngine(
		input,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device, stagedAsync },
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

	it("keeps the earlier answer when the engine rebuilds over a refused one", () => {
		const input = keypadInput();
		const engine = engineOn(webAppsDevice(), input);
		engine.setValue("/data/phone", "0712");
		engine.setValue("/data/phone", "12 34");
		engine.touch("/data/phone");
		engine.updateSchema(input);
		expect(engine.getState("/data/phone")).toMatchObject({
			value: "12 34",
			valid: false,
			errorMessage: REFUSAL,
		});
		expect(engine.getState("/data/held").value).toBe("0712");
	});

	it("never checks a starting value the worker did not type, as Web Apps seeds it without checking", () => {
		const input = engineFixtureInput(
			[
				{
					id: "phone",
					kind: "text",
					label: "Phone",
					keypad: "numbers",
					default_value: "'555 123-4567'",
				},
				{ id: "held", kind: "hidden", calculate: "#form/phone" },
			],
			{ formUuid: testUuid("keypad-seeded-form"), formType: "survey" },
		);
		const engine = engineOn(webAppsDevice(), input);
		engine.touch("/data/phone");
		expect(engine.getState("/data/phone")).toMatchObject({
			value: "555 123-4567",
			valid: true,
		});
		expect(engine.validateAll()).toBe(true);
		expect(engine.getState("/data/held").value).toBe("555 123-4567");

		/* Typing over it is checked; typing the seeded text back is checked
		 * too, as Web Apps checks every answer the worker enters. */
		engine.setValue("/data/phone", "555 123-4568");
		engine.touch("/data/phone");
		expect(engine.getState("/data/phone")).toMatchObject({
			valid: false,
			errorMessage: REFUSAL,
		});
		expect(engine.getState("/data/held").value).toBe("555 123-4567");
		engine.updateSchema(input);
		expect(engine.getState("/data/phone")).toMatchObject({
			value: "555 123-4568",
			valid: false,
			errorMessage: REFUSAL,
		});
		engine.setValue("/data/phone", "555 123-4567");
		engine.touch("/data/phone");
		expect(engine.getState("/data/phone")).toMatchObject({
			valid: false,
			errorMessage: REFUSAL,
		});
		expect(engine.validateAll()).toBe(false);
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

describe("a number keypad in Web Apps on the worker runtime", () => {
	const FORM_UUID = testUuid("keypad-async-form");
	const MODULE_UUID = testUuid("keypad-async-module");
	const PHONE_UUID = testUuid("keypad-async-phone");
	const HELD_UUID = testUuid("keypad-async-held");

	it("opens no request for a refused answer, whose engine keeps the earlier answer", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		const engine = engineOn(webAppsDevice(), keypadInput(), true);
		const world = engine.createWorkerWorld("keypad");
		let requests = 0;
		const evaluateAsync = (async (
			source,
			path,
			resultMode = "scalar",
			state,
		) => {
			requests += 1;
			const result = await runtime.request({
				dayNumberEpoch: engine.dayNumberEpoch,
				entryKey: "33333333-3333-4333-8333-333333333333",
				revision: 0,
				profile: "form",
				source,
				resultMode,
				instances: engine.workerInstances(path, world, state),
			});
			if (!result.ok) throw new Error(result.error.code);
			if (result.nodesetValues !== undefined)
				return {
					kind: "nodeset-values" as const,
					values: result.nodesetValues,
				};
			return deserializeXPathWorkerValue(result.value);
		}) as FormEngineAsyncEvaluator;
		try {
			await engine.initializeAsync(evaluateAsync);
			await engine.setValueAsync("/data/phone", "0712", evaluateAsync);
			expect(engine.getState("/data/held").value).toBe("0712");
			requests = 0;
			await engine.setValueAsync("/data/phone", "12 34", evaluateAsync);
			expect(requests).toBe(0);
			expect(engine.getState("/data/phone")).toMatchObject({
				value: "12 34",
				valid: false,
				errorMessage: REFUSAL,
			});
			expect(engine.getState("/data/held").value).toBe("0712");
		} finally {
			runtime.dispose();
		}
	});

	it("stages nothing and starts no revision for a refused answer in Preview's controller", async () => {
		const requests: XPathWorkerEvaluateRequest[] = [];
		const factory = createInProcessXPathWorkerFactory();
		const runtime = new XPathRuntime({
			workerFactory: () => {
				const port = factory();
				return {
					...port,
					postMessage(message) {
						if (message.operation === "evaluate") requests.push(message);
						port.postMessage(message);
					},
				};
			},
		});
		const store = createBlueprintDocStore();
		store.getState().load(
			admittedControllerDoc({
				appId: "app",
				appName: "App",
				connectType: null,
				appSettings: { showSavedForms: false, showIncompleteForms: false },
				caseTypes: null,
				modules: {
					[MODULE_UUID]: { uuid: MODULE_UUID, id: "module", name: "Module" },
				},
				forms: {
					[FORM_UUID]: {
						uuid: FORM_UUID,
						id: "form",
						name: "Form",
						type: "survey",
					},
				},
				fields: {
					[PHONE_UUID]: {
						uuid: PHONE_UUID,
						id: "phone",
						kind: "text",
						label: proseText("Phone"),
						keypad: "numbers",
					},
					[HELD_UUID]: {
						uuid: HELD_UUID,
						id: "held",
						kind: "hidden",
						calculate: "/data/phone",
					},
				},
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: [FORM_UUID] },
				fieldOrder: { [FORM_UUID]: [PHONE_UUID, HELD_UUID] as Uuid[] },
			}),
		);
		store.getState().startTracking();
		const ctrl = new EngineController(runtime);
		ctrl.setDocStore(store);
		try {
			await ctrl.activateFormAsync(FORM_UUID);
			await ctrl.onValueChangeAsync(PHONE_UUID, "0712");
			expect(ctrl.store.getState()[HELD_UUID]?.value).toBe("0712");
			requests.length = 0;
			await ctrl.onValueChangeAsync(PHONE_UUID, "12 34");
			await ctrl.awaitSettled();
			expect(requests).toHaveLength(0);
			expect(ctrl.store.getState()[PHONE_UUID]).toMatchObject({
				value: "12 34",
				valid: false,
				errorMessage: REFUSAL,
			});
			await ctrl.onTouchAsync(PHONE_UUID);
			expect(ctrl.store.getState()[PHONE_UUID]).toMatchObject({
				valid: false,
				errorMessage: REFUSAL,
			});
			expect(ctrl.store.getState()[HELD_UUID]?.value).toBe("0712");
			expect(await ctrl.validateAllAsync()).toMatchObject({ kind: "invalid" });
			expect(ctrl.entryStore.getState().fault).toBeUndefined();
		} finally {
			ctrl.dispose();
			await ctrl.awaitSettled();
		}
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
		expect(numberKeypadTyped("keys", "a-1")).toBe("-1");
		expect(numberKeypadTyped("keys", "-+1-.5.")).toBe("-1.5");
		expect(numberKeypadStores("keys", "12 34")).toBe(true);
	});
});
