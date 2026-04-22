/**
 * derivePhase — pure function unit tests.
 *
 * `BuilderPhase` is computed from session run-lifecycle fields
 * (`loading`, `runCompletedAt`, `events`) + the doc store's
 * `docHasData` predicate. There's no `agentActive` parameter — the
 * events buffer is cleared at both `beginRun` and `endRun`, so
 * "non-empty buffer with build foundation" is itself the "generation
 * in progress" signal. These tests verify the priority chain:
 * Loading > Completed > Generating > Ready > Idle, plus the
 * foundation check that distinguishes initial build from post-build
 * edit (both can emit `form:M-F` tags).
 *
 * No React, no providers — just the pure function.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "@/lib/log/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { derivePhase } from "../hooks";

function mut(stage: string | undefined, seq = 0): Event {
	return {
		kind: "mutation",
		runId: "r",
		ts: 0,
		seq,
		source: "chat",
		actor: "agent",
		...(stage && { stage }),
		mutation: { kind: "setAppName", name: "x" },
	};
}

/** Baseline idle-session fixture — overridable. */
const idle = {
	loading: false,
	runCompletedAt: undefined,
	events: [] as Event[],
};

describe("derivePhase", () => {
	it("returns Loading when loading=true (top priority)", () => {
		expect(derivePhase({ ...idle, loading: true }, true)).toBe(
			BuilderPhase.Loading,
		);
	});

	it("Loading beats everything else", () => {
		expect(
			derivePhase(
				{
					loading: true,
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

	it("Completed beats Generating (celebration window stays sticky)", () => {
		/* `data-done` arrived → runCompletedAt stamped, stream still
		 * streaming (final summary text). Events buffer has generation
		 * mutations, but phase must stay Completed. */
		expect(
			derivePhase(
				{
					loading: false,
					runCompletedAt: Date.now(),
					events: [mut("schema", 0), mut("fix:attempt-1", 1)],
				},
				true,
			),
		).toBe(BuilderPhase.Completed);
	});

	it("returns Generating when buffer has a generation stage + build foundation", () => {
		expect(derivePhase({ ...idle, events: [mut("schema", 0)] }, false)).toBe(
			BuilderPhase.Generating,
		);
	});

	it("stays Generating through later stages (schema is still in buffer)", () => {
		expect(
			derivePhase(
				{
					...idle,
					events: [mut("schema", 0), mut("scaffold", 1), mut("form:0-0", 2)],
				},
				true,
			),
		).toBe(BuilderPhase.Generating);
	});

	it("returns Idle when buffer is empty (no run, no data)", () => {
		/* Fresh mount, or post-endRun with no data. */
		expect(derivePhase(idle, false)).toBe(BuilderPhase.Idle);
	});

	it("returns Idle during askQuestions (no mutations in buffer yet, no data)", () => {
		/* Agent is mid-askQuestions — buffer has conversation events but
		 * no mutations. Stage=null, phase stays Idle. */
		expect(
			derivePhase(
				{
					...idle,
					events: [
						{
							kind: "conversation",
							runId: "r",
							ts: 0,
							seq: 0,
							source: "chat",
							payload: { type: "user-message", text: "hi" },
						},
					],
				},
				false,
			),
		).toBe(BuilderPhase.Idle);
	});

	it("returns Ready when docHasData && buffer is empty (between runs)", () => {
		expect(derivePhase(idle, true)).toBe(BuilderPhase.Ready);
	});

	it("returns Ready during a post-build edit (no schema/scaffold, doc has data)", () => {
		/* Edit in progress: buffer has `form:M-F` or `edit:*` but no
		 * schema/scaffold → no build foundation → falls through to Ready
		 * even though a generation-stage tag is present. */
		expect(derivePhase({ ...idle, events: [mut("form:0-0", 0)] }, true)).toBe(
			BuilderPhase.Ready,
		);
		expect(derivePhase({ ...idle, events: [mut("edit:0-1", 0)] }, true)).toBe(
			BuilderPhase.Ready,
		);
	});

	it("post-completion window: endRun clears buffer → Ready (regression)", () => {
		/* End-to-end: build completed, data-done stamped runCompletedAt,
		 * stream closed (endRun cleared the events buffer), ack cleared
		 * the stamp. Now the derivation runs with buffer=[] and
		 * hasData=true → Ready. If the buffer weren't cleared on
		 * endRun, stage would still be non-null and we'd incorrectly
		 * flip back to Generating after the celebration ended. */
		expect(
			derivePhase(
				{
					loading: false,
					runCompletedAt: undefined,
					events: [],
				},
				true,
			),
		).toBe(BuilderPhase.Ready);
	});

	it("askQuestions-only run: buffer cleared on endRun → Idle (regression)", () => {
		/* End-to-end: user sent a prompt, agent responded with
		 * askQuestions (no mutations), stream closed. endRun cleared
		 * the buffer. hasData=false → Idle, no stray Completed flash. */
		expect(
			derivePhase(
				{
					loading: false,
					runCompletedAt: undefined,
					events: [],
				},
				false,
			),
		).toBe(BuilderPhase.Idle);
	});
});
