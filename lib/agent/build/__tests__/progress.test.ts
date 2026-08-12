import { describe, expect, it } from "vitest";
import type { OrchestrationHead } from "@/lib/agent/build/orchestratorState";
import { deriveInterruptedMaterializedBuildStage } from "@/lib/agent/build/progress";

const SESSION = {
	state: "materialized" as const,
	awaiting_input: false,
	last_error_type: null,
	app_id: "app-id",
};

function head(state: OrchestrationHead["state"]): OrchestrationHead {
	return {
		revision: 1,
		eventId: crypto.randomUUID(),
		digest: "a".repeat(64),
		state,
	};
}

describe("interrupted materialized build progress", () => {
	it("offers exact recovery when infrastructure failed before a terminal event", () => {
		expect(
			deriveInterruptedMaterializedBuildStage(
				SESSION,
				head({
					kind: "planning",
					designRevisionId: crypto.randomUUID(),
					designRevisionDigest: "b".repeat(64),
				}),
			),
		).toBe("incomplete");
		expect(deriveInterruptedMaterializedBuildStage(SESSION, null)).toBe(
			"incomplete",
		);
	});

	it("does not turn a deterministic build defect into a retry strategy", () => {
		expect(
			deriveInterruptedMaterializedBuildStage(
				SESSION,
				head({
					kind: "failed",
					failureId: crypto.randomUUID(),
					recoverable: false,
					errorType: "final-verification-failed",
				}),
			),
		).toBe("failed");
	});
});
