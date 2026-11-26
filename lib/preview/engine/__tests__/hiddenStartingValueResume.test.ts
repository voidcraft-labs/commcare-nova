/**
 * A Hidden Value's starting value and calculation across a resume. A form
 * resumed from its saved entry runs every calculation again and no starting
 * value (`FormDef.initialize(false, …)`): what a starting value captured as
 * the form opened stays, and the calculation reads the answers given since.
 * The plausible failure is a resume that reruns starting values, so a value
 * captured at opening changes to what the same expression reads now.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { FormEngine } from "../formEngine";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const value = (engine: FormEngine, path: string) => engine.getState(path).value;

describe.each([
	["Web Apps", webAppsDevice()],
	["Android", androidDevice()],
])("a resumed entry on %s", (_platform, device) => {
	it("keeps what starting values captured and runs the calculation over later answers", () => {
		const source = engineFixtureInput(
			[
				{ id: "note", kind: "text" },
				{
					id: "stage",
					kind: "hidden",
					default_value: "'first'",
					calculate: "concat(#form/note, '!')",
				},
				{ id: "captured", kind: "text", default_value: "#form/stage" },
				{ id: "note_at_opening", kind: "text", default_value: "#form/note" },
			],
			{ formUuid: testUuid("hidden-resume-form"), formType: "survey" },
		);
		const engine = new FormEngine(
			source,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device },
		);
		// The later starting value reads the hidden value before its calculation runs.
		expect(value(engine, "/data/captured")).toBe("first");
		expect(value(engine, "/data/stage")).toBe("!");
		engine.setValue("/data/note", "seen");
		const resumed = new FormEngine(
			source,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				device,
				restoredEntry: {
					checkpoint: engine.entryCheckpoint(),
					preserveAllValues: true,
				},
			},
		);
		for (const playing of [engine, resumed]) {
			expect(value(playing, "/data/stage")).toBe("seen!");
			expect(value(playing, "/data/captured")).toBe("first");
			expect(value(playing, "/data/note_at_opening")).toBe("");
		}
	});
});
