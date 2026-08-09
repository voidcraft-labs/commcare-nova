/**
 * Cycle legality and round derivation: pure gate evaluation over
 * fabricated ancestry. What must hold (the loop plan's §7, pinned):
 *
 *  - submitContract opens a cycle: legal on an empty session, ILLEGAL over
 *    a fresh unreviewed draft with no newer user content, legal again when
 *    the digest moved (supersede), ILLEGAL over a reviewed-undispositioned
 *    draft regardless of content, and legal over an accepted head only
 *    when newer user content arrived (reopen).
 *  - rounds are digest-INDEPENDENT and cycle-scoped: neither a crash and
 *    resume nor a question round between a review and its revision mints
 *    an extra round, and a reopened cycle starts a fresh budget.
 *  - submitPlan is gated by acceptance AND blocking questions; an accepted
 *    revision carrying them never becomes plannable (immutability), so the
 *    refusal names the reopen path.
 *  - every refusal names the legal next action.
 */

import { describe, expect, it } from "vitest";
import type {
	DesignBuildPlanRecord,
	DesignReviewRecord,
	DesignRevisionRecord,
} from "@/lib/agent/design/artifactStore";
import {
	DESIGN_SEQUENCE_ERROR_BUDGET,
	DESIGN_SUBMISSION_REPAIR_BUDGET,
	type DesignAncestry,
	DesignRepairTracker,
	evaluateDesignGates,
} from "@/lib/agent/design/loop/gates";
import { cloneContract, makeContract } from "../../__tests__/fixtures";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const D3 = "3".repeat(64);

function revision(args: {
	id: string;
	revision: number;
	lifecycle: "draft" | "accepted";
	digest: string;
	blocking?: boolean;
}): DesignRevisionRecord {
	const contract = cloneContract(makeContract());
	if (args.blocking) {
		const question = contract.openQuestions[0];
		if (question) question.blocking = true;
	}
	return {
		id: args.id,
		designSessionId: "session-1",
		revision: args.revision,
		parentRevisionId: null,
		lifecycle: args.lifecycle,
		artifactDigest: "a".repeat(64),
		contractDigest: "b".repeat(64),
		sourcePackageDigest: args.digest,
		envelope: { payload: contract } as never,
		createdByRunId: "run-1",
		createdAt: new Date(0),
	};
}

function review(id: string, revisionId: string): DesignReviewRecord {
	return {
		id,
		designSessionId: "session-1",
		designRevisionId: revisionId,
		reviewOrdinal: 1,
		reviewedRevisionDigest: "a".repeat(64),
		artifactDigest: "c".repeat(64),
		envelope: { payload: { findings: [] } } as never,
		createdByRunId: "run-1",
		createdAt: new Date(0),
	};
}

function ancestry(args: {
	revisions: DesignRevisionRecord[];
	reviews?: Array<[string, DesignReviewRecord[]]>;
	plan?: DesignBuildPlanRecord | null;
	currentDigest: string;
}): DesignAncestry {
	return {
		revisions: args.revisions,
		reviewsByRevisionId: new Map(args.reviews ?? []),
		plan: args.plan ?? null,
		currentPackageDigest: args.currentDigest,
	};
}

describe("submitContract cycle legality", () => {
	it("is legal on an empty session and nothing else is", () => {
		const gates = evaluateDesignGates(
			ancestry({ revisions: [], currentDigest: D1 }),
		);
		expect(gates.verdicts.submitContract.legal).toBe(true);
		for (const name of [
			"requestReview",
			"submitRevision",
			"submitPlan",
		] as const) {
			const verdict = gates.verdicts[name];
			expect(verdict.legal).toBe(false);
			if (!verdict.legal) expect(verdict.refusal).toContain("submitContract");
		}
	});

	it("refuses over a fresh unreviewed draft, naming requestReview", () => {
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [
					revision({ id: "r1", revision: 1, lifecycle: "draft", digest: D1 }),
				],
				currentDigest: D1,
			}),
		);
		const verdict = gates.verdicts.submitContract;
		expect(verdict.legal).toBe(false);
		if (!verdict.legal) expect(verdict.refusal).toContain("requestReview");
		expect(gates.verdicts.requestReview.legal).toBe(true);
	});

	it("supersedes a stale unreviewed draft once newer user content exists", () => {
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [
					revision({ id: "r1", revision: 1, lifecycle: "draft", digest: D1 }),
				],
				currentDigest: D2,
			}),
		);
		expect(gates.verdicts.submitContract.legal).toBe(true);
		/* Reviewing the stale draft stays legal too: the agent judges whether
		 * the new input changes the design; the server only guards integrity. */
		expect(gates.verdicts.requestReview.legal).toBe(true);
	});

	it("never supersedes a reviewed-undispositioned draft", () => {
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [
					revision({ id: "r1", revision: 1, lifecycle: "draft", digest: D1 }),
				],
				reviews: [["r1", [review("v1", "r1")]]],
				currentDigest: D2,
			}),
		);
		const verdict = gates.verdicts.submitContract;
		expect(verdict.legal).toBe(false);
		if (!verdict.legal) expect(verdict.refusal).toContain("submitRevision");
		expect(gates.verdicts.submitRevision.legal).toBe(true);
	});

	it("reopens after acceptance only when the digest moved", () => {
		const accepted = revision({
			id: "r2",
			revision: 2,
			lifecycle: "accepted",
			digest: D1,
		});
		const closed = evaluateDesignGates(
			ancestry({ revisions: [accepted], currentDigest: D1 }),
		);
		expect(closed.verdicts.submitContract.legal).toBe(false);
		expect(closed.verdicts.submitPlan.legal).toBe(true);

		const reopened = evaluateDesignGates(
			ancestry({ revisions: [accepted], currentDigest: D2 }),
		);
		expect(reopened.verdicts.submitContract.legal).toBe(true);
	});
});

