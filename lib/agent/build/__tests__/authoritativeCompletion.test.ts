import { describe, expect, it } from "vitest";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import { makeBuildPlan } from "@/lib/agent/design/__tests__/fixtures";
import type { BuildSlice } from "@/lib/agent/design/buildPlan";
import {
	assertExactCommittedSliceReceipts,
	BuildCompletionVerificationError,
} from "../authoritativeCompletion";

const SESSION_ID = "session";
const REVISION_ID = "revision";
const REVISION_DIGEST = "a".repeat(64);
const PLAN_ID = "plan";
const PLAN_DIGEST = "b".repeat(64);
const APP_ID = "app";

function receiptFor(slice: BuildSlice, index: number): CommittedSliceReceipt {
	return {
		id: `receipt-${index}`,
		changeSetId: `change-set-${index}`,
		appId: APP_ID,
		seq: index + 1,
		batchId: `batch-${index}`,
		committedSnapshotDigest: "c".repeat(64),
		mutationCount: 1,
		committedAt: new Date(0),
		designSessionId: SESSION_ID,
		designRevisionId: REVISION_ID,
		designRevisionDigest: REVISION_DIGEST,
		buildPlanId: PLAN_ID,
		buildPlanDigest: PLAN_DIGEST,
		sliceId: slice.id,
		attemptId: `attempt-${index}`,
	};
}

function fixture() {
	const slices = makeBuildPlan().slices;
	return {
		expectedSlices: slices,
		receipts: slices.map(receiptFor),
		lineage: {
			designSessionId: SESSION_ID,
			designRevisionId: REVISION_ID,
			designRevisionDigest: REVISION_DIGEST,
			buildPlanId: PLAN_ID,
			buildPlanDigest: PLAN_DIGEST,
			appId: APP_ID,
		},
	};
}

describe("assertExactCommittedSliceReceipts", () => {
	it("admits the exact ordered receipt set", () => {
		expect(() => assertExactCommittedSliceReceipts(fixture())).not.toThrow();
	});

	it("refuses completion while any planned workflow is uncommitted", () => {
		const value = fixture();
		let error: unknown;
		try {
			assertExactCommittedSliceReceipts({
				...value,
				receipts: value.receipts.slice(0, -1),
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(BuildCompletionVerificationError);
		expect((error as Error).message).toMatch(/1 of 2 planned workflow slices/);
	});

	it("refuses reordered, duplicate, foreign-lineage, or empty receipts", () => {
		const value = fixture();
		const first = value.receipts[0];
		const second = value.receipts[1];
		if (first === undefined || second === undefined) {
			throw new Error("completion fixture must contain two slices");
		}
		const cases: readonly (readonly CommittedSliceReceipt[])[] = [
			[second, first],
			[first, { ...second, sliceId: first.sliceId }],
			[first, { ...second, buildPlanDigest: "d".repeat(64) }],
			[first, { ...second, mutationCount: 0 }],
		];
		for (const receipts of cases) {
			expect(() =>
				assertExactCommittedSliceReceipts({ ...value, receipts }),
			).toThrow(/Build completion refused/);
		}
	});
});
