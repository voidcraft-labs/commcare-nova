// components/builder/case-operations/__tests__/refusalCopy.test.ts
//
// The sentences a refusal is allowed to say.
//
// Every line here is read by an author who has just been stopped, so the
// bar is that it be TRUE of the thing that stopped them — not merely
// grammatical. The two shapes a dependency refusal comes in are the whole
// hazard: the reference wording ("uses the case X makes") is false of a
// type blocker, and there is nothing in the type shape for a reference
// walk to find, so borrowing that wording names an unrelated change.

import { describe, expect, it } from "vitest";
import type { CaseOperationMoveVerdict } from "@/lib/doc/caseOperationReview";
import type { Uuid } from "@/lib/doc/types";
import { dependencyLine, moveRefusalReason } from "../refusalCopy";

const MOVED = "op-moved" as Uuid;
const OTHER = "op-other" as Uuid;
const DEPENDENCY = "op-dependency" as Uuid;

const nameOf = (uuid: Uuid) =>
	({
		[MOVED]: "close_visit",
		[OTHER]: "update_referral",
		[DEPENDENCY]: "create_visit",
	})[uuid];

function refusal(
	verdict: Extract<CaseOperationMoveVerdict, { ok: false }>,
	dependsOn: readonly Uuid[] = [DEPENDENCY],
): string {
	return moveRefusalReason(verdict, nameOf, { moved: MOVED, dependsOn });
}

describe("moveRefusalReason", () => {
	it("names the case type's dependant, and nothing about making or using", () => {
		expect(
			refusal({
				ok: false,
				reason: "dependent-reference",
				dependencyKind: "target-type",
				blockingUuids: [OTHER],
			}),
		).toBe(
			"This order would change which kind of case “update_referral” acts on.",
		);
	});

	it("still says something true when the moved change is the only type blocker", () => {
		expect(
			refusal({
				ok: false,
				reason: "dependent-reference",
				dependencyKind: "target-type",
				blockingUuids: [MOVED],
			}),
		).toBe("This order would change which kind of case this change acts on.");
	});

	it("keeps the reference wording for a reference refusal", () => {
		expect(
			refusal({
				ok: false,
				reason: "dependent-reference",
				dependencyKind: "reference",
				blockingUuids: [OTHER],
			}),
		).toBe(
			"“update_referral” uses this change's result, so this has to stay before it.",
		);
		expect(
			refusal({
				ok: false,
				reason: "dependent-reference",
				dependencyKind: "reference",
				blockingUuids: [MOVED],
			}),
		).toBe(
			"This change uses the case “create_visit” makes, so it has to stay after it.",
		);
	});

	it("never puts the moved change on the wrong side of itself", () => {
		expect(
			refusal({
				ok: false,
				reason: "execution-order",
				blockingUuids: [MOVED],
			}),
		).toBe("The submitted form cannot carry the changes in this order.");
		expect(
			refusal({
				ok: false,
				reason: "execution-order",
				blockingUuids: [MOVED, OTHER],
			}),
		).toBe(
			"The submitted form cannot carry this order: it would put this change on the wrong side of “update_referral”.",
		);
	});
});

describe("dependencyLine", () => {
	it("says where a consumer holds its reference", () => {
		expect(
			dependencyLine("update_referral", [
				{ kind: "target" },
				{ kind: "write", property: "status" },
			]),
		).toBe(
			"“update_referral” uses it in the case it changes and the value it saves to status.",
		);
	});

	// A type blocker has no slot to point at. Inventing one would send the
	// author looking through an operation for a reference that isn't there.
	it("names a blocker that holds no reference, without inventing a slot", () => {
		expect(dependencyLine("update_referral", [])).toBe(
			"“update_referral” depends on this change.",
		);
		expect(dependencyLine(undefined, [])).toBe(
			"Another change depends on this change.",
		);
	});
});
