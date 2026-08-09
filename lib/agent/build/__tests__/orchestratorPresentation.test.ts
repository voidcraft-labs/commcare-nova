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
		expect(EXECUTOR_SYSTEM).toContain("Prefer one `createModule` call");
		expect(EXECUTOR_SYSTEM).toContain(
			"Use `stageModule` / `stageForm` when a real dependency or call-size boundary requires",
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
});
