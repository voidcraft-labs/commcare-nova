/**
 * derivePhase — pure function unit tests.
 *
 * `BuilderPhase` is computed from session run-lifecycle fields
 * (`loading`, `agentActive`, `runCompletedAt`, `events`) + the doc
 * store's `docHasData` predicate. These tests verify the priority
 * chain: Loading > Completed > Generating > Ready > Idle, and the
 * requirement that Generating needs a generation-stage mutation in the
 * events buffer.
 *
 * No React, no providers — just the pure function.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "@/lib/log/types";
import { BuilderPhase } from "@/lib/services/builder";
import { derivePhase } from "../hooks";

function mut(stage: string | undefined, seq = 0): Event {
	return {
		kind: "mutation",
		runId: "r",
		ts: 0,
		seq,
		actor: "agent",
		...(stage && { stage }),
		mutation: { kind: "setAppName", name: "x" },
	};
}

/** Baseline idle-session fixture — overridable. */
const idle = {
	loading: false,
	agentActive: false,
	runCompletedAt: undefined,
	events: [] as Event[],
};

describe("derivePhase", () => {
	it("returns Loading when loading=true (top priority)", () => {
		expect(derivePhase({ ...idle, loading: true }, true)).toBe(
			BuilderPhase.Loading,
		);
	});

	it("Loading beats Completed, Generating, Ready", () => {
		expect(
			derivePhase(
				{
					loading: true,
					agentActive: true,
					runCompletedAt: Date.now(),
					events: [mut("schema", 0)],
				},
				true,
			),
		).toBe(BuilderPhase.Loading);
	});

	it("returns Completed when runCompletedAt is stamped", () => {
		expect(derivePhase({ ...idle, runCompletedAt: Date.now() }, true)).toBe(
			BuilderPhase.Completed,
		);
	});

	it("Completed beats Generating", () => {
		/* After endRun(true): runCompletedAt is set, agentActive may still
		 * be true (chat status effect hasn't fired ready yet). Phase must
		 * be Completed, not Generating. */
		expect(
			derivePhase(
				{
					loading: false,
					agentActive: true,
					runCompletedAt: Date.now(),
					events: [mut("fix:attempt-1", 0)],
				},
				true,
			),
		).toBe(BuilderPhase.Completed);
	});

	it("returns Generating when agentActive && generation-stage mutation in buffer", () => {
		expect(
			derivePhase(
				{ ...idle, agentActive: true, events: [mut("schema", 0)] },
				false,
			),
		).toBe(BuilderPhase.Generating);
	});

	it("returns Idle (not Generating) when agentActive but no generation-stage mutations yet", () => {
		/* The window between `beginRun` (SSE stream opens) and the first
		 * stage-tagged mutation — SA may be doing askQuestions. Builder
		 * stays in centered-chat Idle, not flash the generation UI. */
		expect(derivePhase({ ...idle, agentActive: true, events: [] }, false)).toBe(
			BuilderPhase.Idle,
		);
	});

	it("returns Idle (not Generating) when only edit-family mutations have landed", () => {
		expect(
			derivePhase(
				{ ...idle, agentActive: true, events: [mut("edit:0-1", 0)] },
				false,
			),
		).toBe(BuilderPhase.Idle);
	});

	it("returns Ready when agentActive && postBuildEdit (no schema/scaffold, doc has data)", () => {
		/* Post-build edit: active run, doc has data, no schema/scaffold
		 * stage tags in the buffer. Phase stays Ready. */
		expect(
			derivePhase(
				{ ...idle, agentActive: true, events: [mut("edit:0-1", 0)] },
				true,
			),
		).toBe(BuilderPhase.Ready);
	});

	it("returns Ready when docHasData && no agent", () => {
		expect(derivePhase(idle, true)).toBe(BuilderPhase.Ready);
	});

	it("returns Idle when no data && no agent", () => {
		expect(derivePhase(idle, false)).toBe(BuilderPhase.Idle);
	});
});
