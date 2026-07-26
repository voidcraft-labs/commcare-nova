import { describe, expect, it } from "vitest";
import {
	caseOperationTargetTypeAfter,
	retargetCaseOperation,
} from "@/lib/doc/caseOperationIntents";
import { asUuid, type CaseOperation } from "@/lib/domain";
import { literal, matchAll, term } from "@/lib/domain/predicate";

const CREATE = asUuid("10000000-0000-4000-8000-000000000001");
const RETYPE_CREATE = asUuid("10000000-0000-4000-8000-000000000002");
const RETYPE_SESSION = asUuid("10000000-0000-4000-8000-000000000003");
const EDITED = asUuid("10000000-0000-4000-8000-000000000004");
const UNKNOWN = asUuid("10000000-0000-4000-8000-000000000099");

const create: CaseOperation = {
	uuid: CREATE,
	id: "create_referral",
	order: "a",
	action: "create",
	caseType: "referral",
	target: { kind: "new" },
	name: term(literal("Referral")),
};

const retypeCreate: CaseOperation = {
	uuid: RETYPE_CREATE,
	id: "archive_referral",
	order: "b",
	action: "update",
	caseType: "referral",
	target: { kind: "op", opUuid: CREATE },
	retype: "archived_referral",
};

const retypeSession: CaseOperation = {
	uuid: RETYPE_SESSION,
	id: "retype_patient",
	order: "c",
	action: "update",
	caseType: "patient",
	target: { kind: "session" },
	retype: "household",
};

describe("case-operation rolling target intent", () => {
	it("projects the type at the exact insertion point for session and create targets", () => {
		expect(
			caseOperationTargetTypeAfter(
				[create, retypeCreate, retypeSession],
				{ kind: "session" },
				"patient",
			),
		).toBe("household");
		expect(
			caseOperationTargetTypeAfter(
				[create, retypeCreate, retypeSession],
				{ kind: "op", opUuid: CREATE },
				"patient",
			),
		).toBe("archived_referral");
		expect(
			caseOperationTargetTypeAfter(
				[],
				{ kind: "op", opUuid: CREATE },
				"patient",
			),
		).toBeUndefined();
		expect(
			caseOperationTargetTypeAfter(
				[create, retypeCreate],
				{ kind: "op", opUuid: UNKNOWN },
				"patient",
			),
		).toBeUndefined();
	});

	it("advances an exact expression target from its first asserted type", () => {
		const target = {
			kind: "expression" as const,
			expr: term(literal("fixed-case-id")),
		};
		const first: CaseOperation = {
			uuid: RETYPE_CREATE,
			id: "retype_fixed",
			order: "a",
			action: "update",
			caseType: "patient",
			target,
			retype: "visit",
		};
		expect(
			caseOperationTargetTypeAfter([first], target, "unrelated_session"),
		).toBe("visit");
	});

	it.each(["update", "close"] as const)(
		"retargets a %s atomically to the target's rolling type without dropping facets",
		(action) => {
			const operation: CaseOperation = {
				uuid: EDITED,
				id: `${action}_case`,
				order: "z",
				action,
				caseType: "household",
				target: { kind: "session" },
				condition: matchAll(),
				writes: [{ property: "note", value: term(literal("kept")) }],
				...(action === "update" && {
					rename: term(literal("Still kept")),
					retype: "closed_referral",
				}),
			};

			expect(
				retargetCaseOperation(
					operation,
					{ kind: "op", opUuid: CREATE },
					[create, retypeCreate, retypeSession],
					"patient",
				),
			).toEqual({
				...operation,
				caseType: "archived_referral",
				target: { kind: "op", opUuid: CREATE },
			});
		},
	);

	it("keeps the asserted type for a newly-authored runtime target", () => {
		const operation: CaseOperation = {
			uuid: EDITED,
			id: "update_case",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
		};
		const target = {
			kind: "expression" as const,
			expr: term(literal("another-case")),
		};
		expect(
			retargetCaseOperation(operation, target, [create], "patient"),
		).toEqual({ ...operation, target });
	});
});
