/** Presentation and vocabulary boundaries for the reviewed Blueprint build. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANDIDATE_AUTHOR_SYSTEM } from "@/lib/agent/design/candidatePrompt";

function source(relative: string): string {
	return readFileSync(join(__dirname, relative), "utf8");
}

describe("reviewed-build presentation", () => {
	it("authors the executable Blueprint instead of a parallel planning artifact", () => {
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"Build the user's complete app directly in the private app candidate",
		);
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"do not write a separate specification, implementation plan, traceability matrix, construction group, slice, patch, mutation list, or model-authored identifier",
		);
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"Prefer complete createModule and createForm calls",
		);
	});

	it("wires current-Project lookup reads into the pre-app candidate", () => {
		const runner = source("../candidateLoopRunner.ts");
		expect(runner).toContain(
			"readToolLookupDefinitions(lookupScope, tableIds)",
		);
		expect(runner).toContain("readToolLookupCatalog(lookupScope)");
		expect(runner).toContain("role: args.projectRole");
	});

	it("contains no production slice executor or model-authored commit protocol", () => {
		const orchestrator = source("../orchestrator.ts");
		for (const forbidden of [
			"runSliceExecutor",
			"productionExecutorStep",
			"BuildPlan",
			"constructionGroup",
			"commitChangeSet",
		]) {
			expect(orchestrator).not.toContain(forbidden);
		}
		expect(orchestrator).toContain("runCandidateLoop");
		expect(orchestrator).toContain("materializeAppFromGenesis");
	});

	it("does not synthesize canned assistant prose between model work", () => {
		const orchestrator = source("../orchestrator.ts");
		for (const chunkType of [
			'type: "text-start"',
			'type: "text-delta"',
			'type: "text-end"',
		]) {
			expect(orchestrator).not.toContain(chunkType);
		}
	});

	it("keeps the model-facing capability boundary plain and user-safe", () => {
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"One build creates exactly one app in the current Project",
		);
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"You cannot create image, audio, video, document, or other media bytes",
		);
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"never expose tool names, schemas, validation internals, identifiers, review machinery, or technical implementation details",
		);
	});
});
