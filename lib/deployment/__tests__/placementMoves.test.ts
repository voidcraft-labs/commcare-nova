/**
 * What a publish records and what it offers to move, over documents the
 * placement planner places (`placementFixture`: a Patients menu whose form
 * under test holds the case operations each case writes).
 *
 * The plausible failures: a publish that records a hold the document
 * already has, or misses one it derives, so a later publish moves a path HQ
 * already holds; an offer that moves some Save to Case blocks and not
 * others, which changes submission paths and still needs Save to Case; an
 * offer that moves a change the document does not hold, which takes the
 * simplest place already; an offer that leaves a new case of the menu's own
 * type in a basic subcase, which a project space dropping such links would
 * refuse next; a same-type offer that leaves such a case in a basic subcase,
 * or misses the later subcase its move renumbers; and a digest that a
 * person's unrelated edit invalidates, or that a different set of moves
 * keeps.
 */

import { describe, expect, it } from "vitest";
import {
	advancedFixture,
	HOUSEHOLDS,
	UNDER_TEST,
	VISIT_REVIEW,
	VISITS,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import {
	childCreate,
	OP,
	OWN,
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { placementCandidates, planPlacements } from "@/lib/commcare/placement";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import { sameTypeBasicChildCases } from "@/lib/commcare/sameTypeChildCases";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type {
	BlueprintDoc,
	CaseOperation,
	CasePlacement,
	Form,
	Uuid,
} from "@/lib/domain";
import { saveToCaseOfferBody } from "@/lib/publish/placementMoves";
import {
	describeCaseChange,
	placementMoveOffer,
	placementMoveOfferView,
} from "../placementMoves";

const OWN_SLOT: CasePlacement = { kind: "basic", slot: "own" };
const SUBCASE_0: CasePlacement = { kind: "basic", slot: "subcase", index: 0 };
const SUBCASE_1: CasePlacement = { kind: "basic", slot: "subcase", index: 1 };
const USERCASE: CasePlacement = { kind: "basic", slot: "usercase" };

const workerUpdate = (key: string, extra: Partial<CaseOperation> = {}) =>
	({
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "commcare-user",
		target: { kind: "worker-record" },
		writes: [{ property: "age", value: read("age") }],
		...extra,
	}) as CaseOperation;

/** The Save to Case block the planner offers `operationUuid` of the form. */
function saveToCaseOf(
	formType: Form["type"],
	operations: (t: Form["type"]) => CaseOperation[],
	operationUuid: Uuid,
): CasePlacement {
	const { doc, formUuid } = placementFixture(formType, { operations });
	const block = placementCandidates(doc, formUuid, {
		kind: "operation",
		operationUuid,
	}).find((candidate) => candidate.kind === "save-to-case");
	if (block === undefined)
		throw new Error("The planner offers every operation a Save to Case block.");
	return block;
}

const unheld = (t: Form["type"]) => [own(), childCreate("kid", t)];
const OWN_BLOCK = saveToCaseOf("followup", unheld, OWN);
const KID_BLOCK = saveToCaseOf("followup", unheld, OP("kid"));

/** The follow-up with its own case and a kid, each held at `own` and `kid`. */
function held(ownAt?: CasePlacement, kidAt?: CasePlacement) {
	return placementFixture("followup", {
		operations: (t) => [
			own(ownAt === undefined ? {} : { placement: ownAt }),
			childCreate("kid", t, kidAt === undefined ? {} : { placement: kidAt }),
		],
	});
}

/** A new patient made from the form's own patient: a case of the menu's own
 *  type, which a basic subcase links only where the project space keeps
 *  same-type links. */
const twin = (t: Form["type"], placement?: CasePlacement) =>
	({
		...childCreate("twin", t),
		caseType: "patient",
		...(placement !== undefined && { placement }),
	}) as CaseOperation;

function renamed(doc: BlueprintDoc, appName: string): BlueprintDoc {
	return { ...doc, appName };
}

describe("placementsToHold", () => {
	it("holds every placement the plan derives where nothing is held", () => {
		const { doc, formUuid } = held();
		expect(placementsToHold(doc)).toEqual([
			{
				target: "case-operation",
				formUuid,
				operationUuid: OWN,
				placement: OWN_SLOT,
			},
			{
				target: "case-operation",
				formUuid,
				operationUuid: OP("kid"),
				placement: SUBCASE_0,
			},
		]);
	});

	it("holds only what is not held yet", () => {
		const { doc, formUuid } = held(OWN_SLOT);
		expect(placementsToHold(doc)).toEqual([
			{
				target: "case-operation",
				formUuid,
				operationUuid: OP("kid"),
				placement: SUBCASE_0,
			},
		]);
	});

	it("holds nothing where everything is held", () => {
		expect(placementsToHold(held(OWN_SLOT, SUBCASE_0).doc)).toEqual([]);
	});

	it("holds a module made advanced, before its forms' case actions", () => {
		// A household registration creates a visit extending the household
		// and hands it to the visit's review: a basic form gives that visit
		// no session value, so Households is emitted advanced.
		const carried = (heldKind: boolean) =>
			advancedFixture({
				formType: "registration",
				heldKind,
				operations: () => [
					{
						uuid: OP("own"),
						id: "own_case",
						action: "own",
						name: read("name"),
					} as CaseOperation,
					{
						uuid: OP("visit"),
						id: "visit",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						name: read("name"),
						links: [
							{
								identifier: "host",
								targetType: "household",
								target: { kind: "op", opUuid: OP("own") },
								relationship: "extension",
							},
						],
					} as CaseOperation,
				],
				form: {
					formLinks: [
						{
							uuid: OP("link"),
							target: {
								type: "form",
								moduleUuid: VISITS,
								formUuid: VISIT_REVIEW,
							},
						},
					],
				},
			}).doc;
		const holds = placementsToHold(carried(false));
		expect(holds[0]).toEqual({
			target: "module-kind",
			moduleUuid: HOUSEHOLDS,
			placement: "advanced",
		});
		expect(holds.filter((hold) => hold.target === "module-kind")).toHaveLength(
			1,
		);
		expect(
			holds.flatMap((hold) =>
				hold.target === "case-operation" && hold.formUuid === UNDER_TEST
					? [[hold.operationUuid, hold.placement.kind]]
					: [],
			),
		).toEqual([
			[OP("own"), "advanced"],
			[OP("visit"), "advanced"],
		]);
		// A menu whose kind is held already holds no second kind.
		expect(
			placementsToHold(carried(true)).filter(
				(hold) => hold.target === "module-kind",
			),
		).toEqual([]);
	});
});

describe("the save-to-case offer", () => {
	it("moves every held Save to Case block to the slot the planner gives it, all at once", () => {
		const { doc, formUuid } = held(OWN_BLOCK, KID_BLOCK);
		const offer = placementMoveOffer(doc, "save-to-case");
		expect(offer).toMatchObject({
			reason: "save-to-case",
			asksChildCases: true,
			holds: [
				{
					target: "case-operation",
					formUuid,
					operationUuid: OWN,
					placement: OWN_SLOT,
				},
				{
					target: "case-operation",
					formUuid,
					operationUuid: OP("kid"),
					placement: SUBCASE_0,
				},
			],
			moves: [
				{
					form: "Under test",
					change: "saves to this form's patient case",
					sentence:
						"In Under test, the change that saves to this form's patient case moves from a Save to Case block to Case Management.",
				},
				{
					form: "Under test",
					change: "makes a new kid case",
					sentence:
						"In Under test, the change that makes a new kid case moves from a Save to Case block to Case Management.",
				},
			],
		});
		expect(offer?.digest).toMatch(/^[0-9a-f]{64}$/);
		if (offer === null) throw new Error("Expected an offer.");
		expect(placementMoveOfferView(offer)).toEqual({
			reason: offer.reason,
			digest: offer.digest,
			moves: offer.moves,
			asksChildCases: true,
		});
		expect(saveToCaseOfferBody(offer.asksChildCases)).toMatch(
			/the publish then asks whether the plan includes Child Cases/,
		);
	});

	it("asks nothing of Child Cases where no move makes a basic subcase", () => {
		const offer = placementMoveOffer(
			held(OWN_BLOCK, SUBCASE_0).doc,
			"save-to-case",
		);
		expect(offer).toMatchObject({
			asksChildCases: false,
			holds: [{ operationUuid: OWN, placement: OWN_SLOT }],
		});
	});

	it("offers nothing where no case change is in a Save to Case block", () => {
		expect(placementMoveOffer(held().doc, "save-to-case")).toBeNull();
		expect(
			placementMoveOffer(held(OWN_SLOT, SUBCASE_0).doc, "save-to-case"),
		).toBeNull();
	});

	it("offers nothing where a Save to Case block is not held, since it already takes the simplest place", () => {
		// The worker's record takes the one usercase slot, so a second write
		// to it goes to a Save to Case block unheld.
		const { doc } = placementFixture("followup", {
			operations: () => [
				own({ placement: OWN_BLOCK }),
				workerUpdate("w1"),
				workerUpdate("w2"),
			],
		});
		expect(placementMoveOffer(doc, "save-to-case")).toBeNull();
	});

	it("offers nothing where one held block cannot move, rather than moving the rest", () => {
		const operations = () => [own(), workerUpdate("w1"), workerUpdate("w2")];
		const w2Block = saveToCaseOf("followup", operations, OP("w2"));
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own({ placement: OWN_BLOCK }),
				workerUpdate("w1", { placement: USERCASE }),
				workerUpdate("w2", { placement: w2Block }),
			],
		});
		expect(planPlacements(doc, formUuid).placements.get(OP("w2"))).toEqual({
			placement: w2Block,
			held: true,
		});
		expect(placementMoveOffer(doc, "save-to-case")).toBeNull();
	});

	it("offers nothing that leaves a new case of the menu's own type in a basic subcase", () => {
		const alone = placementFixture("followup", {
			operations: () => [own({ placement: OWN_BLOCK })],
		});
		expect(placementMoveOffer(alone.doc, "save-to-case")).not.toBeNull();
		const withTwin = placementFixture("followup", {
			operations: (t) => [own({ placement: OWN_BLOCK }), twin(t, SUBCASE_0)],
		});
		expect(sameTypeBasicChildCases(withTwin.doc)).toMatchObject([
			{ operationUuid: OP("twin"), caseType: "patient" },
		]);
		expect(placementMoveOffer(withTwin.doc, "save-to-case")).toBeNull();
	});

	it("moves a block to an open action of a menu held advanced, and keeps the menu advanced", () => {
		// Households is held advanced. Its registration's visit, extending the
		// household, is held in a Save to Case block; cleared, the visit takes
		// an open action, and the menu stays advanced, so the offer moves it.
		const registration = (visitAt?: CasePlacement) =>
			advancedFixture({
				formType: "registration",
				heldKind: true,
				operations: () => [
					{
						uuid: OP("own"),
						id: "own_case",
						action: "own",
						name: read("name"),
					} as CaseOperation,
					{
						uuid: OP("visit"),
						id: "visit",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						name: read("name"),
						links: [
							{
								identifier: "host",
								targetType: "household",
								target: { kind: "op", opUuid: OP("own") },
								relationship: "extension",
							},
						],
						...(visitAt !== undefined && { placement: visitAt }),
					} as CaseOperation,
				],
			}).doc;
		const unheld = registration();
		const block = placementCandidates(unheld, UNDER_TEST, {
			kind: "operation",
			operationUuid: OP("visit"),
		}).find((candidate) => candidate.kind === "save-to-case");
		if (block === undefined)
			throw new Error(
				"The planner offers every operation a Save to Case block.",
			);
		const doc = registration(block);
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		const openAction = planPlacements(unheld, UNDER_TEST).placements.get(
			OP("visit"),
		)?.placement;
		expect(openAction?.kind).toBe("advanced");
		const offer = placementMoveOffer(doc, "save-to-case");
		expect(offer?.holds).toEqual([
			{
				target: "case-operation",
				formUuid: UNDER_TEST,
				operationUuid: OP("visit"),
				placement: openAction,
			},
		]);
	});

	it("keeps its digest under an edit that moves nothing, and changes it with what moves", () => {
		const { doc } = held(OWN_BLOCK, KID_BLOCK);
		const digest = placementMoveOffer(doc, "save-to-case")?.digest;
		expect(digest).toBeDefined();
		expect(
			placementMoveOffer(renamed(doc, "Another name"), "save-to-case")?.digest,
		).toBe(digest);
		const fewer = placementMoveOffer(
			held(OWN_BLOCK, SUBCASE_0).doc,
			"save-to-case",
		)?.digest;
		expect(fewer).toBeDefined();
		expect(fewer).not.toBe(digest);
	});
});

