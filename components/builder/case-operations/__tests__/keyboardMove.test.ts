// components/builder/case-operations/__tests__/keyboardMove.test.ts
//
// The headline requirement of this unit, as a pure decision: a refused
// keyboard reorder must SAY why and name the changes it is about. A
// pointer user reads that off a drop zone that will not open; a keyboard
// user gets it from here or not at all.

import { describe, expect, it } from "vitest";
import type { CaseOperationMoveVerdict } from "@/lib/doc/caseOperationReview";
import type { Uuid } from "@/lib/doc/types";
import { type KeyboardMoveOutcome, planKeyboardMove } from "../keyboardMove";

const A = "op-a" as Uuid;
const B = "op-b" as Uuid;
const C = "op-c" as Uuid;

const NAMES: Record<string, string> = {
	[A]: "create_referral",
	[B]: "update_client",
	[C]: "close_visit",
};
const nameOf = (uuid: Uuid) => NAMES[uuid];

/** The sentence an outcome carries. Only the outcomes that did NOT move have
 *  one: a committed move is described by the canvas from the document after
 *  the commit, so there is no sentence to plan here. */
function announcementOf(outcome: KeyboardMoveOutcome | undefined): string {
	if (outcome === undefined || outcome.kind === "move") {
		throw new Error(
			`Expected a refused or at-edge outcome, which carry words. Got ${outcome?.kind ?? "no outcome"}.`,
		);
	}
	return outcome.announcement;
}

/** Every destination available. */
function allOk(length: number): Map<number, CaseOperationMoveVerdict> {
	return new Map(
		Array.from({ length }, (_, index) => [index, { ok: true } as const]),
	);
}

