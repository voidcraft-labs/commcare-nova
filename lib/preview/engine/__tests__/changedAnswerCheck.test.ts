/**
 * A form holding `validateChangedAnswersText` (`Pragma-Skip-Full-Form-Validation`)
 * on Web Apps accepts, at submission, an answer the worker left as it was when
 * it was last accepted, without checking it again: Formplayer's
 * `JsonActionUtils.questionAnswerToJson` returns ANSWER_OK when the submitted
 * value equals the instance's under `skipValidation`. So a later answer that
 * a constraint compares with can leave it in place. Android reads no such
 * text and checks every answer; a blank required answer is checked on both.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Form } from "@/lib/domain";
import { FormEngine } from "../formEngine";
import type { PreviewDevice } from "../previewDevice";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const FORM = testUuid("changed-answer-form");

function engineOn(device: PreviewDevice, held: boolean): FormEngine {
	const form: Partial<Form> = held
		? {
				validateChangedAnswersText: {
					carrier: { field: testUuid("form.start"), role: "field-label" },
				},
			}
		: {};
	return new FormEngine(
		engineFixtureInput(
			[
				{ id: "start", kind: "int", label: "Start" },
				{
					id: "finish",
					kind: "int",
					label: "Finish",
					validate: ". > #form/start",
				},
				{ id: "note", kind: "text", label: "Note", required: "true()" },
			],
			{ formUuid: FORM, formType: "survey", form },
		),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device },
	);
}

/** The worker answers all three, then moves Start past the accepted Finish. */
function answered(engine: FormEngine): FormEngine {
	engine.setValue("/data/start", "1");
	engine.touch("/data/start");
	engine.setValue("/data/finish", "5");
	engine.touch("/data/finish");
	engine.setValue("/data/note", "ok");
	engine.touch("/data/note");
	engine.setValue("/data/start", "9");
	engine.touch("/data/start");
	return engine;
}

describe("checking only changed answers", () => {
	it("keeps an accepted answer a later answer invalidates in Web Apps", () => {
		const engine = answered(engineOn(webAppsDevice(), true));
		expect(engine.validateAll()).toBe(true);
	});

	it("checks every answer in Web Apps without the setting, and on Android with it", () => {
		expect(answered(engineOn(webAppsDevice(), false)).validateAll()).toBe(
			false,
		);
		expect(answered(engineOn(androidDevice(), true)).validateAll()).toBe(false);
	});

	it("checks an answer the worker changed after it was accepted", () => {
		const engine = answered(engineOn(webAppsDevice(), true));
		engine.setValue("/data/finish", "4");
		engine.touch("/data/finish");
		expect(engine.validateAll()).toBe(false);
	});

	it("checks an answer again once it was cleared, as the cleared answer is the one held", () => {
		const engine = answered(engineOn(webAppsDevice(), true));
		engine.setValue("/data/start", "1");
		engine.touch("/data/start");
		engine.setValue("/data/finish", "");
		engine.touch("/data/finish");
		engine.setValue("/data/start", "9");
		engine.touch("/data/start");
		engine.setValue("/data/finish", "5");
		engine.touch("/data/finish");
		expect(engine.validateAll()).toBe(false);
	});

	it("still asks for a blank required answer", () => {
		const engine = answered(engineOn(webAppsDevice(), true));
		engine.setValue("/data/note", "");
		engine.touch("/data/note");
		expect(engine.validateAll()).toBe(false);
	});
});
