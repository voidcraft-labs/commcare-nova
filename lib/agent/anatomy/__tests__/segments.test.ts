/**
 * The prompt segments the anatomy renders are the prompts production sends.
 *
 * Every segmented prompt: the joined segments equal the builder the call
 * site uses, so a segment list cannot drift from its builder.
 *
 * Every VERSIONED prompt: its sha256 is recorded beside the version it
 * shipped under (`fixtures/promptDigests.json`). A persisted design or
 * executor context rolls over on a version change, never on a byte change,
 * so a prompt edit that leaves the version alone keeps live sessions on
 * text their recorded version no longer names. The failure message names
 * the version to bump; updating the fixture then records the new pair.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	EXECUTOR_PROMPT_VERSION,
	EXECUTOR_SEGMENTS,
	EXECUTOR_SYSTEM,
} from "@/lib/agent/build/executorPrompt";
import {
	composeDesignInstructions,
	designAuthorInstructionParts,
} from "@/lib/agent/design/loop/designAgent";
import {
	DESIGN_AGENT_SYSTEM,
	DESIGN_PROMPT_VERSIONS,
	DESIGN_REVIEWER_SYSTEM,
} from "@/lib/agent/design/prompts";
import { EXTRACT_SYSTEM } from "@/lib/agent/documentExtraction";
import { joinPromptSegments } from "@/lib/agent/promptSegments";
import {
	buildMcpAgentBuildPrompt,
	buildSolutionsArchitectPrompt,
	MCP_BUILD_SEGMENTS,
	SOLUTIONS_ARCHITECT_SEGMENTS,
} from "@/lib/agent/prompts";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import fixture from "./fixtures/promptDigests.json";

const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

/** The prompt's bytes and version must move together. */
function expectVersionedPrompt(
	name: string,
	text: string,
	version: string | number,
	recorded: { digest: string; version: string | number },
	bump: string,
) {
	const digest = sha256(text);
	expect(
		{ digest, version },
		`${name} changed (${recorded.digest.slice(0, 8)} → ${digest.slice(0, 8)}). Bump ${bump} so recorded contexts roll over, then record the new digest and version in fixtures/promptDigests.json.`,
	).toEqual(recorded);
}

describe("prompt segments", () => {
	it("joins the Solutions Architect segments into the edit prompt", () => {
		expect(joinPromptSegments(SOLUTIONS_ARCHITECT_SEGMENTS)).toBe(
			buildSolutionsArchitectPrompt(),
		);
	});

	it("joins the MCP build segments into the build prompt", () => {
		expect(joinPromptSegments(MCP_BUILD_SEGMENTS)).toBe(
			buildMcpAgentBuildPrompt(),
		);
	});

	it("joins the executor segments into the executor system prompt, versioned", () => {
		const joined = joinPromptSegments(EXECUTOR_SEGMENTS);
		expect(joined).toBe(EXECUTOR_SYSTEM);
		expectVersionedPrompt(
			"The executor system prompt",
			joined,
			EXECUTOR_PROMPT_VERSION,
			fixture.executorSystem,
			"EXECUTOR_PROMPT_VERSION",
		);
	});

	it("composes the design author instructions the runner sends, versioned", () => {
		const { instructions, catalogText, constraintsText } =
			designAuthorInstructionParts();
		expect(instructions).toBe(DESIGN_AGENT_SYSTEM);
		expectVersionedPrompt(
			"The design author instructions",
			composeDesignInstructions(instructions, catalogText, constraintsText),
			DESIGN_PROMPT_VERSIONS.agent,
			fixture.designInstructions,
			"DESIGN_PROMPT_VERSIONS.agent",
		);
	});

	it("keeps the versioned one-shot system prompts beside their versions", () => {
		expectVersionedPrompt(
			"The design reviewer system prompt",
			DESIGN_REVIEWER_SYSTEM,
			DESIGN_PROMPT_VERSIONS.reviewer,
			fixture.designReviewerSystem,
			"DESIGN_PROMPT_VERSIONS.reviewer",
		);
		expectVersionedPrompt(
			"The document extractor system prompt",
			EXTRACT_SYSTEM,
			EXTRACTOR_VERSION,
			fixture.extractSystem,
			"EXTRACTOR_VERSION",
		);
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
