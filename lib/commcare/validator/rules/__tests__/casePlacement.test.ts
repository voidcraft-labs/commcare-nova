/**
 * Held placements at the commit gate. A published app keeps each held case
 * change where its hold says, so a document that would move one without the
 * move being stated (`HELD_PLACEMENT_INEXPRESSIBLE`), keep two changes in
 * one place (`CASE_PLACEMENT_SHARED`), or write an authored node under a
 * held block's name (`HELD_BLOCK_PATH_TAKEN`) is refused. A failure here is
 * a publish that would silently move data a project space already holds.
 */
import { describe, expect, it } from "vitest";
import {
	childCreate,
	OP,
	own,
	placementFixture,
	read,
	U,
} from "@/lib/commcare/__tests__/placementFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type {
	BlueprintDoc,
	CaseOperation,
	CasePlacement,
	Uuid,
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

const at = (path: [string, ...string[]], repeat?: Uuid): CasePlacement => ({
	kind: "save-to-case",
	...(repeat !== undefined && { repeat }),
	path,
});

function update(key: string, extra: Partial<CaseOperation> = {}) {
	return {
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "status", value: read("status") }],
		...extra,
	} as CaseOperation;
}

describe("HELD_PLACEMENT_INEXPRESSIBLE", () => {
	it("refuses a held own slot a calculated value strands", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own({
					placement: { kind: "basic", slot: "own" },
					writes: [
						{
							property: "age",
							value: concat(read("age"), term(literal("!"))),
						},
					],
				}),
			],
		});
		const [finding, ...more] = findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"CommCare HQ keeps “this form's case” where your last publish put it, and this change can't keep it there. One of its values is now a calculation, which Case Management can't save. Make the change again to see where it moves and confirm it.",
		);
		expect(finding?.details?.reason).toBe("value-computed");
		expect(JSON.parse(finding?.details?.reasons ?? "")).toEqual([
			{ reason: "value-computed" },
		]);
		expect(finding && userFacingError(finding)).toBe(finding?.message);
	});

	it("refuses a held own close on a form that no longer closes its case", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [own()],
			form: {
				ownClosePlacement: {
					kind: "save-to-case",
					path: ["nova_operations", "nova_close"],
				},
			},
		});
		const [finding] = findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE");
		expect(finding?.message).toBe(
			"CommCare HQ keeps “closing this form's case” where your last publish put it, and this change can't keep it there. This form no longer closes its case. Make the change again to see where it moves and confirm it.",
		);
		expect(JSON.parse(finding?.details?.subject ?? "")).toEqual({
			kind: "own-close",
		});
	});

	it("refuses a held block of a case change that now runs in another repeat", () => {
		const held = at(["nova_operations", "upd"], U("kids"));
		const { doc } = placementFixture("followup", {
			operations: () => [own(), update("upd", { placement: held })],
		});
		const [finding] = findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE");
		expect(finding?.message).toBe(
			"CommCare HQ keeps the case change “upd” where your last publish put it, and this change can't keep it there. It now runs in another repeat. Make the change again to see where it moves and confirm it.",
		);
		expect(finding?.details?.operationUuid).toBe(OP("upd"));
		expect(JSON.parse(finding?.details?.held ?? "")).toEqual(held);
		expect(finding && userFacingError(finding)).toBe(finding?.message);
	});

	it("admits a hold that still expresses its subject", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own(),
				update("upd", { placement: at(["nova_operations", "upd"]) }),
			],
		});
		expect(findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE")).toEqual([]);
	});
});

describe("CASE_PLACEMENT_SHARED", () => {
	it("refuses two case changes held in one place", () => {
		const held = at(["nova_operations", "published"]);
		const { doc } = placementFixture("followup", {
			operations: () => [
				own(),
				update("first", { placement: held }),
				update("second", { placement: held }),
			],
		});
		const [finding, ...more] = findings(doc, "CASE_PLACEMENT_SHARED");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"Two case changes in “Under test” are kept in the same place in CommCare HQ: the case change “first” and the case change “second”. Removing one of them and adding it again gives it a place of its own.",
		);
		expect(finding?.details?.operationUuid).toBe(OP("second"));
		expect(finding && userFacingError(finding)).toBe(finding?.message);
	});

	it("admits a close holding the subcase place of the create it closes", () => {
		const subcase: CasePlacement = { kind: "basic", slot: "subcase", index: 0 };
		const { doc } = placementFixture("followup", {
			operations: (t) => [
				own(),
				childCreate("kid", t, { placement: subcase }),
				{
					uuid: OP("shut"),
					id: "shut",
					action: "close",
					caseType: "kid",
					target: { kind: "op", opUuid: OP("kid") },
					condition: read("flag"),
					placement: subcase,
				} as CaseOperation,
			],
		});
		expect(findings(doc, "CASE_PLACEMENT_SHARED")).toEqual([]);
		expect(findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE")).toEqual([]);
	});
});

describe("HELD_BLOCK_PATH_TAKEN", () => {
	it("refuses a question named like a held block's group, offering a free name", () => {
		const { doc } = placementFixture("followup", {
			extraRoot: [{ kind: "text", id: "nova_operations" }],
			operations: () => [
				own(),
				update("upd", { placement: at(["nova_operations", "upd"]) }),
			],
		});
		const [finding, ...more] = findings(doc, "HELD_BLOCK_PATH_TAKEN");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"The name “nova_operations” is where your published app keeps the case change “upd” in CommCare HQ. You can name it “nova_operations_2”.",
		);
		expect(finding?.location.fieldId).toBe("nova_operations");
		expect(finding?.details?.suggestion).toBe("nova_operations_2");
		expect(finding && userFacingError(finding)).toBe(finding?.message);
	});

	it("refuses a Connect block named like a held block's group", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own(),
				update("upd", { placement: at(["nova_operations", "upd"]) }),
			],
		});
		doc.connectType = "deliver";
		doc.appSettings = { ...doc.appSettings, runsOnlyOn: "android" };
		doc.forms[formUuid].connect = {
			deliver_unit: {
				id: "nova_operations",
				name: "Visit",
				entity_id: term(literal("x")),
				entity_name: term(literal("x")),
			},
		} as BlueprintDoc["forms"][Uuid]["connect"];
		const [finding] = findings(doc, "HELD_BLOCK_PATH_TAKEN");
		expect(finding?.details?.takenBy).toBe("connect");
		expect(finding?.message).toBe(
			"The name “nova_operations” is where your published app keeps the case change “upd” in CommCare HQ. You can name it “nova_operations_2”.",
		);
	});

	it("refuses a case change named like another change's held block", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own(),
				update("upd", { placement: at(["nova_operations", "published"]) }),
				update("published"),
			],
		});
		const [finding, ...more] = findings(doc, "HELD_BLOCK_PATH_TAKEN");
		expect(more).toEqual([]);
		expect(finding?.details?.operationUuid).toBe(OP("published"));
		expect(finding?.message).toBe(
			"The name “published” is where your published app keeps the case change “upd” in CommCare HQ. You can name it “published_2”.",
		);
	});

	it("admits a held block named by its own case change", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own(),
				update("upd", { placement: at(["nova_operations", "upd"]) }),
			],
		});
		expect(findings(doc, "HELD_BLOCK_PATH_TAKEN")).toEqual([]);
	});
});
