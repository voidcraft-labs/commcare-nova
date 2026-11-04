/**
 * Identity moves of held case changes, through the real commit gate. The
 * plausible failures: an edit that changes where a published app keeps a
 * change commits with no statement (the planner misses it), a stated move
 * the gate still refuses (the planner records a place that does not
 * express the change, or two moved changes claim one place), a statement
 * with the wrong places or reason, and an undo the commit kernel would
 * refuse, so a person can never take a move back.
 */
import { describe, expect, it } from "vitest";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { identityMovesBetween } from "@/lib/doc/identityMoves";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	admittedHoldChanges,
	NO_RECORDED_HOLDS,
	type PlacementHold,
	placementTargetKey,
	readPlacementHolds,
} from "@/lib/doc/placementHolds";
import { planOperationPlacementMoves } from "@/lib/doc/placementMoves";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	CasePlacement,
	Uuid,
} from "@/lib/domain";
import { concat, eq, literal, term } from "@/lib/domain/expression/builders";
import {
	DISCHARGE,
	FOLLOWUP,
	holdPlanned,
	holds,
	isCreate,
	isOwn,
	moveFixture,
	operationOf,
	PATIENTS,
	REGISTRATION,
	read,
	refusalCodes,
	U,
	verdict,
	withSecondKid,
} from "./placementMoveFixture";

/** The fixture with every placement the planner gives held, as a publish
 *  records them. */
function published(): BlueprintDoc {
	const doc = withSecondKid(moveFixture());
	for (const form of [REGISTRATION, FOLLOWUP, DISCHARGE])
		holdPlanned(doc, form);
	return doc;
}

const own = (doc: BlueprintDoc, formUuid: Uuid) =>
	operationOf(doc, formUuid, isOwn);
const kids = (doc: BlueprintDoc) =>
	(doc.forms[REGISTRATION].caseOperations ?? []).filter(isCreate);

function candidateOf(doc: BlueprintDoc, edit: readonly Mutation[]) {
	return prepareMutationCandidate(doc, admitMutationBatch(edit)).nextDoc;
}

/** The edit with the planner's entries appended, as `withIdentityMoves`
 *  appends them. */
function planned(doc: BlueprintDoc, edit: readonly Mutation[]) {
	const plan = planOperationPlacementMoves(candidateOf(doc, edit));
	return {
		plan,
		batch:
			plan.holds.length === 0 ? [...edit] : [...edit, holds(...plan.holds)],
	};
}

function updateOwnWrite(
	doc: BlueprintDoc,
	formUuid: Uuid,
	property: string,
	patch: Record<string, unknown>,
): Mutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		caseOperationPatch: {
			operation: "update-write",
			uuid: own(doc, formUuid).uuid,
			key: { property },
			patch,
		},
	} as Mutation;
}

function patchCreate(uuid: Uuid, patch: Record<string, unknown>): Mutation {
	return {
		kind: "updateForm",
		uuid: REGISTRATION,
		patch: {},
		caseOperationPatch: {
			operation: "update",
			uuid,
			targetAction: "create",
			patch,
		},
	} as Mutation;
}

const removeOperation = (formUuid: Uuid, uuid: Uuid): Mutation => ({
	kind: "updateForm",
	uuid: formUuid,
	patch: {},
	caseOperationChange: { operation: "remove", uuid },
});

const OWN_SLOT: CasePlacement = { kind: "basic", slot: "own" };

interface MoveRow {
	readonly name: string;
	readonly edit: (doc: BlueprintDoc) => Mutation[];
	/** The moved subjects, each `[subject, from, to, reason]`. */
	readonly moves: (doc: BlueprintDoc) => readonly unknown[];
}

const caseMove = (
	formUuid: Uuid,
	operationUuid: Uuid,
	from: string,
	to: string,
	reason: Record<string, unknown>,
) => ({
	subject: { kind: "case-operation", formUuid, operationUuid },
	from,
	to,
	reason: { source: "case-placement", reason },
});

