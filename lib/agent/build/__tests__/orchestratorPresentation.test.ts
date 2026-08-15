/** Presentation boundaries for the reviewed-build orchestrator. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXECUTOR_PROMPT_VERSION,
	EXECUTOR_SYSTEM,
} from "@/lib/agent/build/executorPrompt";

describe("reviewed-build presentation", () => {
	it("versions the native-call executor dialect and requests coherent creation calls", () => {
		expect(EXECUTOR_PROMPT_VERSION).toBe("build-executor-v9");
		expect(EXECUTOR_SYSTEM).toContain("Prefer one `createModule` call");
		expect(EXECUTOR_SYSTEM).toContain(
			"Use several native calls in one response when their inputs are already known",
		);
		expect(EXECUTOR_SYSTEM).toContain("finishWorkflow");
		expect(EXECUTOR_SYSTEM).not.toContain("stageModule");
		expect(EXECUTOR_SYSTEM).toContain(
			"an empty property catalog is not by itself a stale external dependency",
		);
		expect(EXECUTOR_SYSTEM).toContain("Batch the longest safe known prefix");
		expect(EXECUTOR_SYSTEM).toContain(
			"A registration form's direct `caseWrite` fields create its hosted record on every successful submission",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"When a workflow input carries optional `validation` intent",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"An optional input's predicate must accept an unanswered value",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"needs at least two distinct real inline choices or the specific existing Project lookup source",
		);
		expect(EXECUTOR_SYSTEM).toContain("make a form always hidden/disabled");
		expect(EXECUTOR_SYSTEM).toContain(
			"optional media slot that is already absent",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"every accepted semantic record has one exact `blueprintCaseType`",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"The record's display name is never a second case-type key",
		);
		expect(EXECUTOR_SYSTEM).toContain("Use `configureCaseList`");
		expect(EXECUTOR_SYSTEM).toContain(
			"it is not a request to create a Blueprint user type",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			"The built-in `status` is only `open` or `closed`",
		);
		expect(EXECUTOR_SYSTEM).toContain(
			'a direct Term such as `{ kind: "literal", value: "open" }`',
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
