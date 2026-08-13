import { describe, expect, it } from "vitest";
import type {
	DesignBuildPlanRecord,
	DesignReviewRecord,
	DesignRevisionRecord,
} from "@/lib/agent/design/artifactStore";
import {
	DESIGN_LOOP_STEP_BUDGET,
	DESIGN_ROLLOVER_ALLOWANCE_CAP,
	DESIGN_ROLLOVER_STEP_ALLOWANCE,
	DESIGN_SEQUENCE_ERROR_BUDGET,
	DESIGN_STAGE_REPAIR_BUDGET,
	type DesignAncestry,
	DesignRepairTracker,
	designLoopStepBudget,
	evaluateDesignGates,
} from "@/lib/agent/design/loop/gates";
import { did, fixtureValue, makeContract } from "../../__tests__/fixtures";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);

function revision(args: {
	id: string;
	revision: number;
	lifecycle: "draft" | "accepted";
	digest: string;
	blocking?: boolean;
}): DesignRevisionRecord {
	const contract = makeContract();
	if (args.blocking) {
		contract.openQuestions.push({
			id: did(9000),
			question: "Which queue should open first?",
			structuralImpact: "local",
			blocking: true,
			relatedElementIds: [
				fixtureValue(contract.workflows[0], "first workflow").id,
			],
		});
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

function review(revisionId: string): DesignReviewRecord {
	return {
		id: `review-${revisionId}`,
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

describe("design phase gates", () => {
	it("opens with contract authoring only", () => {
		const gates = evaluateDesignGates(
			ancestry({ revisions: [], currentDigest: D1 }),
		);
		expect(gates.verdicts.submitContract.legal).toBe(true);
		expect(gates.verdicts.requestReview.legal).toBe(false);
		expect(gates.verdicts.submitRevision.legal).toBe(false);
	});

	it("moves from draft to review to revision from durable rows", () => {
		const draft = revision({
			id: "r1",
			revision: 1,
			lifecycle: "draft",
			digest: D1,
		});
		const reviewGates = evaluateDesignGates(
			ancestry({ revisions: [draft], currentDigest: D1 }),
		);
		expect(reviewGates.verdicts.requestReview.legal).toBe(true);

		const revisionGates = evaluateDesignGates(
			ancestry({
				revisions: [draft],
				reviews: [[draft.id, [review(draft.id)]]],
				currentDigest: D1,
			}),
		);
		expect(revisionGates.verdicts.submitRevision.legal).toBe(true);
		expect(revisionGates.verdicts.submitContract.legal).toBe(false);
	});

	it("reopens accepted design only for newer user content", () => {
		const accepted = revision({
			id: "r2",
			revision: 2,
			lifecycle: "accepted",
			digest: D1,
		});
		expect(
			evaluateDesignGates(
				ancestry({ revisions: [accepted], currentDigest: D1 }),
			).verdicts.submitContract.legal,
		).toBe(false);
		expect(
			evaluateDesignGates(
				ancestry({ revisions: [accepted], currentDigest: D2 }),
			).verdicts.submitContract.legal,
		).toBe(true);
	});

	it("surfaces accepted blocking questions instead of planning", () => {
		const accepted = revision({
			id: "r3",
			revision: 3,
			lifecycle: "accepted",
			digest: D1,
			blocking: true,
		});
		const gates = evaluateDesignGates(
			ancestry({ revisions: [accepted], currentDigest: D1 }),
		);
		expect(gates.blockingQuestions).toEqual(["Which queue should open first?"]);
		expect(gates.expectedNext).toContain("askQuestions");
	});

	it("recognizes only a plan bound to the accepted current head", () => {
		const accepted = revision({
			id: "r4",
			revision: 4,
			lifecycle: "accepted",
			digest: D1,
		});
		const plan = { designRevisionId: accepted.id } as DesignBuildPlanRecord;
		expect(
			evaluateDesignGates(
				ancestry({ revisions: [accepted], plan, currentDigest: D1 }),
			).plan,
		).toBe(plan);
		expect(
			evaluateDesignGates(
				ancestry({ revisions: [accepted], plan, currentDigest: D2 }),
			).plan,
		).toBeNull();
	});
});

describe("designLoopStepBudget", () => {
	it("grants one bounded allowance per context-generation rollover", () => {
		/* A rollover is a real deployment change — the corrected-harness retry
		 * the repair fuses direct users toward — so steps a since-fixed defect
		 * consumed cannot starve the retry, while the cap keeps the ceiling
		 * bounded by deploy cadence, never by anything a user can mint. */
		expect(designLoopStepBudget(0)).toBe(DESIGN_LOOP_STEP_BUDGET);
		expect(designLoopStepBudget(1)).toBe(
			DESIGN_LOOP_STEP_BUDGET + DESIGN_ROLLOVER_STEP_ALLOWANCE,
		);
		expect(designLoopStepBudget(DESIGN_ROLLOVER_ALLOWANCE_CAP + 5)).toBe(
			DESIGN_LOOP_STEP_BUDGET +
				DESIGN_ROLLOVER_ALLOWANCE_CAP * DESIGN_ROLLOVER_STEP_ALLOWANCE,
		);
		expect(designLoopStepBudget(-1)).toBe(DESIGN_LOOP_STEP_BUDGET);
	});
});

describe("DesignRepairTracker", () => {
	it("stops an exact repeated finalization diagnostic and illegal sequencing", () => {
		const schema = new DesignRepairTracker();
		schema.noteSubmissionRejection("submitContract", {
			stage: "schema",
			fingerprints: ["records.0.id|duplicate"],
		});
		schema.noteSubmissionRejection("submitContract", {
			stage: "schema",
			fingerprints: ["records.0.id|duplicate"],
		});
		expect(schema.fatalError()).toBeDefined();
		expect(schema.fatalError()?.code).toBe("design-submission-nonconvergent");

		const sequence = new DesignRepairTracker();
		for (let index = 0; index < DESIGN_SEQUENCE_ERROR_BUDGET; index += 1) {
			sequence.noteSequenceError();
		}
		expect(sequence.fatalError()).toBeDefined();
		expect(sequence.fatalError()?.code).toBe("design-sequence-budget");
	});

	it("treats a later validation stage and changed diagnostics as progress", () => {
		const tracker = new DesignRepairTracker();
		tracker.noteSubmissionRejection("submitContract", {
			stage: "schema",
			fingerprints: Array.from(
				{ length: 6 },
				(_, index) => `duplicate-${index}`,
			),
		});
		tracker.noteSubmissionRejection("submitContract", {
			stage: "construction",
			fingerprints: Array.from(
				{ length: 7 },
				(_, index) => `question-${index}`,
			),
		});
		expect(tracker.fatalError()).toBeUndefined();

		tracker.noteSubmissionRejection("submitContract", {
			stage: "construction",
			fingerprints: ["a-different-construction-finding"],
		});
		expect(tracker.fatalError()?.code).toBe("design-submission-nonconvergent");
	});

	it("stops consecutive identical stage rejections", () => {
		const tracker = new DesignRepairTracker();
		const fingerprint =
			"design-creation-handle-required|collections.0.upserts.0.id declares a new design identity with a raw UUID.";
		for (let index = 0; index < DESIGN_STAGE_REPAIR_BUDGET - 1; index += 1) {
			tracker.noteStageRejection("stageContract", fingerprint);
			expect(tracker.fatalError()).toBeUndefined();
		}
		tracker.noteStageRejection("stageContract", fingerprint);
		expect(tracker.fatalError()?.code).toBe("design-stage-nonconvergent");
	});

	it("treats a changed stage diagnostic or an accepted stage as progress", () => {
		const alternating = new DesignRepairTracker();
		alternating.noteStageRejection("stageContract", "issue-a");
		alternating.noteStageRejection("stageContract", "issue-b");
		alternating.noteStageRejection("stageContract", "issue-a");
		alternating.noteStageRejection("stageContract", "issue-b");
		expect(alternating.fatalError()).toBeUndefined();

		const interrupted = new DesignRepairTracker();
		interrupted.noteStageRejection("stageRevision", "issue-a");
		interrupted.noteStageRejection("stageRevision", "issue-a");
		interrupted.noteStageAccepted("stageRevision");
		interrupted.noteStageRejection("stageRevision", "issue-a");
		interrupted.noteStageRejection("stageRevision", "issue-a");
		expect(interrupted.fatalError()).toBeUndefined();
	});

	it("tracks construction questions outside the repair budget", () => {
		const tracker = new DesignRepairTracker();
		tracker.noteSubmissionRejection("submitContract", {
			stage: "schema",
			fingerprints: ["duplicate"],
		});
		const question = {
			id: did(9100),
			question: "Which threshold applies?",
			structuralImpact: "local" as const,
			blocking: true,
			relatedElementIds: [did(1)],
		};
		tracker.requireUserQuestions([
			question,
			{ ...question, id: did(9101), question: "" },
		]);
		expect(tracker.requiredUserQuestions()).toEqual([question]);
		expect(tracker.fatalError()).toBeUndefined();
	});
});
