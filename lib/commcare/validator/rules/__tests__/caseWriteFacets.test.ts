/**
 * A write's `via` and `onlyIfChanged` at the commit gate, and the worker's
 * record as a target. Both facets are Case Management's update rows: only
 * the own arm of a follow-up or close form holds them, while Case
 * Management saves it. A save to the case above on a new case would be
 * built with an empty id (HQ's key reads an index the new case does not
 * have while the form is open), and a Save to Case block has neither
 * setting, so it would save every answer every time. A failure here is a
 * write the wire builds empty or writes always.
 */
import { describe, expect, it } from "vitest";
import {
	childCreate,
	OP,
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationWrite,
	placementIneligibilitySentence,
	proseText,
} from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/expression/builders";
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

const toHousehold = [
	{ identifier: "host", throughCaseType: "household" },
] as const;

/** A save of `name` to the household's `address`, through `host`. */
function viaWrite(extra: Partial<CaseOperationWrite> = {}): CaseOperationWrite {
	return {
		property: "address",
		value: read("name"),
		via: [...toHousehold],
		...extra,
	} as CaseOperationWrite;
}

/** The fixture with an `address` on the household, so a save there is a
 *  property the catalog declares. */
function fixture(...args: Parameters<typeof placementFixture>) {
	const built = placementFixture(...args);
	built.doc.caseTypes = (built.doc.caseTypes ?? []).map((caseType) =>
		caseType.name === "household"
			? {
					...caseType,
					properties: [
						...caseType.properties,
						{ name: "address", label: proseText("Address") },
					],
				}
			: caseType,
	);
	return built;
}

function sessionUpdate(
	writes: CaseOperationWrite[],
	extra: Partial<CaseOperation> = {},
): CaseOperation {
	return {
		uuid: OP("other"),
		id: "other",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes,
		...extra,
	} as CaseOperation;
}

function workerUpdate(
	key: string,
	extra: Partial<CaseOperation> = {},
): CaseOperation {
	return {
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "commcare-user",
		target: { kind: "worker-record" },
		...extra,
	} as CaseOperation;
}

describe("CASE_WRITE_VIA_INVALID", () => {
	it("admits a save to the case above from a follow-up's own case", () => {
		const { doc } = fixture("followup", {
			operations: () => [own({ writes: [viaWrite()] })],
		});
		expect(findings(doc, "CASE_WRITE_VIA_INVALID")).toEqual([]);
	});

	it("refuses it on a case the form creates", () => {
		const registration = fixture("registration", {
			operations: () => [own({ name: read("name"), writes: [viaWrite()] })],
		});
		const create = fixture("followup", {
			operations: (type) => [
				own(),
				childCreate("kid", type, { writes: [viaWrite()] }),
			],
		});
		for (const { doc } of [registration, create]) {
			const [finding] = findings(doc, "CASE_WRITE_VIA_INVALID");
			expect(finding?.details?.reason).toBe("new-case");
			expect(finding?.message).toBe(
				"address is saved to the case above a case this form creates, and that case has no link yet while the form is open. You can save it from a form that opens the existing case.",
			);
		}
	});

	it("refuses it on any change but the own case, the worker's record included", () => {
		const update = fixture("followup", {
			operations: () => [own(), sessionUpdate([viaWrite()])],
		});
		const worker = fixture("followup", {
			operations: () => [own(), workerUpdate("me", { writes: [viaWrite()] })],
		});
		for (const { doc } of [update, worker]) {
			const [finding] = findings(doc, "CASE_WRITE_VIA_INVALID");
			expect(finding?.details?.reason).toBe("target");
			expect(finding?.message).toBe(
				"Only this form's own case can save to the case above it. You can add a case change that updates that case instead.",
			);
		}
	});

	it("refuses a step that is neither a parent nor a host link", () => {
		const { doc } = fixture("followup", {
			operations: () => [
				own({
					writes: [
						viaWrite({
							via: [{ identifier: "mother", throughCaseType: "household" }],
						}),
					],
				}),
			],
		});
		const [finding] = findings(doc, "CASE_WRITE_VIA_INVALID");
		expect(finding?.details).toMatchObject({
			reason: "step",
			identifier: "mother",
		});
		expect(finding?.message).toBe(
			"CommCare HQ saves to a case above only through a parent or host link, and “mother” is neither.",
		);
	});

	it("refuses a link the catalog does not resolve", () => {
		// A patient's catalog entry names no parent type.
		const { doc } = fixture("followup", {
			operations: () => [
				own({ writes: [viaWrite({ via: [{ identifier: "parent" }] })] }),
			],
		});
		const [finding] = findings(doc, "CASE_WRITE_VIA_INVALID");
		expect(finding?.details?.reason).toBe("unresolved");
		expect(finding?.message).toBe(
			"address is saved through a link that doesn't lead to a case type. You can choose the case above it again.",
		);
	});

	it("names the first reason Case Management can't hold the own case", () => {
		const { doc } = fixture("followup", {
			operations: () => [
				own({
					writes: [
						viaWrite(),
						{
							property: "age",
							value: concat(read("age"), term(literal("x"))),
						},
					],
				}),
			],
		});
		const [finding] = findings(doc, "CASE_WRITE_VIA_INVALID");
		expect(finding?.details).toMatchObject({
			reason: "placement",
			ineligibility: "value-computed",
		});
		const sentence = `This form's case is saved through Save to Case, which saves one case per block. ${placementIneligibilitySentence("value-computed")} You can save address with a case change that updates that case instead.`;
		expect(finding?.message).toBe(sentence);
		// The builder says the same, from the finding's details.
		expect(finding && userFacingError(finding)).toBe(sentence);
	});
});

