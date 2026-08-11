/** Presentation boundaries for the reviewed-build orchestrator. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXECUTOR_PROMPT_VERSION,
	EXECUTOR_SYSTEM,
} from "@/lib/agent/build/executorPrompt";

describe("reviewed-build presentation", () => {
	it("keeps the first shipped executor dialect at v1 and requests complete creation calls", () => {
		expect(EXECUTOR_PROMPT_VERSION).toBe("build-executor-v1");
		expect(EXECUTOR_SYSTEM).toContain("Prefer one `createModule` operation");
		expect(EXECUTOR_SYSTEM).toContain(
			"Use `stageModule` / `stageForm` when a real dependency or call-size boundary requires",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"an empty property catalog is not by itself a stale external dependency",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"When the accepted workflow creates the module's primary record",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"needs at least two distinct real inline choices or the specific existing Project lookup source",
		);
		expect(EXECUTOR_SYSTEM).toContain("make a form always hidden/disabled");
		expect(EXECUTOR_SYSTEM).toContain(
			"optional media slot that is already absent",
		);
	});

	it("wires Project lookup reads into pre-app change sets", () => {
		const source = readFileSync(
			join(__dirname, "..", "orchestrator.ts"),
			"utf8",
		);
		expect(source).toContain(
			"readToolLookupDefinitions(lookupScope, tableIds)",
		);
		expect(source).toContain("readToolLookupCatalog(lookupScope)");
		expect(source).toContain("role: args.projectRole");
		expect(source).toContain('outcome.kind === "read-set-stale"');
		expect(source).toContain("failureCode: outcome.kind");
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

	it("keeps compiler blockers internal and non-authoritative", () => {
		expect(EXECUTOR_SYSTEM).toContain(
			"This is evidence for the architect, not a design verdict and not a user message",
		);
		expect(EXECUTOR_SYSTEM).toContain("reportExecutionBlocker");
		expect(EXECUTOR_SYSTEM).not.toContain("raiseDesignExecutionIssue");
	});
});