describe("the same-type-child-links offer", () => {
	/** The Save to Case block the planner offers the twin in `doc`. */
	function twinBlock(doc: BlueprintDoc, formUuid: Uuid): CasePlacement {
		const block = placementCandidates(doc, formUuid, {
			kind: "operation",
			operationUuid: OP("twin"),
		}).find((candidate) => candidate.kind === "save-to-case");
		if (block === undefined)
			throw new Error(
				"The planner offers every operation a Save to Case block.",
			);
		return block;
	}

	/** `doc` with the offer's holds applied through the production
	 *  admission and reducer, as a publish records them. */
	function accepted(doc: BlueprintDoc): BlueprintDoc {
		const offer = placementMoveOffer(doc, "same-type-child-links");
		if (offer === null) throw new Error("Expected an offer.");
		const candidate = prepareMutationCandidate(
			doc,
			admitMutationBatch([
				{ kind: "holdPlacements", holds: structuredClone([...offer.holds]) },
			]),
		);
		expect(candidate.identityAdmissionIssue).toBeUndefined();
		expect(candidate.targetAdmissionIssue).toBeUndefined();
		return candidate.nextDoc;
	}

	const withTwin = (
		formType: Form["type"],
		{ held, kidAt }: { held?: boolean; kidAt?: CasePlacement } = {},
	) =>
		placementFixture(formType, {
			operations: (t) => [
				own(held ? { placement: OWN_SLOT } : {}),
				twin(t, held ? SUBCASE_0 : undefined),
				...(kidAt === undefined
					? []
					: [childCreate("kid", t, { placement: kidAt })]),
			],
		});

	it.each(["followup", "registration"] as const)(
		"moves a %s's new case of its menu's own type from a basic subcase to a Save to Case block",
		(formType) => {
			const { doc, formUuid } = withTwin(formType);
			expect(sameTypeBasicChildCases(doc)).toMatchObject([
				{
					operationUuid: OP("twin"),
					ownCase: formType === "registration" ? "registers" : "works-on",
				},
			]);
			const offer = placementMoveOffer(doc, "same-type-child-links");
			expect(offer).toMatchObject({
				reason: "same-type-child-links",
				asksChildCases: false,
				holds: [
					{
						target: "case-operation",
						formUuid,
						operationUuid: OP("twin"),
						placement: twinBlock(doc, formUuid),
					},
				],
				moves: [
					{
						form: "Under test",
						change: "makes a new patient case",
						sentence:
							"In Under test, the change that makes a new patient case moves from Case Management to a Save to Case block.",
					},
				],
			});
			expect(offer?.digest).toMatch(/^[0-9a-f]{64}$/);
			expect(sameTypeBasicChildCases(accepted(doc))).toEqual([]);
		},
	);

	it("replaces a hold that still expresses its change", () => {
		const { doc, formUuid } = withTwin("followup", { held: true });
		expect(planPlacements(doc, formUuid).placements.get(OP("twin"))).toEqual({
			placement: SUBCASE_0,
			held: true,
		});
		const after = accepted(doc);
		expect(sameTypeBasicChildCases(after)).toEqual([]);
		expect(
			planPlacements(after, formUuid).placements.get(OP("twin")),
		).toMatchObject({ placement: { kind: "save-to-case" }, held: true });
	});

	it("lists the later basic subcase the move renumbers as a forced move", () => {
		const { doc, formUuid } = withTwin("followup", {
			held: true,
			kidAt: SUBCASE_1,
		});
		const offer = placementMoveOffer(doc, "same-type-child-links");
		expect(offer?.holds).toEqual([
			{
				target: "case-operation",
				formUuid,
				operationUuid: OP("twin"),
				placement: expect.objectContaining({ kind: "save-to-case" }),
			},
			{
				target: "case-operation",
				formUuid,
				operationUuid: OP("kid"),
				placement: SUBCASE_0,
			},
		]);
		expect(offer?.moves.map((move) => move.sentence)).toEqual([
			"In Under test, the change that makes a new patient case moves from Case Management to a Save to Case block.",
			"In Under test, the change that makes a new kid case stays in Case Management, in a new place.",
		]);
		expect(offer?.asksChildCases).toBe(false);
		const after = accepted(doc);
		expect(sameTypeBasicChildCases(after)).toEqual([]);
		expect(planPlacements(after, formUuid).placements.get(OP("kid"))).toEqual({
			placement: SUBCASE_0,
			held: true,
		});
	});

	it("offers nothing where no new case of a menu's own type is in a basic subcase", () => {
		expect(placementMoveOffer(held().doc, "same-type-child-links")).toBeNull();
		expect(
			placementMoveOffer(
				accepted(withTwin("followup").doc),
				"same-type-child-links",
			),
		).toBeNull();
	});

	it("keeps its digest under an edit that moves nothing, and changes it with what moves", () => {
		const { doc } = withTwin("followup", { held: true });
		const digest = placementMoveOffer(doc, "same-type-child-links")?.digest;
		expect(digest).toBeDefined();
		expect(
			placementMoveOffer(renamed(doc, "Another name"), "same-type-child-links")
				?.digest,
		).toBe(digest);
		const more = placementMoveOffer(
			withTwin("followup", { held: true, kidAt: SUBCASE_1 }).doc,
			"same-type-child-links",
		)?.digest;
		expect(more).toBeDefined();
		expect(more).not.toBe(digest);
	});
});

describe("describeCaseChange", () => {
	it("says each case change in words", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own(),
				childCreate("kid", t),
				workerUpdate("w1"),
				{
					uuid: OP("upd"),
					id: "upd",
					action: "update",
					caseType: "kid",
					target: { kind: "op", opUuid: OP("kid") },
				} as CaseOperation,
				{
					uuid: OP("shut"),
					id: "shut",
					action: "close",
					caseType: "kid",
					target: { kind: "op", opUuid: OP("kid") },
				} as CaseOperation,
			],
		});
		const said = (operationUuid: Uuid) =>
			describeCaseChange(doc, {
				target: "case-operation",
				formUuid,
				operationUuid,
			});
		expect(said(OWN)).toBe("saves to this form's patient case");
		expect(said(OP("kid"))).toBe("makes a new kid case");
		expect(said(OP("w1"))).toBe("saves to the worker's record");
		expect(said(OP("upd"))).toBe("updates the kid case");
		expect(said(OP("shut"))).toBe("closes the kid case");
		expect(describeCaseChange(doc, { target: "own-close", formUuid })).toBe(
			"closes this form's case",
		);
	});
});
