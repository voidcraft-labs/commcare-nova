/**
 * The form's own case at the commit gate: exactly one own arm, first, only
 * on a case form of a module with a case type (`CASE_OWN_OPERATION`); the
 * open and close conditions only on the form types that hold them; and the
 * own arm's independence from every other operation, which is what lets its
 * first place in the array and Case Management's block, which HQ appends
 * after every other, mean the same thing. A failure here is an own arm the
 * wire cannot run the same way at either end.
 */
import { describe, expect, it } from "vitest";
import {
	childCreate,
	OP,
	OWN,
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import type { ValidationError, ValidationErrorCode } from "../../errors";
import { runValidation } from "../../runner";

function findings(
	doc: BlueprintDoc,
	code: ValidationErrorCode,
): ValidationError[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(error) => error.code === code,
	);
}

function update(
	key: string,
	extra: Partial<CaseOperation> = {},
): CaseOperation {
	return {
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		...extra,
	} as CaseOperation;
}

describe("CASE_OWN_OPERATION", () => {
	it("refuses a case form without its own case", () => {
		const { doc } = placementFixture("followup", { operations: () => [] });
		const [finding] = findings(doc, "CASE_OWN_OPERATION");
		expect(finding?.details?.reason).toBe("missing");
		expect(finding?.message).toBe(
			"“Under test” is a follow-up form, so it needs a change for its own case, and it has none. Setting the form's type again adds it.",
		);
	});

	it("refuses a second own case", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [own(), own({ uuid: OP("own-2"), id: "patient_2" })],
		});
		const [finding] = findings(doc, "CASE_OWN_OPERATION");
		expect(finding?.details?.reason).toBe("duplicate");
		expect(finding?.message).toBe(
			"“Under test” has two changes for its own case. You can move the saves of one into the other and remove it.",
		);
	});

	it("refuses an own case that is not the first change", () => {
		const { doc } = placementFixture("followup", {
			operations: (type) => [childCreate("kid", type), own()],
		});
		const [finding] = findings(doc, "CASE_OWN_OPERATION");
		expect(finding?.details?.reason).toBe("position");
		expect(finding?.message).toBe(
			"The change for “Under test”'s own case has to come first. You can move the other changes after it.",
		);
	});

	it("refuses an own case on a survey", () => {
		const { doc } = placementFixture("survey", { operations: () => [own()] });
		const [finding] = findings(doc, "CASE_OWN_OPERATION");
		expect(finding?.details?.reason).toBe("form-type");
		expect(finding?.message).toBe(
			"“Under test” is a survey, so it has no case of its own to change. You can remove this change or choose another form type.",
		);
	});

	it("refuses an own case in a menu without a case type", () => {
		const { doc, moduleUuid } = placementFixture("registration", {
			operations: () => [own({ name: read("name") })],
		});
		const {
			caseType: _caseType,
			caseListConfig: _list,
			...bare
		} = doc.modules[moduleUuid];
		doc.modules[moduleUuid] = bare;
		const [finding] = findings(doc, "CASE_OWN_OPERATION");
		expect(finding?.details?.reason).toBe("form-type");
		expect(finding?.message).toBe(
			"“Patients” has no case type, so “Under test” has no case of its own to change. You can give the menu a case type or remove this change.",
		);
	});

	it("admits one own case, first, on every case form", () => {
		for (const type of ["registration", "followup", "close"] as const) {
			const { doc } = placementFixture(type, {
				operations: () => [
					own(type === "registration" ? { name: read("name") } : {}),
				],
			});
			expect(findings(doc, "CASE_OWN_OPERATION")).toEqual([]);
		}
	});
});

describe("the open and close conditions", () => {
	it("refuses an open condition off a registration", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [own()],
			form: { openCondition: read("flag") },
		});
		const [finding] = findings(doc, "OPEN_CONDITION_WRONG_TYPE");
		expect(finding?.message).toBe(
			"Only a registration form creates its case on a condition, and “Under test” is a follow-up form. You can remove the condition or make it a registration form.",
		);
		expect(finding?.location.field).toBe("openCondition");
	});

	it("admits a registration's open and close conditions", () => {
		const { doc } = placementFixture("registration", {
			operations: () => [own({ name: read("name") })],
			form: { openCondition: read("flag"), closeCondition: read("flag") },
		});
		expect(findings(doc, "OPEN_CONDITION_WRONG_TYPE")).toEqual([]);
		expect(findings(doc, "CLOSE_CONDITION_WRONG_TYPE")).toEqual([]);
	});

	it("refuses a close condition on a follow-up, and admits one on a close form", () => {
		const followup = placementFixture("followup", {
			operations: () => [own()],
			form: { closeCondition: read("flag") },
		});
		expect(
			findings(followup.doc, "CLOSE_CONDITION_WRONG_TYPE")[0]?.message,
		).toBe(
			"Only registration and close forms close their own case, and “Under test” is a follow-up form. You can remove the close condition or make it a close form.",
		);
		const close = placementFixture("close", {
			operations: () => [own()],
			form: { closeCondition: read("flag") },
		});
		expect(findings(close.doc, "CLOSE_CONDITION_WRONG_TYPE")).toEqual([]);
	});
});

