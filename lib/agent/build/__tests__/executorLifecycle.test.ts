/** Executor-owned deadline cleanup at synchronous and persistence failure seams. */
import { describe, expect, it, vi } from "vitest";
import {
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { budgetForSlice } from "../budgets";
import { deriveSliceExecutionBrief } from "../executionBrief";
import { type ExecutorWorkspace, runSliceExecutor } from "../executorLoop";

function setup() {
	const plan = makeBuildPlan();
	const brief = deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: fixtureValue(plan.slices[0], "first slice").id,
	});
	const workspace: ExecutorWorkspace = {
		currentSnapshot: () => ({
			doc: emptyBlueprintDoc("executor-lifecycle"),
			revision: 0,
			canonicalSeq: null,
			projectId: "lifecycle-project",
		}),
		currentExecutionCheckpoint: () => ({ handles: [] }),
		projectDesignLookupReferences: (value) => value,
		async stageDispatch() {
			throw new Error("No tool may run after initialization fails");
		},
		async inspect() {
			throw new Error("No finalizer may run after initialization fails");
		},
	};
	return { brief, workspace };
}

describe("executor deadline ownership", () => {
	it.each(["snapshot", "progress", "persistence"] as const)(
		"cancels its deadline when %s fails before a model request",
		async (failure) => {
			vi.useFakeTimers();
			const reason = new Error(`Unavailable ${failure}`);
			const { brief, workspace } = setup();
			if (failure === "snapshot")
				workspace.currentSnapshot = () => {
					throw reason;
				};
			try {
				await expect(
					runSliceExecutor({
						brief,
						workspace,
						budget: budgetForSlice(brief.slice),
						signal: new AbortController().signal,
						async step() {
							throw new Error("Unexpected provider request");
						},
						async commit() {
							throw new Error("Unexpected canonical commit");
						},
						onProgress() {
							if (failure === "progress") throw reason;
						},
						context: {
							messages: [],
							async append() {
								if (failure === "persistence") throw reason;
							},
						},
					}),
				).rejects.toBe(reason);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);
});