describe("planKeyboardMove", () => {
	it("names the destination and nothing else", () => {
		const outcome = planKeyboardMove({
			order: [A, B, C],
			index: 2,
			key: "ArrowUp",
			verdicts: allOk(3),
			nameOf,
			dependsOn: [],
		});
		// No sentence: where a move LANDED is a fact about the committed
		// sequence, and a peer's concurrent edit is exactly when that differs
		// from the index requested here. The canvas says it after committing.
		expect(outcome).toEqual({ kind: "move", toIndex: 1 });
	});

	it("Home and End travel to the ends", () => {
		expect(
			planKeyboardMove({
				order: [A, B, C],
				index: 2,
				key: "Home",
				verdicts: allOk(3),
				nameOf,
				dependsOn: [],
			}),
		).toMatchObject({ kind: "move", toIndex: 0 });
		expect(
			planKeyboardMove({
				order: [A, B, C],
				index: 0,
				key: "End",
				verdicts: allOk(3),
				nameOf,
				dependsOn: [],
			}),
		).toMatchObject({ kind: "move", toIndex: 2 });
	});

	it("says it is already at the edge instead of moving nowhere", () => {
		const outcome = planKeyboardMove({
			order: [A, B],
			index: 0,
			key: "ArrowUp",
			verdicts: allOk(2),
			nameOf,
			dependsOn: [],
		});
		expect(outcome).toEqual({
			kind: "at-edge",
			announcement: "create_referral is already first.",
		});
	});

	it("names the consumer when moving a producer would break it", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[
				0,
				{
					ok: false,
					reason: "dependent-reference",
					dependencyKind: "reference",
					blockingUuids: [B],
				},
			],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [B, A],
			index: 1,
			key: "ArrowUp",
			verdicts,
			nameOf,
			dependsOn: [],
		});
		expect(outcome?.kind).toBe("refused");
		// The name of the change that did not move leads, then the reason,
		// then the change the reason is about.
		expect(announcementOf(outcome)).toBe(
			"create_referral did not move earlier. “update_client” uses this change's result, so this has to stay before it.",
		);
	});

	it("names what it depends on when moving a CONSUMER would break itself", () => {
		// The planner answers with the operations whose references would
		// break, which here is the moved one itself: dragging a consumer
		// ahead of what it consumes breaks its OWN reference. Naming it back
		// to the author would read as "this change uses itself", so the
		// sentence names its dependency instead.
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[
				0,
				{
					ok: false,
					reason: "dependent-reference",
					dependencyKind: "reference",
					blockingUuids: [C],
				},
			],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [A, C],
			index: 1,
			key: "Home",
			verdicts,
			nameOf,
			dependsOn: [A],
		});
		expect(announcementOf(outcome)).toBe(
			"close_visit did not move earlier. This change uses the case “create_referral” makes, so it has to stay after it.",
		);
	});

	// The bug this arm exists to stop: a type refusal used to borrow the
	// reference wording and name whatever `dependsOn` happened to hold:
	// a change that is not the blocker, described through an edge that
	// does not exist.
	it("says a target-type refusal in its own words, and never the reference ones", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[
				0,
				{
					ok: false,
					reason: "dependent-reference",
					dependencyKind: "target-type",
					blockingUuids: [B],
				},
			],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [C, A],
			index: 1,
			key: "ArrowUp",
			// An unrelated create the moved change happens to consume. The
			// reference arm would have named it; the type arm must not.
			verdicts,
			nameOf,
			dependsOn: [C],
		});
		expect(outcome?.kind).toBe("refused");
		expect(announcementOf(outcome)).toBe(
			"create_referral did not move earlier. This order would change which kind of case “update_client” acts on.",
		);
		expect(announcementOf(outcome)).not.toContain("makes");
		expect(announcementOf(outcome)).not.toContain("uses");
	});

	it("names nothing rather than the wrong thing when the moved change is the only type blocker", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[
				0,
				{
					ok: false,
					reason: "dependent-reference",
					dependencyKind: "target-type",
					blockingUuids: [A],
				},
			],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [C, A],
			index: 1,
			key: "ArrowUp",
			verdicts,
			nameOf,
			dependsOn: [C],
		});
		// The earlier change RETYPED a case rather than making one, so the
		// old "uses a case an earlier change makes" fallback was false here.
		expect(announcementOf(outcome)).toBe(
			"create_referral did not move earlier. This order would change which kind of case this change acts on.",
		);
	});

	it("keeps an execution-order refusal distinct from a dependency one", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[0, { ok: false, reason: "execution-order", blockingUuids: [C] }],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [C, A],
			index: 1,
			key: "ArrowUp",
			verdicts,
			nameOf,
			dependsOn: [],
		});
		expect(outcome?.kind).toBe("refused");
		// It is a property of the submitted form, not a mistake the author
		// made, so the wording must not blame their app.
		expect(announcementOf(outcome)).toContain(
			"The submitted form cannot carry",
		);
		expect(announcementOf(outcome)).toContain("“close_visit”");
		expect(announcementOf(outcome)).not.toContain("uses this change's result");
	});

	// A wire-order refusal names the operation that would land wrong, and
	// that is often the moved one. Putting it "on the wrong side of" itself
	// is not a sentence about anything.
	it("never names the moved change back to itself in an execution-order refusal", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[0, { ok: false, reason: "execution-order", blockingUuids: [A] }],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [C, A],
			index: 1,
			key: "ArrowUp",
			verdicts,
			nameOf,
			dependsOn: [],
		});
		expect(announcementOf(outcome)).toBe(
			"create_referral did not move earlier. The submitted form cannot carry the changes in this order.",
		);
	});

	it("still names the other changes when a wire-order refusal includes the moved one", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[0, { ok: false, reason: "execution-order", blockingUuids: [A, C] }],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [C, A],
			index: 1,
			key: "ArrowUp",
			verdicts,
			nameOf,
			dependsOn: [],
		});
		expect(announcementOf(outcome)).toContain("“close_visit”");
		expect(announcementOf(outcome)).not.toContain("“create_referral”");
	});

	it("still reads as a sentence when a blocking change has no name", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[
				0,
				{
					ok: false,
					reason: "dependent-reference",
					dependencyKind: "reference",
					blockingUuids: ["gone" as Uuid],
				},
			],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [B, A],
			index: 1,
			key: "ArrowUp",
			verdicts,
			nameOf,
			dependsOn: [],
		});
		expect(announcementOf(outcome)).toContain("another change");
		expect(announcementOf(outcome)).not.toContain("undefined");
	});

	it("returns nothing for an index that is not in the list", () => {
		expect(
			planKeyboardMove({
				order: [A],
				index: 4,
				key: "ArrowDown",
				verdicts: allOk(1),
				nameOf,
				dependsOn: [],
			}),
		).toBeUndefined();
	});
});