describe("round derivation is digest-independent and cycle-scoped", () => {
	it("a question round between review and revision mints nothing", () => {
		const draft = revision({
			id: "r1",
			revision: 1,
			lifecycle: "draft",
			digest: D1,
		});
		/* The user answered questions after the review: the digest moved, the
		 * review still counts, and the only legal forward move on the reviewed
		 * draft is still the revision. */
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [draft],
				reviews: [["r1", [review("v1", "r1")]]],
				currentDigest: D2,
			}),
		);
		expect(gates.openCycleReviews).toBe(1);
		expect(gates.verdicts.requestReview.legal).toBe(false);
		expect(gates.verdicts.submitRevision.legal).toBe(true);
	});

	it("counts both rounds within one cycle and refuses a third", () => {
		const draft1 = revision({
			id: "r1",
			revision: 1,
			lifecycle: "draft",
			digest: D1,
		});
		const draft2 = revision({
			id: "r2",
			revision: 2,
			lifecycle: "draft",
			digest: D2,
		});
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [draft1, draft2],
				reviews: [
					["r1", [review("v1", "r1")]],
					["r2", [review("v2", "r2")]],
				],
				currentDigest: D3,
			}),
		);
		expect(gates.openCycleReviews).toBe(2);
		expect(gates.verdicts.requestReview.legal).toBe(false);
		expect(gates.verdicts.submitRevision.legal).toBe(true);
	});

	it("a reopened cycle starts a fresh budget above the accepted revision", () => {
		const draft1 = revision({
			id: "r1",
			revision: 1,
			lifecycle: "draft",
			digest: D1,
		});
		const accepted = revision({
			id: "r2",
			revision: 2,
			lifecycle: "accepted",
			digest: D1,
		});
		const draft3 = revision({
			id: "r3",
			revision: 3,
			lifecycle: "draft",
			digest: D2,
		});
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [draft1, accepted, draft3],
				reviews: [["r1", [review("v1", "r1")]]],
				currentDigest: D2,
			}),
		);
		expect(gates.openCycleReviews).toBe(0);
		expect(gates.verdicts.requestReview.legal).toBe(true);
	});
});

describe("submitPlan gating", () => {
	it("blocking questions on the accepted head refuse the plan and name the reopen path", () => {
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [
					revision({
						id: "r2",
						revision: 2,
						lifecycle: "accepted",
						digest: D1,
						blocking: true,
					}),
				],
				currentDigest: D1,
			}),
		);
		const verdict = gates.verdicts.submitPlan;
		expect(verdict.legal).toBe(false);
		if (!verdict.legal) expect(verdict.refusal).toContain("askQuestions");
		expect(gates.blockingQuestions).toHaveLength(1);
		/* Before the answers arrive, reopening is illegal too: the pause is
		 * the only move. */
		expect(gates.verdicts.submitContract.legal).toBe(false);
	});

	it("an existing plan closes the design phase", () => {
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [
					revision({
						id: "r2",
						revision: 2,
						lifecycle: "accepted",
						digest: D1,
					}),
				],
				plan: { id: "p1" } as DesignBuildPlanRecord,
				currentDigest: D1,
			}),
		);
		expect(gates.verdicts.submitPlan.legal).toBe(false);
		expect(gates.expectedNext).toContain("complete");
	});

	it("treats a historical plan as inactive after newer user content", () => {
		const accepted = revision({
			id: "r2",
			revision: 2,
			lifecycle: "accepted",
			digest: D1,
		});
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [accepted],
				plan: { id: "p1" } as DesignBuildPlanRecord,
				currentDigest: D2,
			}),
		);
		expect(gates.plan).toBeNull();
		expect(gates.verdicts.submitContract.legal).toBe(true);
		expect(gates.expectedNext).toContain("submitContract");
	});

	it("treats a historical plan as inactive when a newer draft is the head", () => {
		const accepted = revision({
			id: "r2",
			revision: 2,
			lifecycle: "accepted",
			digest: D1,
		});
		const draft = revision({
			id: "r3",
			revision: 3,
			lifecycle: "draft",
			digest: D2,
		});
		const gates = evaluateDesignGates(
			ancestry({
				revisions: [accepted, draft],
				plan: { id: "p1" } as DesignBuildPlanRecord,
				currentDigest: D2,
			}),
		);
		expect(gates.plan).toBeNull();
		expect(gates.verdicts.requestReview.legal).toBe(true);
	});
});

describe("repair budgets", () => {
	it("latches fatal after consecutive schema rejections of one kind", () => {
		const repair = new DesignRepairTracker();
		for (let i = 0; i < DESIGN_SUBMISSION_REPAIR_BUDGET - 1; i += 1) {
			repair.noteSchemaRejection("submitContract");
			expect(repair.fatalError()).toBeUndefined();
		}
		repair.noteSchemaRejection("submitContract");
		expect(repair.fatalError()?.message).toContain("submitContract");
	});

	it("an accepted submission resets the counter", () => {
		const repair = new DesignRepairTracker();
		repair.noteSchemaRejection("submitPlan");
		repair.noteAccepted("submitPlan");
		repair.noteSchemaRejection("submitPlan");
		expect(repair.fatalError()).toBeUndefined();
	});

	it("persistent illegality latches fatal", () => {
		const repair = new DesignRepairTracker();
		for (let i = 0; i < DESIGN_SEQUENCE_ERROR_BUDGET; i += 1) {
			repair.noteSequenceError();
		}
		expect(repair.fatalError()?.message).toContain("out-of-order");
	});
});
