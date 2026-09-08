/**
 * The prompt segments the anatomy renders are the prompts production sends.
 *
 * Two proofs per prompt: the joined segments equal the builder the call
 * site uses, and both equal the sha256 captured on `main` before the
 * segment split (`fixtures/promptDigests.json`). The first catches a
 * segment list that drifts from its builder; the second catches a silent
 * byte change in either. A deliberate prompt change updates the fixture
 * hash and bumps the role's prompt version where one exists
 * (`DESIGN_PROMPT_VERSIONS`, `EXECUTOR_PROMPT_VERSION`,
 * `TRANSLATION_PROMPT_VERSION`, `EXTRACTOR_VERSION`).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	EXECUTOR_SEGMENTS,
	EXECUTOR_SYSTEM,
} from "@/lib/agent/build/executorPrompt";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "@/lib/agent/design/capabilityCatalog";
import { composeDesignInstructions } from "@/lib/agent/design/loop/designAgent";
import {
	DESIGN_AGENT_SYSTEM,
	DESIGN_REVIEWER_SYSTEM,
	renderPlatformConstraintsSection,
} from "@/lib/agent/design/prompts";
import { EXTRACT_SYSTEM } from "@/lib/agent/documentExtraction";
import { joinPromptSegments } from "@/lib/agent/promptSegments";
import {
	buildMcpAgentBuildPrompt,
	buildSolutionsArchitectPrompt,
	MCP_BUILD_SEGMENTS,
	SOLUTIONS_ARCHITECT_SEGMENTS,
} from "@/lib/agent/prompts";
import fixture from "./fixtures/promptDigests.json";

const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

describe("prompt segments", () => {
	it("joins the Solutions Architect segments into the edit prompt", () => {
		const joined = joinPromptSegments(SOLUTIONS_ARCHITECT_SEGMENTS);
		expect(joined).toBe(buildSolutionsArchitectPrompt());
		expect(sha256(joined)).toBe(fixture.solutionsArchitectPrompt);
	});

	it("joins the MCP build segments into the build prompt", () => {
		const joined = joinPromptSegments(MCP_BUILD_SEGMENTS);
		expect(joined).toBe(buildMcpAgentBuildPrompt());
		expect(sha256(joined)).toBe(fixture.mcpBuildPrompt);
	});

	it("joins the executor segments into the executor system prompt", () => {
		const joined = joinPromptSegments(EXECUTOR_SEGMENTS);
		expect(joined).toBe(EXECUTOR_SYSTEM);
		expect(sha256(joined)).toBe(fixture.executorSystem);
	});

	it("composes the design author instructions the runner sends", () => {
		const composed = composeDesignInstructions(
			DESIGN_AGENT_SYSTEM,
			renderCapabilityCatalog(buildCapabilityCatalog()),
			renderPlatformConstraintsSection(),
		);
		expect(sha256(composed)).toBe(fixture.designInstructions);
	});

	it("keeps the one-shot system prompts byte-identical", () => {
		expect(sha256(DESIGN_REVIEWER_SYSTEM)).toBe(fixture.designReviewerSystem);
		expect(sha256(EXTRACT_SYSTEM)).toBe(fixture.extractSystem);
	});

	it("gives every segment a distinct id within its prompt", () => {
		for (const segments of [
			SOLUTIONS_ARCHITECT_SEGMENTS,
			MCP_BUILD_SEGMENTS,
			EXECUTOR_SEGMENTS,
		]) {
			const ids = segments.map((segment) => segment.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});
});