const ROWS: readonly MoveRow[] = [
	{
		name: "a write's value stops being a bare question read",
		edit: (doc) => [
			updateOwnWrite(doc, FOLLOWUP, "remark", {
				value: concat(read("remark"), term(literal("!"))),
			}),
		],
		moves: (doc) => [
			caseMove(
				FOLLOWUP,
				own(doc, FOLLOWUP).uuid,
				"case-management",
				"save-to-case",
				{ reason: "value-computed" },
			),
		],
	},
	{
		name: "a write gains a condition",
		edit: (doc) => [
			updateOwnWrite(doc, FOLLOWUP, "remark", {
				condition: eq(read("remark"), term(literal("yes"))),
			}),
		],
		moves: (doc) => [
			caseMove(
				FOLLOWUP,
				own(doc, FOLLOWUP).uuid,
				"case-management",
				"save-to-case",
				{ reason: "write-condition" },
			),
		],
	},
	{
		name: "the form's menu comes to select several cases",
		// The rest of the batch is what several cases need anywhere: Web Apps
		// alone, and no answer that starts on the chosen case's value.
		edit: () => [
			{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
			...(
				[
					["age", "int"],
					["status", "single_select"],
					["remark", "text"],
				] as const
			).map(
				([id, targetKind]) =>
					({
						kind: "updateField",
						uuid: U(id),
						targetKind,
						patch: { default_value: null },
					}) as Mutation,
			),
			{
				kind: "setCaseListMeta",
				uuid: PATIENTS,
				patch: { selection: { kind: "multiple", maximum: 5 } },
			} as Mutation,
		],
		// Every case form of the menu: the own cases leave Case Management,
		// and the close's own block gains the selected cases around it.
		moves: (doc) => [
			caseMove(
				FOLLOWUP,
				own(doc, FOLLOWUP).uuid,
				"case-management",
				"save-to-case",
				{ reason: "several-cases" },
			),
			caseMove(
				DISCHARGE,
				own(doc, DISCHARGE).uuid,
				"case-management",
				"save-to-case",
				{ reason: "several-cases" },
			),
			{
				subject: { kind: "own-close", formUuid: DISCHARGE },
				from: "save-to-case",
				to: "save-to-case",
				reason: {
					source: "case-placement",
					reason: { reason: "block-shape" },
				},
			},
		],
	},
	{
		name: "a new case's condition reads a question Case Management can't state, and the next new case is renumbered",
		edit: (doc) => [
			patchCreate(kids(doc)[0].uuid, {
				condition: eq(read("nickname"), term(literal("yes"))),
			}),
		],
		moves: (doc) => [
			caseMove(
				REGISTRATION,
				kids(doc)[0].uuid,
				"case-management",
				"save-to-case",
				{ reason: "condition-question-kind", condition: "operation" },
			),
			caseMove(
				REGISTRATION,
				kids(doc)[1].uuid,
				"case-management",
				"case-management",
				{ reason: "subcase-index" },
			),
		],
	},
];

describe("planOperationPlacementMoves", () => {
	it("starts from a published document the gate admits", () => {
		const doc = published();
		expect(refusalCodes(doc, [])).toEqual([]);
		expect(readPlacementHolds(doc).size).toBe(6);
	});

	for (const row of ROWS) {
		it(`moves and states a held change when ${row.name}`, () => {
			const doc = published();
			const edit = row.edit(doc);
			expect(refusalCodes(doc, edit)).toContain("HELD_PLACEMENT_INEXPRESSIBLE");
			const { plan, batch } = planned(doc, edit);
			expect(plan.moves).toEqual(row.moves(doc));
			const result = verdict(doc, batch);
			expect(result.ok ? [] : result.findings.map((f) => f.message)).toEqual(
				[],
			);
			// Each stated place is the one now held, and holding it moves nothing
			// further.
			if (!result.ok) return;
			expect(planOperationPlacementMoves(result.nextDoc).holds).toEqual([]);
			expect(identityMovesBetween(doc, result.nextDoc)).toEqual(plan.moves);
		});
	}

	it("clears the own close's hold and states nothing when the form stops closing its case", () => {
		const doc = published();
		// The form becomes a follow-up, which closes no case.
		const edit: Mutation[] = [
			{
				kind: "updateForm",
				uuid: DISCHARGE,
				patch: { type: "followup", closeCondition: null },
			} as Mutation,
		];
		expect(refusalCodes(doc, edit)).toContain("HELD_PLACEMENT_INEXPRESSIBLE");
		const { plan, batch } = planned(doc, edit);
		expect(plan).toEqual({
			holds: [{ target: "own-close", formUuid: DISCHARGE, placement: null }],
			moves: [],
		});
		const result = verdict(doc, batch);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(identityMovesBetween(doc, result.nextDoc)).toEqual([]);
	});

	it("renumbers the later new case when an earlier one is removed, and states no move for the removal", () => {
		const doc = published();
		const [first, second] = kids(doc);
		const edit = [removeOperation(REGISTRATION, first.uuid)];
		expect(refusalCodes(doc, edit)).toContain("HELD_PLACEMENT_INEXPRESSIBLE");
		const { plan, batch } = planned(doc, edit);
		expect(plan.holds).toEqual([
			{
				target: "case-operation",
				formUuid: REGISTRATION,
				operationUuid: second.uuid,
				placement: { kind: "basic", slot: "subcase", index: 0 },
			},
		]);
		expect(plan.moves).toEqual([
			caseMove(
				REGISTRATION,
				second.uuid,
				"case-management",
				"case-management",
				{ reason: "subcase-index" },
			),
		]);
		expect(verdict(doc, batch).ok).toBe(true);
	});

	it("plans nothing for removing a held change whose removal strands no other", () => {
		const doc = published();
		const [, second] = kids(doc);
		const edit = [removeOperation(REGISTRATION, second.uuid)];
		expect(planned(doc, edit).plan).toEqual({ holds: [], moves: [] });
		const result = verdict(doc, edit);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(identityMovesBetween(doc, result.nextDoc)).toEqual([]);
	});

	it("plans nothing for a form that holds no placement", () => {
		const doc = withSecondKid(moveFixture());
		const edit = [
			updateOwnWrite(doc, FOLLOWUP, "remark", {
				value: concat(read("remark"), term(literal("!"))),
			}),
		];
		expect(planned(doc, edit).plan).toEqual({ holds: [], moves: [] });
		expect(refusalCodes(doc, edit)).toEqual([]);
	});
});

describe("undo and redo of a move", () => {
	const recordedOf = (doc: BlueprintDoc): Map<string, PlacementHold> =>
		new Map(readPlacementHolds(doc));
	const holdEntries = (batch: readonly Mutation[]): PlacementHoldEntry[] =>
		batch.flatMap((m) => (m.kind === "holdPlacements" ? m.holds : []));

	it("restores the latest recorded hold with the content, and the restore is admitted and states no move", () => {
		const doc = published();
		const recorded = recordedOf(doc);
		const ownUuid = own(doc, FOLLOWUP).uuid;
		const edit = [
			updateOwnWrite(doc, FOLLOWUP, "remark", {
				value: concat(read("remark"), term(literal("!"))),
			}),
		];
		const moved = verdict(doc, planned(doc, edit).batch);
		if (!moved.ok) throw new Error("The move commits.");
		// The inverse the history records: the content back, and the hold
		// back where the latest recording put it.
		const inverse = admitMutationBatch([
			updateOwnWrite(moved.nextDoc, FOLLOWUP, "remark", {
				value: read("remark"),
			}),
			holds({
				target: "case-operation",
				formUuid: FOLLOWUP,
				operationUuid: ownUuid,
				placement: OWN_SLOT,
			}),
		]);
		const kept = admittedHoldChanges(moved.nextDoc, inverse, recorded);
		expect(holdEntries(kept)).toEqual(holdEntries(inverse));
		const undone = verdict(moved.nextDoc, kept);
		if (!undone.ok) throw new Error("The undo commits.");
		expect(own(undone.nextDoc, FOLLOWUP).placement).toEqual(OWN_SLOT);
		expect(
			identityMovesBetween(moved.nextDoc, undone.nextDoc, { recorded }),
		).toEqual([]);
		// The redo makes the restored hold inexpressible again, so the kernel
		// admits it as a move, and it is stated as one.
		const redo = admitMutationBatch(planned(doc, edit).batch);
		expect(
			holdEntries(admittedHoldChanges(undone.nextDoc, redo, recorded)),
		).toEqual(holdEntries(redo));
		const redone = verdict(undone.nextDoc, redo);
		if (!redone.ok) throw new Error("The redo commits.");
		expect(
			identityMovesBetween(undone.nextDoc, redone.nextDoc, { recorded }),
		).toEqual([
			caseMove(FOLLOWUP, ownUuid, "case-management", "save-to-case", {
				reason: "value-computed",
			}),
		]);
	});

	it("re-creates a removed held change with its recorded hold", () => {
		const doc = published();
		const recorded = recordedOf(doc);
		const [, second] = kids(doc);
		const removed = verdict(doc, [removeOperation(REGISTRATION, second.uuid)]);
		if (!removed.ok) throw new Error("The removal commits.");
		const { placement, ...unheld } = second as CaseOperation & {
			placement?: CasePlacement;
		};
		if (placement === undefined) throw new Error("The change was held.");
		const inverse = admitMutationBatch([
			{
				kind: "updateForm",
				uuid: REGISTRATION,
				patch: {},
				caseOperationChange: { operation: "add", value: unheld },
			} as Mutation,
			holds({
				target: "case-operation",
				formUuid: REGISTRATION,
				operationUuid: second.uuid,
				placement,
			}),
		]);
		const kept = admittedHoldChanges(removed.nextDoc, inverse, recorded);
		expect(holdEntries(kept)).toEqual(holdEntries(inverse));
		const undone = verdict(removed.nextDoc, kept);
		if (!undone.ok) throw new Error("The undo commits.");
		expect(kids(undone.nextDoc)[1]).toEqual(second);
		// With no recording of the hold, the kernel would refuse it, and the
		// change comes back unheld.
		expect(
			holdEntries(
				admittedHoldChanges(removed.nextDoc, inverse, NO_RECORDED_HOLDS),
			),
		).toEqual([]);
		expect(recorded.has(placementTargetKey(holdEntries(inverse)[0]))).toBe(
			true,
		);
	});
});
