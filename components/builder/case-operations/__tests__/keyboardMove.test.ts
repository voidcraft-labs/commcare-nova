// components/builder/case-operations/__tests__/keyboardMove.test.ts
//
// The headline requirement of this unit, as a pure decision: a refused
// keyboard reorder must SAY why and name the changes it is about. A
// pointer user reads that off a drop zone that will not open; a keyboard
// user gets it from here or not at all.

import { describe, expect, it } from "vitest";
import type { CaseOperationMoveVerdict } from "@/lib/doc/caseOperationReview";
import type { Uuid } from "@/lib/doc/types";
import { planKeyboardMove } from "../keyboardMove";

const A = "op-a" as Uuid;
const B = "op-b" as Uuid;
const C = "op-c" as Uuid;

const NAMES: Record<string, string> = {
	[A]: "create_referral",
	[B]: "update_client",
	[C]: "close_visit",
};
const nameOf = (uuid: Uuid) => NAMES[uuid];

/** Every destination available. */
function allOk(length: number): Map<number, CaseOperationMoveVerdict> {
	return new Map(
		Array.from({ length }, (_, index) => [index, { ok: true } as const]),
	);
}

describe("planKeyboardMove", () => {
	it("moves and says where it landed", () => {
		const outcome = planKeyboardMove({
			order: [A, B, C],
			index: 2,
			key: "ArrowUp",
			verdicts: allOk(3),
			nameOf,
		});
		expect(outcome).toEqual({
			kind: "move",
			toIndex: 1,
			announcement: "close_visit moved earlier, now 2 of 3.",
		});
	});

	it("Home and End travel to the ends", () => {
		expect(
			planKeyboardMove({
				order: [A, B, C],
				index: 2,
				key: "Home",
				verdicts: allOk(3),
				nameOf,
			}),
		).toMatchObject({ kind: "move", toIndex: 0 });
		expect(
			planKeyboardMove({
				order: [A, B, C],
				index: 0,
				key: "End",
				verdicts: allOk(3),
				nameOf,
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
		});
		expect(outcome).toEqual({
			kind: "at-edge",
			announcement: "create_referral is already first.",
		});
	});

	it("speaks a dependency refusal and names the consumer", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[0, { ok: false, reason: "dependent-reference", blockingUuids: [B] }],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardMove({
			order: [B, A],
			index: 1,
			key: "ArrowUp",
			verdicts,
			nameOf,
		});
		expect(outcome?.kind).toBe("refused");
		// The name of the change that did not move leads, then the reason,
		// then the change the reason is about.
		expect(outcome?.announcement).toBe(
			"create_referral did not move earlier. “update_client” uses this change's result, so this has to stay before it.",
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
		});
		expect(outcome?.kind).toBe("refused");
		// It is a property of the submitted form, not a mistake the author
		// made, so the wording must not blame their app.
		expect(outcome?.announcement).toContain("The submitted form cannot carry");
		expect(outcome?.announcement).toContain("“close_visit”");
		expect(outcome?.announcement).not.toContain("uses this change's result");
	});

	it("still reads as a sentence when a blocking change has no name", () => {
		const verdicts = new Map<number, CaseOperationMoveVerdict>([
			[
				0,
				{
					ok: false,
					reason: "dependent-reference",
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
		});
		expect(outcome?.announcement).toContain("another change");
		expect(outcome?.announcement).not.toContain("undefined");
	});

	it("returns nothing for an index that is not in the list", () => {
		expect(
			planKeyboardMove({
				order: [A],
				index: 4,
				key: "ArrowDown",
				verdicts: allOk(1),
				nameOf,
			}),
		).toBeUndefined();
	});
});