describe("the own case's independence", () => {
	it("refuses another change saving what the own case saves on a follow-up", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own({ writes: [{ property: "age", value: read("age") }] }),
				update("again", {
					writes: [{ property: "age", value: read("age") }],
				}),
			],
		});
		const [finding] = findings(doc, "CASE_WRITE_DUPLICATE_PROPERTY");
		expect(finding?.details).toMatchObject({
			reason: "own-case",
			property: "age",
			operationUuid: OP("again"),
		});
		expect(finding?.message).toBe(
			"“again” saves age to this form's case, which this form's own change already saves. You can save it in one of the two.",
		);
	});

	it("refuses another change saving what the own case saves on a registration", () => {
		const { doc } = placementFixture("registration", {
			operations: () => [
				own({
					name: read("name"),
					writes: [{ property: "age", value: read("age") }],
				}),
				update("again", {
					target: { kind: "op", opUuid: OWN },
					writes: [{ property: "age", value: read("age") }],
				}),
			],
		});
		expect(
			findings(doc, "CASE_WRITE_DUPLICATE_PROPERTY").map(
				(finding) => finding.details?.reason,
			),
		).toEqual(["own-case"]);
	});

	it("counts the own case's save through `via` on the case it reaches", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own({
					writes: [
						{
							property: "age",
							value: read("age"),
							via: [{ identifier: "host", throughCaseType: "household" }],
						},
					],
				}),
				update("again", {
					writes: [{ property: "age", value: read("age") }],
				}),
			],
		});
		expect(findings(doc, "CASE_WRITE_DUPLICATE_PROPERTY")).toEqual([]);
	});

	it("refuses another change closing the own case", () => {
		const close = (): CaseOperation =>
			({
				uuid: OP("shut"),
				id: "shut",
				action: "close",
				caseType: "patient",
				target: { kind: "session" },
			}) as CaseOperation;
		const followup = placementFixture("followup", {
			operations: () => [own(), close()],
		});
		expect(
			findings(followup.doc, "CASE_OPERATION_CLOSES_OWN_CASE")[0]?.message,
		).toBe(
			"“shut” closes this form's own case. You can make “Under test” a close form, which closes it, and remove this change.",
		);
		const closeForm = placementFixture("close", {
			operations: () => [own(), close()],
		});
		expect(
			findings(closeForm.doc, "CASE_OPERATION_CLOSES_OWN_CASE")[0]?.message,
		).toBe(
			"“Under test” already closes its own case. You can remove “shut”, or set when it closes in the form's settings.",
		);
	});

	it("refuses a retype of the own case only where the own case saves", () => {
		const retype = update("retype", { retype: "kid" });
		const writing = placementFixture("followup", {
			operations: () => [
				own({ writes: [{ property: "age", value: read("age") }] }),
				retype,
			],
		});
		const [mismatch] = findings(
			writing.doc,
			"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		);
		expect(mismatch?.message).toMatch(/^This form's own case is kid /);
		expect(mismatch?.details?.subject).toBe("own-case");

		const closingOnly = placementFixture("followup", {
			operations: () => [own(), retype],
		});
		expect(
			findings(closingOnly.doc, "CASE_OPERATION_TARGET_TYPE_MISMATCH"),
		).toEqual([]);
	});
});

describe("the builder's sentences", () => {
	it("names the form and the change as the builder does", () => {
		const missing = placementFixture("close", { operations: () => [] });
		expect(
			userFacingError(findings(missing.doc, "CASE_OWN_OPERATION")[0]),
		).toBe(
			'"Under test" is a close form, so it needs a change for its own case, and it has none. Setting the form\'s type again adds it.',
		);
		const duplicate = placementFixture("followup", {
			operations: () => [
				own({ writes: [{ property: "age", value: read("age") }] }),
				update("again", {
					writes: [{ property: "age", value: read("age") }],
				}),
			],
		});
		expect(
			userFacingError(
				findings(duplicate.doc, "CASE_WRITE_DUPLICATE_PROPERTY")[0],
			),
		).toBe(
			"\"again\" saves age to this form's case, which this form's own change already saves. You can save it in one of the two.",
		);
		const closing = placementFixture("close", {
			operations: () => [own(), update("shut", { action: "close" })],
		});
		expect(
			userFacingError(
				findings(closing.doc, "CASE_OPERATION_CLOSES_OWN_CASE")[0],
			),
		).toBe(
			'"Under test" already closes its own case. You can remove "shut", or set when it closes in the form\'s settings.',
		);
	});
});
