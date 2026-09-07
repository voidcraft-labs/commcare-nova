import { describe, expect, it } from "vitest";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import { asDesignId } from "@/lib/agent/design/ids";
import {
	assertExactCommittedSliceReceipts,
	BuildCompletionVerificationError,
	type FrozenBuildLineage,
} from "../authoritativeCompletion";

// This gate consumes slice identity only. Database authority, app state and
// receipt persistence are exercised by the PostgreSQL completion tests.
const lineage: FrozenBuildLineage = {
	designSessionId: "session",
	designRevisionId: "revision",
	designRevisionDigest: "a".repeat(64),
	buildPlanId: "plan",
	buildPlanDigest: "b".repeat(64),
	appId: "app",
};
function fixture() {
	const expectedSlices = [1, 2].map((n) => ({
		id: asDesignId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
	}));
	const receipts: CommittedSliceReceipt[] = expectedSlices.map(
		(slice, index) => ({
			...lineage,
			id: `receipt-${index}`,
			changeSetId: `change-set-${index}`,
			seq: 10 + index * 3,
			batchId: `batch-${index}`,
			committedSnapshotDigest: "c".repeat(64),
			mutationCount: 1,
			committedAt: new Date(0),
			sliceId: slice.id,
			attemptId: `attempt-${index}`,
		}),
	);
	return { expectedSlices, receipts, lineage };
}
function changeSecond(patch: Partial<CommittedSliceReceipt>) {
	const value = fixture();
	value.receipts = value.receipts.map((receipt, index) =>
		index === 1 ? { ...receipt, ...patch } : receipt,
	);
	return value;
}

describe("immutable receipt-set admission", () => {
	it("accepts planned order with increasing noncontiguous app revisions without mutating evidence", () => {
		const value = fixture();
		const before = structuredClone(value);
		expect(() => assertExactCommittedSliceReceipts(value)).not.toThrow();
		expect(value).toEqual(before);
	});
	it.each(["missing", "extra"] as const)("refuses a %s receipt", (kind) => {
		const value = fixture();
		value.receipts =
			kind === "missing"
				? value.receipts.slice(0, 1)
				: [...value.receipts, ...value.receipts];
		expect(() => assertExactCommittedSliceReceipts(value)).toThrow(
			BuildCompletionVerificationError,
		);
	});
	const foreign: Record<keyof FrozenBuildLineage, string> = {
		designSessionId: "another-session",
		designRevisionId: "another-revision",
		designRevisionDigest: "d".repeat(64),
		buildPlanId: "another-plan",
		buildPlanDigest: "e".repeat(64),
		appId: "another-app",
	};
	it.each(Object.entries(foreign))(
		"refuses foreign %s even with correct slice order",
		(key, value) => {
			expect(() =>
				assertExactCommittedSliceReceipts(changeSecond({ [key]: value })),
			).toThrow(BuildCompletionVerificationError);
		},
	);
	it.each([
		["empty mutation batch", { mutationCount: 0 }],
		["duplicate sequence", { seq: 10 }],
		["backwards sequence", { seq: 9 }],
		[
			"unplanned slice",
			{ sliceId: asDesignId("00000000-0000-4000-8000-000000000099") },
		],
		[
			"duplicate slice",
			{ sliceId: asDesignId("00000000-0000-4000-8000-000000000001") },
		],
	] as const)("refuses %s", (_label, patch) => {
		expect(() =>
			assertExactCommittedSliceReceipts(changeSecond(patch)),
		).toThrow(BuildCompletionVerificationError);
	});
	it("refuses reordered planned slices even if sequence values increase", () => {
		const value = fixture();
		value.expectedSlices.reverse();
		expect(() => assertExactCommittedSliceReceipts(value)).toThrow(
			BuildCompletionVerificationError,
		);
	});
});
