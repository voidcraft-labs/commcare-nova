import { describe, expect, it } from "vitest";
import { contractSubmissionPulsePhase } from "@/lib/agent/build/designLoopRunner";

describe("contractSubmissionPulsePhase", () => {
	it("distinguishes a first design from an immutable replacement revision", () => {
		expect(contractSubmissionPulsePhase(false)).toBe("design");
		expect(contractSubmissionPulsePhase(true)).toBe("revise");
	});
});