describe("CASE_WRITE_ONLY_IF_CHANGED_INVALID", () => {
	const changed = (): CaseOperationWrite => ({
		property: "age",
		value: read("age"),
		onlyIfChanged: true,
	});

	it("admits it on a follow-up's own case", () => {
		const { doc } = fixture("followup", {
			operations: () => [own({ writes: [changed()] })],
		});
		expect(findings(doc, "CASE_WRITE_ONLY_IF_CHANGED_INVALID")).toEqual([]);
	});

	it("refuses it on a case the form creates", () => {
		const { doc } = fixture("registration", {
			operations: () => [own({ name: read("name"), writes: [changed()] })],
		});
		const [finding] = findings(doc, "CASE_WRITE_ONLY_IF_CHANGED_INVALID");
		expect(finding?.details?.reason).toBe("new-case");
		expect(finding?.message).toBe(
			"age is saved to a case this form creates, so there's no earlier value to compare with. You can save it every time instead.",
		);
	});

	it("refuses it on any change but the own case", () => {
		const { doc } = fixture("followup", {
			operations: () => [own(), sessionUpdate([changed()])],
		});
		const [finding] = findings(doc, "CASE_WRITE_ONLY_IF_CHANGED_INVALID");
		expect(finding?.details?.reason).toBe("target");
		expect(finding?.message).toBe(
			"Only this form's own case can save just the answers that changed. You can save age every time instead.",
		);
	});

	it("names the first reason Case Management can't hold the own case", () => {
		const { doc } = fixture("followup", {
			severalCases: true,
			operations: () => [own({ writes: [changed()] })],
		});
		const [finding] = findings(doc, "CASE_WRITE_ONLY_IF_CHANGED_INVALID");
		expect(finding?.details).toMatchObject({
			reason: "placement",
			ineligibility: "several-cases",
		});
		expect(finding?.message).toBe(
			`This form's case is saved through Save to Case, which can't save only changed answers. ${placementIneligibilitySentence("several-cases")} You can save age every time, or change the form so Case Management can hold it.`,
		);
	});
});

describe("the worker's record as a target", () => {
	it("refuses it on an update of another case type", () => {
		const { doc } = fixture("followup", {
			operations: () => [own(), workerUpdate("me", { caseType: "patient" })],
		});
		const [finding] = findings(doc, "CASE_OPERATION_TARGET_INVALID");
		expect(finding?.details?.reason).toBe("worker-record-type");
		expect(finding?.message).toBe(
			"The worker's record is a commcare-user case, so only an update of commcare-user can save to it.",
		);
	});

	it("refuses a second update of the worker's record", () => {
		const { doc } = fixture("followup", {
			operations: () => [own(), workerUpdate("me"), workerUpdate("me_again")],
		});
		const [finding] = findings(doc, "CASE_OPERATION_TARGET_INVALID");
		expect(finding?.details).toMatchObject({
			reason: "worker-record-twice",
			operationUuid: OP("me_again"),
		});
		expect(finding?.message).toBe(
			"This form already saves to the worker's record in “me”. You can add these saves there.",
		);
	});

	it("refuses every facet but its saves", () => {
		const { doc } = fixture("followup", {
			operations: () => [
				own(),
				workerUpdate("me", {
					owner: read("name"),
					condition: read("flag"),
				}),
			],
		});
		expect(
			findings(doc, "CASE_OPERATION_TARGET_INVALID").map(
				(finding) => finding.message,
			),
		).toEqual([
			"The worker's record can only be updated, so “me” can't change its owner.",
			"The worker's record can only be updated, so “me” can't run on a condition.",
		]);
		expect(
			findings(doc, "CASE_OPERATION_TARGET_INVALID").map(userFacingError),
		).toEqual([
			"The worker's record can only be updated, so \"me\" can't change its owner.",
			"The worker's record can only be updated, so \"me\" can't run on a condition.",
		]);
	});

	it("refuses a save to a worker detail the app doesn't declare", () => {
		const { doc } = fixture("followup", {
			operations: () => [
				own(),
				workerUpdate("me", {
					writes: [{ property: "nickname", value: read("name") }],
				}),
			],
		});
		const [finding] = findings(doc, "USERCASE_WRITE_UNDECLARED_PROPERTY");
		expect(finding?.details).toMatchObject({
			property: "nickname",
			operationUuid: OP("me"),
		});
		expect(findings(doc, "CASE_OPERATION_RESERVED_CASE_TYPE")).toEqual([]);
		expect(findings(doc, "CASE_OPERATION_UNKNOWN_PROPERTY")).toEqual([]);
	});

	it("keeps refusing commcare-user everywhere else", () => {
		const { doc } = fixture("followup", {
			operations: () => [
				own(),
				sessionUpdate([], { caseType: "commcare-user" }),
			],
		});
		expect(findings(doc, "CASE_OPERATION_RESERVED_CASE_TYPE")).not.toEqual([]);
	});
});
