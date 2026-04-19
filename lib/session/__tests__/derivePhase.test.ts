/**
 * derivePhase — pure function unit tests.
 *
 * BuilderPhase is no longer stored explicitly; it's computed from session
 * store fields + whether the doc has data. These tests verify the priority
 * chain: Loading > Completed > Generating > Ready > Idle, and the
 * requirement that Generating needs an explicit agentStage.
 *
 * No React, no providers — just the pure function.
 */

import { describe, expect, it } from "vitest";
import { BuilderPhase } from "@/lib/services/builder";
import { GenerationStage } from "@/lib/session/types";
import { derivePhase } from "../hooks";

describe("derivePhase", () => {
	it("returns Loading when loading=true", () => {
		expect(derivePhase({ loading: true }, true)).toBe(BuilderPhase.Loading);
	});

	it("returns Completed when justCompleted=true", () => {
		expect(derivePhase({ justCompleted: true }, true)).toBe(
			BuilderPhase.Completed,
		);
	});

	it("returns Generating when agentActive && !postBuildEdit && agentStage is set", () => {
		expect(
			derivePhase(
				{
					agentActive: true,
					postBuildEdit: false,
					agentStage: GenerationStage.DataModel,
				},
				false,
			),
		).toBe(BuilderPhase.Generating);
	});

	it("returns Idle (not Generating) when agentActive but agentStage is null", () => {
		/* This is the window between the chat status effect setting agentActive
		 * and the first data-start-build event. The SA may be doing askQuestions
		 * or thinking — the builder should stay in the centered-chat Idle view,
		 * not flash the generation progress UI. */
		expect(
			derivePhase(
				{ agentActive: true, postBuildEdit: false, agentStage: null },
				false,
			),
		).toBe(BuilderPhase.Idle);
	});

	it("returns Idle when agentActive but agentStage is undefined", () => {
		expect(
			derivePhase(
				{ agentActive: true, postBuildEdit: false, agentStage: undefined },
				false,
			),
		).toBe(BuilderPhase.Idle);
	});

	it("returns Ready when agentActive && postBuildEdit (post-build edit)", () => {
		expect(
			derivePhase(
				{
					agentActive: true,
					postBuildEdit: true,
					agentStage: GenerationStage.Forms,
				},
				true,
			),
		).toBe(BuilderPhase.Ready);
	});

	it("returns Ready when docHasData && no agent", () => {
		expect(derivePhase({}, true)).toBe(BuilderPhase.Ready);
	});

	it("returns Idle when no data && no agent", () => {
		expect(derivePhase({}, false)).toBe(BuilderPhase.Idle);
	});

	it("Loading takes priority over everything", () => {
		expect(
			derivePhase(
				{
					loading: true,
					agentActive: true,
					justCompleted: true,
					agentStage: GenerationStage.Modules,
				},
				true,
			),
		).toBe(BuilderPhase.Loading);
	});

	it("Completed takes priority over Generating", () => {
		/* After endAgentWrite: justCompleted=true, agentActive still true
		 * (cleared later by the chat status effect). Phase should be
		 * Completed, not Generating. */
		expect(
			derivePhase(
				{
					justCompleted: true,
					agentActive: true,
					agentStage: GenerationStage.Fix,
				},
				true,
			),
		).toBe(BuilderPhase.Completed);
	});
});
