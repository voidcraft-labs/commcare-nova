/**
 * derivePhase — pure function unit tests.
 *
 * BuilderPhase is no longer stored explicitly; it's computed from session
 * store fields + whether the doc has data. These tests verify the priority
 * chain: Loading > Completed > Generating > Ready > Idle.
 *
 * No React, no providers — just the pure function.
 */

import { describe, expect, it } from "vitest";
import { BuilderPhase } from "@/lib/services/builder";
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

	it("returns Generating when agentActive && !postBuildEdit", () => {
		expect(
			derivePhase({ agentActive: true, postBuildEdit: false }, false),
		).toBe(BuilderPhase.Generating);
	});

	it("returns Ready when agentActive && postBuildEdit (post-build edit)", () => {
		expect(derivePhase({ agentActive: true, postBuildEdit: true }, true)).toBe(
			BuilderPhase.Ready,
		);
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
				{ loading: true, agentActive: true, justCompleted: true },
				true,
			),
		).toBe(BuilderPhase.Loading);
	});

	it("Completed takes priority over Generating", () => {
		expect(derivePhase({ justCompleted: true, agentActive: true }, true)).toBe(
			BuilderPhase.Completed,
		);
	});
});
