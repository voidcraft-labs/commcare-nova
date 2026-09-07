/** Pure repair accounting. Artifact-state gates are exercised against PostgreSQL. */
import { describe, expect, it } from "vitest";
import {
	DESIGN_LOOP_STEP_BUDGET,
	DESIGN_ROLLOVER_ALLOWANCE_CAP,
	DESIGN_ROLLOVER_STEP_ALLOWANCE,
	DESIGN_SEQUENCE_ERROR_BUDGET,
	DESIGN_STAGE_REPAIR_BUDGET,
	DesignLoopBudgetError,
	DesignRepairTracker,
	designLoopStepBudget,
} from "@/lib/agent/design/loop/gates";
import { did } from "../../__tests__/fixtures";

describe("designLoopStepBudget", () => {
	it.each([
		[-5, 64],
		[0, 64],
		[1, 96],
		[2, 128],
		[3, 128],
		[100, 128],
	])("generation %s has exact step ceiling %s", (generation, ceiling) => {
		expect(designLoopStepBudget(generation)).toBe(ceiling);
	});
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
	it.each(["submitContract", "requestReview", "submitRevision"] as const)(
		"tracks complete rejection-set equality for %s regardless of order or duplicate diagnostics",
		(kind) => {
			const tracker = new DesignRepairTracker();
			tracker.noteSubmissionRejection(kind, {
				stage: "schema",
				fingerprints: ["b", "a", "b"],
			});
			expect(tracker.fatalError()).toBeUndefined();
			tracker.noteSubmissionRejection(kind, {
				stage: "schema",
				fingerprints: ["a", "b"],
			});
			expect(tracker.fatalError()).toBeInstanceOf(DesignLoopBudgetError);
			expect(tracker.fatalError()).toMatchObject({
				name: "DesignLoopBudgetError",
				code: "design-submission-nonconvergent",
			});
		},
	);

	it.each(["schema", "construction", "sensitivity"] as const)(
		"permits changed %s evidence once and stops the third rejected finalization",
		(stage) => {
			const tracker = new DesignRepairTracker();
			tracker.noteSubmissionRejection("submitRevision", {
				stage,
				fingerprints: ["first"],
			});
			tracker.noteSubmissionRejection("submitRevision", {
				stage,
				fingerprints: ["second"],
			});
			expect(tracker.fatalError()).toBeUndefined();
			tracker.noteSubmissionRejection("submitRevision", {
				stage,
				fingerprints: ["third"],
			});
			expect(tracker.fatalError()?.code).toBe(
				"design-submission-nonconvergent",
			);
		},
	);

	it("keeps submission kinds independent and clears only the accepted kind", () => {
		const tracker = new DesignRepairTracker();
		const rejection = { stage: "schema" as const, fingerprints: ["same"] };
		tracker.noteSubmissionRejection("submitContract", rejection);
		tracker.noteSubmissionRejection("submitRevision", rejection);
		expect(tracker.fatalError()).toBeUndefined();
		tracker.noteAccepted("submitContract");
		tracker.noteSubmissionRejection("submitContract", rejection);
		expect(tracker.fatalError()).toBeUndefined();
		tracker.noteSubmissionRejection("submitRevision", rejection);
		expect(tracker.fatalError()?.code).toBe("design-submission-nonconvergent");
	});

	it("phase legality resets sequence errors without erasing independent finalization history", () => {
		const tracker = new DesignRepairTracker();
		tracker.noteSequenceError();
		tracker.noteSequenceError();
		tracker.noteLegalCall();
		tracker.noteSequenceError();
		tracker.noteSequenceError();
		expect(tracker.fatalError()).toBeUndefined();
		tracker.noteSequenceError();
		expect(tracker.fatalError()?.code).toBe("design-sequence-budget");
		const finalization = new DesignRepairTracker();
		finalization.noteSubmissionRejection("submitContract", {
			stage: "schema",
			fingerprints: ["same"],
		});
		finalization.noteLegalCall();
		finalization.noteSubmissionRejection("submitContract", {
			stage: "schema",
			fingerprints: ["same"],
		});
		expect(finalization.fatalError()?.code).toBe(
			"design-submission-nonconvergent",
		);
	});

	it.each(["stageContract", "stageRevision"] as const)(
		"changed or accepted %s staging resets its consecutive count while another kind does not",
		(kind) => {
			const tracker = new DesignRepairTracker();
			tracker.noteStageRejection(kind, "first");
			tracker.noteStageRejection(kind, "first");
			tracker.noteStageRejection(kind, "changed");
			tracker.noteStageRejection(kind, "changed");
			expect(tracker.fatalError()).toBeUndefined();
			tracker.noteStageAccepted(kind);
			tracker.noteStageRejection(kind, "changed");
			tracker.noteStageRejection(kind, "changed");
			tracker.noteStageAccepted(
				kind === "stageContract" ? "stageRevision" : "stageContract",
			);
			expect(tracker.fatalError()).toBeUndefined();
			tracker.noteStageRejection(kind, "changed");
			expect(tracker.fatalError()?.code).toBe("design-stage-nonconvergent");
		},
	);

	it("a fatal result survives accepted calls and cleared questions", () => {
		const tracker = new DesignRepairTracker();
		for (let index = 0; index < 3; index += 1) tracker.noteSequenceError();
		const fatal = tracker.fatalError();
		expect(fatal).toBeInstanceOf(DesignLoopBudgetError);
		tracker.noteLegalCall();
		tracker.noteAccepted("submitContract");
		tracker.noteStageAccepted("stageContract");
		tracker.requireUserQuestions([]);
		expect(tracker.fatalError()).toBe(fatal);
	});

	it("deduplicates current questions, preserves source objects, and clears them on accepted finalization", () => {
		const tracker = new DesignRepairTracker();
		const first = {
			id: did(9900),
			question: "  Which queue?  ",
			blocking: true,
			relatedElementIds: [did(1)],
		};
		const replacement = { ...first, question: " Which queue opens first? " };
		const second = { ...first, id: did(9901), question: " Which threshold? " };
		const input = [
			first,
			second,
			replacement,
			{ ...first, id: did(9902), question: " \t " },
		];
		const before = structuredClone(input);
		tracker.requireUserQuestions(input);
		expect(tracker.requiredUserQuestions()).toEqual([
			{ ...replacement, question: "Which queue opens first?" },
			{ ...second, question: "Which threshold?" },
		]);
		expect(input).toEqual(before);
		tracker.noteSequenceError();
		tracker.noteSequenceError();
		tracker.noteAccepted("submitRevision");
		expect(tracker.requiredUserQuestions()).toEqual([]);
		tracker.noteSequenceError();
		expect(tracker.fatalError()).toBeUndefined();
		tracker.requireUserQuestions([second]);
		tracker.requireUserQuestions([]);
		expect(tracker.requiredUserQuestions()).toEqual([]);
	});

	it("asking required questions does not erase a previous identical submission rejection", () => {
		const tracker = new DesignRepairTracker();
		const rejection = {
			stage: "construction" as const,
			fingerprints: ["pending-effect"],
		};
		tracker.noteSubmissionRejection("submitRevision", rejection);
		tracker.requireUserQuestions([
			{
				id: did(9950),
				question: "Which threshold?",
				blocking: true,
				relatedElementIds: [did(1)],
			},
		]);
		tracker.noteSubmissionRejection("submitRevision", rejection);
		expect(tracker.fatalError()?.code).toBe("design-submission-nonconvergent");
	});
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
