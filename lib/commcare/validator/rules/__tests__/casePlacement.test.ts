/**
 * Held placements at the commit gate. A published app keeps each held case
 * change where its hold says, so a document that would move one without the
 * move being stated (`HELD_PLACEMENT_INEXPRESSIBLE`), keep two changes in
 * one place (`CASE_PLACEMENT_SHARED`), write an authored node under a
 * held block's name (`HELD_BLOCK_PATH_TAKEN`), keep a held change in a form
 * of the other menu kind (`CASE_PLACEMENT_KIND`), or keep a menu as an
 * advanced menu something now keeps from being one is refused. A failure here is
 * a publish that would silently move data a project space already holds.
 */
import { describe, expect, it } from "vitest";
import {
	advancedFixture,
	HOUSEHOLDS,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import {
	childCreate,
	OP,
	own,
	placementFixture,
	read,
	U,
} from "@/lib/commcare/__tests__/placementFixture";
import { planPlacements } from "@/lib/commcare/placement";
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

	// Part 02's G3 (N1): HQ's build appends a held slot's element by name
	// beside a question of that name, and the plan never moves a held one.
	it("refuses a question named like the element HQ appends for a held subcase, offering a free name", () => {
		const { doc } = placementFixture("followup", {
			extraRoot: [{ kind: "text", id: "subcase_0" }],
			operations: (t) => [
				own(),
				childCreate("kid", t, {
					placement: { kind: "basic", slot: "subcase", index: 0 },
				}),
			],
		});
		const [finding, ...more] = findings(doc, "HELD_BLOCK_PATH_TAKEN");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"The name “subcase_0” is where your published app keeps the case change “kid” in CommCare HQ. You can name it “subcase_0_2”.",
		);
		expect(finding?.location.fieldId).toBe("subcase_0");
		expect(finding?.details?.takenBy).toBe("question");
		expect(finding && userFacingError(finding)).toBe(finding?.message);
		// Only a rename resolves it: the hold still expresses its change, so
		// no move is offered.
		expect(findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE")).toEqual([]);
	});

	it("refuses a question named like the element HQ appends for the held worker's update", () => {
		const { doc } = placementFixture("followup", {
			extraRoot: [{ kind: "text", id: "commcare_usercase" }],
			operations: () => [
				own(),
				{
					uuid: OP("w"),
					id: "worker",
					action: "update",
					caseType: "commcare-user",
					target: { kind: "worker-record" },
					writes: [{ property: "age", value: read("age") }],
					placement: { kind: "basic", slot: "usercase" },
				} as CaseOperation,
			],
		});
		const [finding, ...more] = findings(doc, "HELD_BLOCK_PATH_TAKEN");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"The name “commcare_usercase” is where your published app keeps the case change “worker” in CommCare HQ. You can name it “commcare_usercase_2”.",
		);
	});

	it("admits a question named like an unheld slot's element, which then takes Save to Case", () => {
		const { doc } = placementFixture("followup", {
			extraRoot: [{ kind: "text", id: "subcase_0" }],
			operations: (t) => [own(), childCreate("kid", t)],
		});
		expect(findings(doc, "HELD_BLOCK_PATH_TAKEN")).toEqual([]);
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

/** The form's own case in the advanced fixture, holding `placement`. */
const advancedOwn = (placement?: CasePlacement): CaseOperation =>
	({
		uuid: OP("own"),
		id: "own_case",
		action: "own",
		...(placement !== undefined && { placement }),
	}) as CaseOperation;

/** Where the advanced fixture's form keeps its own case as an advanced
 *  form: its load, by the tag the plan gives it. */
function ownLoad(): CasePlacement {
	const { doc, formUuid } = advancedFixture({
		formType: "followup",
		operations: () => [advancedOwn()],
	});
	const placement = planPlacements(doc, formUuid).placements.get(
		OP("own"),
	)?.placement;
	if (placement?.kind !== "advanced")
		throw new Error("The advanced form keeps its own case in no load.");
	return placement;
}

describe("HELD_BLOCK_PATH_TAKEN for a held case action", () => {
	it("refuses a root question named like the held load's case_<tag>", () => {
		const load = ownLoad();
		if (load.kind !== "advanced") throw new Error("No load.");
		const { doc, formUuid } = advancedFixture({
			formType: "followup",
			operations: () => [advancedOwn(load)],
		});
		const [first] = doc.fieldOrder[formUuid] ?? [];
		const question = first === undefined ? undefined : doc.fields[first];
		if (question === undefined) throw new Error("The form holds no question.");
		const name = `case_${load.tag}`;
		doc.fields[question.uuid] = { ...question, id: name } as typeof question;
		const [finding, ...more] = findings(doc, "HELD_BLOCK_PATH_TAKEN");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			`The name “${name}” is where your published app keeps “this form's case” in CommCare HQ. You can name it “${name}_2”.`,
		);
		expect(findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE")).toEqual([]);
	});
});

describe("CASE_PLACEMENT_KIND", () => {
	it("refuses a held case action in a form of an ordinary menu", () => {
		const load = ownLoad();
		const { doc } = advancedFixture({
			formType: "followup",
			heldKind: false,
			operations: () => [advancedOwn(load)],
		});
		const [finding, ...more] = findings(doc, "CASE_PLACEMENT_KIND");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"CommCare HQ keeps “this form's case” in case actions, which a form in an ordinary menu can't use. Make the change again to see where it moves and confirm it.",
		);
		expect(finding?.details?.moduleKind).toBe("basic");
		expect(JSON.parse(finding?.details?.held ?? "")).toEqual(load);
		expect(finding && userFacingError(finding)).toBe(finding?.message);
		// The kind rule names the move; the inexpressibility rule does not
		// say it again.
		expect(findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE")).toEqual([]);

		const twin = advancedFixture({
			formType: "followup",
			operations: () => [advancedOwn(load)],
		}).doc;
		expect(findings(twin, "CASE_PLACEMENT_KIND")).toEqual([]);
	});

	it("refuses a held Case Management slot in a form of an advanced menu", () => {
		const slot: CasePlacement = { kind: "basic", slot: "own" };
		const { doc } = advancedFixture({
			formType: "followup",
			operations: () => [advancedOwn(slot)],
		});
		const [finding, ...more] = findings(doc, "CASE_PLACEMENT_KIND");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"CommCare HQ keeps “this form's case” in Case Management, which a form in an advanced menu can't use. Make the change again to see where it moves and confirm it.",
		);
		expect(finding?.details?.moduleKind).toBe("advanced");
		expect(finding && userFacingError(finding)).toBe(finding?.message);
		expect(findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE")).toEqual([]);

		const twin = advancedFixture({
			formType: "followup",
			heldKind: false,
			operations: () => [advancedOwn(slot)],
		}).doc;
		expect(findings(twin, "CASE_PLACEMENT_KIND")).toEqual([]);
	});
});

describe("HELD_PLACEMENT_INEXPRESSIBLE for a menu's held kind", () => {
	const searchFirst = (doc: BlueprintDoc) => {
		doc.modules[HOUSEHOLDS] = {
			...doc.modules[HOUSEHOLDS],
			caseSearchConfig: { searchFirst: true },
		};
	};

	it("refuses a held advanced menu a blocker keeps from being one", () => {
		const { doc } = advancedFixture({
			formType: "followup",
			operations: () => [advancedOwn()],
			configure: searchFirst,
		});
		const [finding, ...more] = findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE");
		expect(more).toEqual([]);
		expect(finding?.message).toBe(
			"CommCare HQ keeps the menu “Households” as an advanced menu where your last publish put it, and this change can't keep it there. It now opens on its Search screen with its forms reading the search, which an advanced menu can't do. Make the change again to see where it moves and confirm it.",
		);
		expect(finding?.location).toEqual({
			moduleUuid: HOUSEHOLDS,
			moduleName: "Households",
		});
		expect(JSON.parse(finding?.details?.subject ?? "")).toEqual({
			kind: "module-kind",
			moduleUuid: HOUSEHOLDS,
		});
		expect(JSON.parse(finding?.details?.reasons ?? "")).toEqual([
			"forms-read-search",
		]);
		expect(finding && userFacingError(finding)).toBe(finding?.message);
	});

	it("admits a held advanced menu nothing keeps from being one", () => {
		const { doc } = advancedFixture({
			formType: "followup",
			operations: () => [advancedOwn()],
		});
		expect(findings(doc, "HELD_PLACEMENT_INEXPRESSIBLE")).toEqual([]);
	});
});
