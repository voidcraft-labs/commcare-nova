import { describe, expect, it } from "vitest";
import {
	contractSubmissionPulsePhase,
	DESIGN_LOOP_STOP_MESSAGE,
	designToolPulsePhase,
} from "@/lib/agent/build/designLoopRunner";

describe("contractSubmissionPulsePhase", () => {
	it("distinguishes a first design from an immutable replacement revision", () => {
		expect(contractSubmissionPulsePhase(false)).toBe("design");
		expect(contractSubmissionPulsePhase(true)).toBe("revise");
	});

	it("keeps schema-repair internals out of the user-facing stop message", () => {
		expect(DESIGN_LOOP_STOP_MESSAGE).toContain("reviewed design is saved");
		expect(DESIGN_LOOP_STOP_MESSAGE).not.toMatch(
			/schema|submission|diagnostic|tool/i,
		);
	});
});

describe("designToolPulsePhase", () => {
	it("switches to review as soon as requestReview starts", () => {
		expect(designToolPulsePhase("requestReview", "revise", "design")).toBe(
			"review",
		);
	});

	it("returns to revision and plan phases for their bounded stages", () => {
		expect(designToolPulsePhase("stageRevision", "review", "design")).toBe(
			"revise",
		);
		expect(designToolPulsePhase("stagePlan", "review", "design")).toBe("plan");
	});
});
