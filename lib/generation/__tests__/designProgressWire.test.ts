/**
 * The client-safe progress wire is a RESTATEMENT of `lib/agent/build/progress`
 * (that module's type graph reaches the design-artifact schemas and the
 * design-session row, which must not enter the chat client's bundle graph).
 * A restatement can drift, so this suite is the pin: the type-level assertions
 * below fail to COMPILE the moment either side gains, loses, or retypes a
 * field, and `npm run typecheck` runs over test files.
 */

import { describe, expect, it } from "vitest";
import type {
	BuildPlanSummaryProjection as ServerBuildPlanSummary,
	DesignBuildStage as ServerDesignBuildStage,
	DesignOutlineProjection as ServerDesignOutline,
	DesignPulseProjection as ServerDesignPulse,
	DesignProgressEnvelope as ServerEnvelope,
} from "@/lib/agent/build/progress";
import {
	type BuildPlanSummaryProjection,
	DESIGN_BUILD_STAGES,
	DESIGN_PULSE_PHASES,
	type DesignBuildStage,
	type DesignOutlineProjection,
	type DesignProgressEnvelope,
	type DesignPulseProjection,
	designPulseStage,
	designStageIsWorking,
	designStageLabel,
	parseBuildCompletion,
	parseBuildPlanSummary,
	parseBuildSliceCommitted,
	parseDesignOutline,
	parseDesignPulse,
	parseDesignSessionScope,
} from "@/lib/generation/designProgressWire";

/** Mutual assignability — an inexact restatement fails to compile. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const stagesMatch: Exact<DesignBuildStage, ServerDesignBuildStage> = true;
const outlineMatches: Exact<DesignOutlineProjection, ServerDesignOutline> =
	true;
const planMatches: Exact<BuildPlanSummaryProjection, ServerBuildPlanSummary> =
	true;
const envelopeMatches: Exact<
	DesignProgressEnvelope<string>,
	ServerEnvelope<string>
> = true;
const pulseMatches: Exact<DesignPulseProjection, ServerDesignPulse> = true;

const SESSION = "11111111-1111-4111-8111-111111111111";

function envelope(data: unknown, designSessionId = SESSION) {
	return {
		eventVersion: 1,
		designSessionId,
		orchestrationEventId: "event-1",
		orchestrationRevision: 4,
		data,
	};
}

describe("design progress wire", () => {
	it("restates the server's shapes exactly", () => {
		expect([
			stagesMatch,
			outlineMatches,
			planMatches,
			envelopeMatches,
			pulseMatches,
		]).toEqual([true, true, true, true, true]);
	});

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
			parseDesignPulse(envelope({ phase: "author", chars: -1 }), SESSION),
		).toBeNull();
		expect(
			parseDesignPulse(
				envelope({ phase: "author", chars: 5 }, "other"),
				SESSION,
			),
		).toBeNull();
	});

	it("labels every stage in the union", () => {
		for (const stage of DESIGN_BUILD_STAGES) {
			expect(designStageLabel(stage).length).toBeGreaterThan(0);
		}
		expect(new Set(DESIGN_BUILD_STAGES).size).toBe(DESIGN_BUILD_STAGES.length);
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
			readModels: [],
			assumptions: [],
			blockingQuestions: [],
			outOfScope: [],
			reviewed: false,
			findingCounts: { critical: 0, important: 0, advisory: 0 },
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
