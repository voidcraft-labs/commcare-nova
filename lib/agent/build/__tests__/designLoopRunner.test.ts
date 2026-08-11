import { describe, expect, it } from "vitest";
import {
	contractSubmissionPulsePhase,
	DESIGN_LOOP_STOP_MESSAGE,
	designToolPulsePhase,
} from "@/lib/agent/build/designLoopRunner";
import { designStepBudgetReached } from "@/lib/agent/design/loop/designAgent";

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

	it("returns to revision for its bounded stages", () => {
		expect(designToolPulsePhase("stageRevision", "review", "design")).toBe(
			"revise",
		);
	});
});

describe("design POST step budget", () => {
	it("counts completed steps from prior transient stream attempts", () => {
		expect(designStepBudgetReached(62, 1)).toBe(false);
		expect(designStepBudgetReached(63, 1)).toBe(true);
		expect(designStepBudgetReached(64, 1)).toBe(true);
	});
});
