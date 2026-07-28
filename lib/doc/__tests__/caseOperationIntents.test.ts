import { describe, expect, expectTypeOf, it } from "vitest";
import {
	caseOperationTargetTypeAfter,
	retargetCaseOperation,
	retargetCaseOperationLink,
} from "@/lib/doc/caseOperationIntents";
import {
	asUuid,
	type CaseOperation,
	type CaseOperationLink,
} from "@/lib/domain";
import { literal, matchAll, term } from "@/lib/domain/predicate";

const CREATE = asUuid("10000000-0000-4000-8000-000000000001");
const RETYPE_CREATE = asUuid("10000000-0000-4000-8000-000000000002");
const RETYPE_SESSION = asUuid("10000000-0000-4000-8000-000000000003");
const EDITED = asUuid("10000000-0000-4000-8000-000000000004");
const UNKNOWN = asUuid("10000000-0000-4000-8000-000000000099");

const create: CaseOperation = {
	uuid: CREATE,
	id: "create_referral",
	action: "create",
	caseType: "referral",
	target: { kind: "new" },
	name: term(literal("Referral")),
};

const retypeCreate: CaseOperation = {
	uuid: RETYPE_CREATE,
	id: "archive_referral",
	action: "update",
	caseType: "referral",
	target: { kind: "op", opUuid: CREATE },
	retype: "archived_referral",
};

const retypeSession: CaseOperation = {
	uuid: RETYPE_SESSION,
	id: "retype_patient",
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

	describe("connection target intent", () => {
		expectTypeOf<{ kind: "new" }>().not.toMatchTypeOf<
			Parameters<typeof retargetCaseOperationLink>[1]
		>();

		const link: CaseOperationLink = {
			identifier: "parent",
			targetType: "patient",
			target: { kind: "session" },
			relationship: "child",
		};

		it("keeps every peer facet when unlinking", () => {
			expect(
				retargetCaseOperationLink(
					link,
					null,
					[create, retypeCreate, retypeSession],
					"patient",
				),
			).toEqual({ ...link, target: null });
		});

		it("adopts the rolling type with a session or prior-create target", () => {
			expect(
				retargetCaseOperationLink(
					link,
					{ kind: "session" },
					[create, retypeCreate, retypeSession],
					"patient",
				),
			).toEqual({ ...link, targetType: "household" });
			expect(
				retargetCaseOperationLink(
					link,
					{ kind: "op", opUuid: CREATE },
					[create, retypeCreate, retypeSession],
					"patient",
				),
			).toEqual({
				...link,
				targetType: "archived_referral",
				target: { kind: "op", opUuid: CREATE },
			});
		});

		it("retains the exact runtime expression AST and its asserted type", () => {
			const target = {
				kind: "expression" as const,
				expr: term(literal("case-id-authored-by-the-user")),
			};
			expect(
				retargetCaseOperationLink(
					{ ...link, targetType: "referral" },
					target,
					[create],
					"patient",
				),
			).toEqual({
				...link,
				targetType: "referral",
				target,
			});
		});
	});
});
