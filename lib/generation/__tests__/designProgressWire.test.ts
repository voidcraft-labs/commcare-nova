/**
 * The client-safe progress wire is a RESTATEMENT of `lib/agent/build/progress`
 * (that module's type graph reaches the design-artifact schemas and the
 * design-session row, which must not enter the chat client's bundle graph).
 * Runtime tests feed actual server envelopes into client parsers; the
 * companion .test-d.ts owns compiler-level mutual assignability.
 */

import { describe, expect, it } from "vitest";
import { progressEnvelope } from "@/lib/agent/build/progress";
import {
	DESIGN_BUILD_STAGES,
	DESIGN_PULSE_PHASES,
	designPulseStage,
	designStageIsWorking,
	parseBuildCompletion,
	parseBuildLocalization,
	parseBuildPlanSummary,
	parseBuildSliceCommitted,
	parseDesignOutline,
	parseDesignPulse,
	parseDesignSessionScope,
} from "@/lib/generation/designProgressWire";

const SESSION = "11111111-1111-4111-8111-111111111111";

function envelope(data: unknown, designSessionId = SESSION) {
	return progressEnvelope(designSessionId, null, data);
}

describe("design progress wire", () => {
	it("maps every pulse phase onto a working stage", () => {
		for (const phase of DESIGN_PULSE_PHASES) {
			const stage = designPulseStage(phase);
			expect(DESIGN_BUILD_STAGES).toContain(stage);
			expect(designStageIsWorking(stage)).toBe(true);
		}
	});

	it("reads a pulse frame and refuses a malformed one", () => {
		expect(
			parseDesignPulse(envelope({ phase: "review", chars: 1200 }), SESSION),
		).toEqual({ phase: "review", chars: 1200 });
		expect(
			parseDesignPulse(envelope({ phase: "compile", chars: 1 }), SESSION),
		).toBeNull();
		expect(
			parseDesignPulse(envelope({ phase: "design", chars: -1 }), SESSION),
		).toBeNull();
		expect(
			parseDesignPulse(
				envelope({ phase: "design", chars: 5 }, "other"),
				SESSION,
			),
		).toBeNull();
	});

	it("reads bounded translation progress", () => {
		expect(
			parseBuildLocalization(
				envelope({
					languageTag: "spa",
					languageName: "Español",
					batch: 2,
					batchCount: 4,
				}),
				SESSION,
			),
		).toEqual({
			languageTag: "spa",
			languageName: "Español",
			batch: 2,
			batchCount: 4,
		});
		expect(
			parseBuildLocalization(
				envelope({
					languageTag: "spa",
					languageName: "Español",
					batch: 0,
					batchCount: 4,
				}),
				SESSION,
			),
		).toBeNull();
	});

	it("treats only the halted stages as not working", () => {
		const halted = DESIGN_BUILD_STAGES.filter(
			(stage) => !designStageIsWorking(stage),
		);
		expect(halted).toEqual(["ready", "needs-input", "incomplete", "failed"]);
	});

	it("reads a design-session scope frame, pre-app and materialized alike", () => {
		expect(
			parseDesignSessionScope({
				designSessionId: SESSION,
				materializedAppId: null,
			}),
		).toEqual({ designSessionId: SESSION, materializedAppId: null });
		expect(
			parseDesignSessionScope({
				designSessionId: SESSION,
				materializedAppId: "app-1",
			}),
		).toEqual({ designSessionId: SESSION, materializedAppId: "app-1" });
		expect(parseDesignSessionScope({ materializedAppId: null })).toBeNull();
		expect(parseDesignSessionScope({ designSessionId: SESSION })).toBeNull();
	});

	it("refuses an envelope from another session or another version", () => {
		const outline = {
			objective: "o",
			actors: [],
			tasks: [],
			records: [],
			lists: [],
			assumptions: [],
			blockingQuestions: [],
			outOfScope: [],
			reviewed: false,
		};
		expect(parseDesignOutline(envelope(outline), SESSION)).toEqual(outline);
		expect(parseDesignOutline(envelope(outline, "other"), SESSION)).toBeNull();
		expect(
			parseDesignOutline({ ...envelope(outline), eventVersion: 0 }, SESSION),
		).toBeNull();
		expect(
			parseDesignOutline(
				{ ...envelope(outline), orchestrationRevision: "4" },
				SESSION,
			),
		).toBeNull();
	});

	it("requires the committed slice's sequence and the completion's counts", () => {
		expect(
			parseBuildSliceCommitted(
				envelope({ sliceId: "s1", sliceName: "Register" }),
				SESSION,
			),
		).toBeNull();
		expect(
			parseBuildSliceCommitted(
				envelope({ sliceId: "s1", sliceName: "Register", seq: 2 }),
				SESSION,
			),
		).toEqual({ sliceId: "s1", sliceName: "Register", seq: 2 });
		expect(
			parseBuildCompletion(envelope({ appId: "app-1", appSeq: 3 }), SESSION),
		).toBeNull();
		expect(
			parseBuildPlanSummary(
				envelope({ sliceCount: 2, sliceNames: ["a", "b"] }),
				SESSION,
			),
		).toBeNull();
	});
});
