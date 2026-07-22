import { describe, expect, it } from "vitest";
import { MAX_GENERATION_MINUTES } from "../constants";
import { runLeaseState } from "../runLiveness";
import {
	runtimeHolderBlocksTarget,
	runtimeHolderState,
	sameRunHolderIdentity,
} from "../runtimeReaderHolders";
import type { AppDoc } from "../types";

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);
const RUN = "run-current";

const updatedAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000) as AppDoc["updated_at"];

const reservation = (
	runId: string | null = RUN,
): NonNullable<AppDoc["reservation"]> => ({
	period: "2026-07",
	reserved: 5,
	settled: false,
	userId: "actor",
	...(runId !== null && { runId }),
});

const editLock = (minutes: number, runId = RUN) => ({
	runId,
	actorUserId: "actor",
	expireAt: new Date(NOW + minutes * 60_000),
});

describe("runtime holder identity", () => {
	it("is absent when neither build status nor an edit lock is present", () => {
		expect(
			runLeaseState({ status: "complete", run_id: RUN }, NOW).holderIdentity,
		).toBeNull();
	});

	it("uses root run_id only for a pre-reservation generating build", () => {
		expect(
			runLeaseState(
				{ status: "generating", run_id: RUN, updated_at: updatedAgo(1) },
				NOW,
			).holderIdentity,
		).toEqual({ mode: "build", runId: RUN });
	});

	it("uses the reservation identity without falling back once reserved", () => {
		expect(
			runLeaseState(
				{
					status: "generating",
					run_id: "must-not-fallback",
					reservation: reservation(null),
					updated_at: updatedAgo(MAX_GENERATION_MINUTES + 1),
				},
				NOW,
			).holderIdentity,
		).toEqual({ mode: "build", runId: null });
	});

	it("uses edit lock identity and lets build mode win over a leftover lock", () => {
		expect(
			runLeaseState(
				{ status: "complete", run_lock: editLock(5, "edit-run") },
				NOW,
			).holderIdentity,
		).toEqual({ mode: "edit", runId: "edit-run" });
		expect(
			runLeaseState(
				{
					status: "generating",
					reservation: reservation("build-run"),
					run_lock: editLock(5, "old-edit"),
					updated_at: updatedAgo(1),
				},
				NOW,
			).holderIdentity,
		).toEqual({ mode: "build", runId: "build-run" });
	});

	it("compares both mode and run id exactly", () => {
		expect(sameRunHolderIdentity(null, null)).toBe(true);
		expect(
			sameRunHolderIdentity(
				{ mode: "build", runId: RUN },
				{ mode: "build", runId: RUN },
			),
		).toBe(true);
		expect(
			sameRunHolderIdentity(
				{ mode: "build", runId: RUN },
				{ mode: "edit", runId: RUN },
			),
		).toBe(false);
		expect(
			sameRunHolderIdentity(
				{ mode: "edit", runId: RUN },
				{ mode: "edit", runId: "replacement" },
			),
		).toBe(false);
	});
});

describe("runtime holder census state", () => {
	it("treats a present valid stamped build as its stored version", () => {
		const state = runtimeHolderState(
			runLeaseState(
				{
					status: "generating",
					reservation: reservation(),
					updated_at: updatedAgo(1),
				},
				NOW,
			),
			2,
		);
		expect(state).toEqual({
			kind: "present",
			identity: { mode: "build", runId: RUN },
			storedVersion: 2,
			effectiveVersion: 2,
			lifecycle: "live",
		});
		expect(runtimeHolderBlocksTarget(state, 2)).toBe(false);
		expect(runtimeHolderBlocksTarget(state, 3)).toBe(true);
	});

	it("classifies reapable before paused", () => {
		const state = runtimeHolderState(
			runLeaseState(
				{
					status: "generating",
					awaiting_input: true,
					reservation: reservation(),
					updated_at: updatedAgo(MAX_GENERATION_MINUTES + 1),
				},
				NOW,
			),
			1,
		);
		expect(state).toMatchObject({
			kind: "present",
			lifecycle: "reapable-stale-build",
		});
	});

	it("classifies a lapsed edit with an unsettled marker as reapable", () => {
		const state = runtimeHolderState(
			runLeaseState(
				{
					status: "complete",
					reservation: reservation("charged-run"),
					run_lock: editLock(-1, "edit-run"),
				},
				NOW,
			),
			1,
		);
		expect(state).toMatchObject({
			kind: "present",
			identity: { mode: "edit", runId: "edit-run" },
			lifecycle: "reapable-stranded-edit",
		});
	});

	it("fails closed for corrupt identity and malformed or missing stamps", () => {
		const corruptIdentity = runtimeHolderState(
			runLeaseState(
				{
					status: "generating",
					run_id: "must-not-fallback",
					reservation: reservation(null),
					updated_at: updatedAgo(1),
				},
				NOW,
			),
			7,
		);
		expect(corruptIdentity).toMatchObject({
			kind: "present",
			storedVersion: 7,
			effectiveVersion: 0,
			lifecycle: "corrupt-present",
		});
		expect(runtimeHolderBlocksTarget(corruptIdentity, 1)).toBe(true);

		for (const malformed of [null, undefined, -1, 1.5, "2"]) {
			const state = runtimeHolderState(
				runLeaseState(
					{
						status: "complete",
						run_lock: editLock(5),
					},
					NOW,
				),
				malformed,
			);
			expect(state).toMatchObject({
				kind: "present",
				storedVersion: null,
				effectiveVersion: 0,
			});
		}
	});

	it("ignores stale stamps when no holder is present", () => {
		const state = runtimeHolderState(
			runLeaseState({ status: "error", run_id: RUN }, NOW),
			99,
		);
		expect(state).toEqual({ kind: "absent" });
		expect(runtimeHolderBlocksTarget(state, 1)).toBe(false);
	});
});
