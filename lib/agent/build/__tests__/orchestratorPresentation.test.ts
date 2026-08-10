/** Presentation boundaries for the reviewed-build orchestrator. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXECUTOR_PROMPT_VERSION,
	EXECUTOR_SYSTEM,
} from "@/lib/agent/build/executorPrompt";
import { designIssueUserMessage } from "@/lib/agent/build/issueEscalation";
import type { OrchestrationHead } from "@/lib/agent/build/orchestratorState";
import { orchestrationFailureCanRetryAcceptedPlan } from "@/lib/agent/build/progress";

function failedHead(errorType: string): OrchestrationHead {
	return {
		revision: 3,
		eventId: "event-3",
		digest: "a".repeat(64),
		state: {
			kind: "failed",
			failureId: "00000000-0000-4000-8000-000000000001",
			recoverable: true,
			errorType,
		},
	};
}

describe("reviewed-build presentation", () => {
	it("keeps the first shipped executor dialect at v1 and requests complete creation calls", () => {
		expect(EXECUTOR_PROMPT_VERSION).toBe("build-executor-v1");
		expect(EXECUTOR_SYSTEM).toContain("Prefer one `createModule` call");
		expect(EXECUTOR_SYSTEM).toContain(
			"Use `stageModule` / `stageForm` when a real dependency or call-size boundary requires",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"an empty property catalog is not by itself a stale external dependency",
		);
	});

	it("does not synthesize canned assistant prose between model work", () => {
		const source = readFileSync(
			join(__dirname, "..", "orchestrator.ts"),
			"utf8",
		);
		for (const chunkType of [
			'type: "text-start"',
			'type: "text-delta"',
			'type: "text-end"',
		]) {
			expect(source).not.toContain(chunkType);
		}
	});

	it("keeps executor diagnostics out of recoverable user messages", () => {
		const message = designIssueUserMessage("stale-external-dependency");
		expect(message).toBe(
			"Something this workflow relies on is missing or has changed. Nothing invalid was saved. Fix that setup, then try again.",
		);
		expect(message).not.toContain("stale-external-dependency");
		expect(message).not.toContain("UUID");
		expect(EXECUTOR_SYSTEM).toContain(
			"the explanation and options become the person's question",
		);
	});

	it("reconstructs exact-plan replay only from eligible durable failures", () => {
		expect(
			orchestrationFailureCanRetryAcceptedPlan(
				failedHead("execution-budget-exhausted"),
			),
		).toBe(true);
		expect(
			orchestrationFailureCanRetryAcceptedPlan(
				failedHead("rebase-budget-exhausted"),
			),
		).toBe(true);
		expect(
			orchestrationFailureCanRetryAcceptedPlan(
				failedHead("design-issue-stale-external-dependency"),
			),
		).toBe(false);
		expect(orchestrationFailureCanRetryAcceptedPlan(null)).toBe(false);
	});
});
