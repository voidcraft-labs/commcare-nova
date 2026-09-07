/** Operational classification is independent of the persisted resume policy.
 * Native orchestrator/runner suites cover emitted chunks and durable outcomes;
 * prompt prose and source-code searches cannot prove those behaviors. */
import { describe, expect, it } from "vitest";
import { designBuildFailureLogLevel } from "../failureReporting";

describe("build failure operational classification", () => {
	it("keeps an external prerequisite distinct from an unexpected build defect", () => {
		expect(designBuildFailureLogLevel("expected-prerequisite")).toBe("warn");
		expect(designBuildFailureLogLevel("unexpected-failure")).toBe("error");
	});
});
