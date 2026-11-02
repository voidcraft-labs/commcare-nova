/**
 * The one identity-move planner every editor runs, through the real commit
 * gate. The plausible failures: a move the dialog or a tool never states, a
 * stated move the gate still refuses, a batch rewritten where nothing moves
 * (so an ordinary edit pays for or changes under the planner), a restore of
 * the published place stated as a move, and a hold change the commit
 * kernel would refuse kept in a history step.
 */
import { describe, expect, it } from "vitest";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import {
	documentHoldsIdentity,
	identityMoveReportSchema,
	identityMovesBetween,
	planConflictReplay,
	withIdentityMoves,
} from "@/lib/doc/identityMoves";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	admittedHoldChanges,
	type PlacementHold,
	placementTargetKey,
	readPlacementHolds,
} from "@/lib/doc/placementHolds";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/expression/builders";
import {
	DISCHARGE,
	FOLLOWUP,
	holdPlanned,
	holds,
	holdVisits,
	isCreate,
	isOwn,
	moveFixture,
	OPEN_PATIENTS,
	operationOf,
	PATIENTS,
	PATIENTS_NAMED,
	REGISTRATION,
	read,
	refusalCodes,
	republishedRegistration,
	U,
	verdict,
	withSecondKid,
} from "./placementMoveFixture";

const VISITS = U("visits");

function published(): BlueprintDoc {
	const doc = holdVisits(moveFixture(), "model-iteration");
	for (const form of [FOLLOWUP, DISCHARGE]) holdPlanned(doc, form);
	return doc;
}

const ownOf = (doc: BlueprintDoc, formUuid: Uuid) =>
	operationOf(doc, formUuid, isOwn).uuid;

const setRemark = (doc: BlueprintDoc, value: ReturnType<typeof read>) =>
	({
		kind: "updateForm",
		uuid: FOLLOWUP,
		patch: {},
		caseOperationPatch: {
			operation: "update-write",
			uuid: ownOf(doc, FOLLOWUP),
			key: { property: "remark" },
			patch: { value },
		},
	}) as Mutation;
const computed = concat(read("remark"), term(literal("!")));

const setQuery = (query: typeof OPEN_PATIENTS): Mutation =>
	({
		kind: "updateField",
		uuid: VISITS,
		targetKind: "repeat",
		patch: { data_source: { ids_query: query } },
	}) as Mutation;

/** Every menu selects several cases; Web Apps alone, and no answer starts
 *  on the chosen case. Strands the own close's block of the close form. */
const severalCases: Mutation[] = [
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
];

const holdEntries = (batch: readonly Mutation[]): PlacementHoldEntry[] =>
	batch.flatMap((m) => (m.kind === "holdPlacements" ? m.holds : []));

const recordedOf = (doc: BlueprintDoc): Map<string, PlacementHold> =>
	new Map(readPlacementHolds(doc));

describe("withIdentityMoves", () => {
	const stranding: readonly {
		readonly subject: string;
		readonly edit: (doc: BlueprintDoc) => Mutation[];
		readonly code: string;
		readonly moved: (doc: BlueprintDoc) => unknown;
	}[] = [
		{
			subject: "a case change",
			edit: (doc) => [setRemark(doc, computed)],
			code: "HELD_PLACEMENT_INEXPRESSIBLE",
			moved: (doc) => ({
				kind: "case-operation",
				formUuid: FOLLOWUP,
				operationUuid: ownOf(doc, FOLLOWUP),
			}),
		},
		{
			subject: "an own close",
			edit: () => severalCases,
			code: "HELD_PLACEMENT_INEXPRESSIBLE",
			moved: () => ({ kind: "own-close", formUuid: DISCHARGE }),
		},
		{
			subject: "a query repeat",
			edit: () => [setQuery(PATIENTS_NAMED)],
			code: "QUERY_REPEAT_MODEL_ITERATION_SHAPE",
			moved: () => ({
				kind: "query-repeat",
				formUuid: FOLLOWUP,
				fieldUuid: VISITS,
			}),
		},
	];

	for (const row of stranding) {
		it(`states the move of ${row.subject} and returns a batch the gate admits`, () => {
			const doc = published();
			const edit = row.edit(doc);
			expect(refusalCodes(doc, edit)).toContain(row.code);
			const plan = withIdentityMoves(doc, edit);
			expect(plan.moves.map((move) => move.subject)).toContainEqual(
				row.moved(doc),
			);
			// One appended `holdPlacements`, after the edit.
			expect(plan.batch.slice(0, edit.length)).toEqual(edit);
			expect(plan.batch.slice(edit.length).map((m) => m.kind)).toEqual([
				"holdPlacements",
			]);
			const result = verdict(doc, plan.batch);
			expect(result.ok ? [] : result.findings.map((f) => f.message)).toEqual(
				[],
			);
			// The candidate it returns is the planned batch's, ready for the
			// verdict.
			expect(plan.prepared?.mutations).toEqual(plan.batch);
			if (result.ok) expect(plan.prepared?.nextDoc).toEqual(result.nextDoc);
		});
	}

	it("plans a query repeat's move over the candidate the case changes' moves leave", () => {
		const doc = published();
		const edit = [setRemark(doc, computed), setQuery(PATIENTS_NAMED)];
		const plan = withIdentityMoves(doc, edit);
		expect(plan.moves.map((move) => move.subject.kind)).toEqual([
			"case-operation",
			"query-repeat",
		]);
		expect(holdEntries(plan.batch).map((entry) => entry.target)).toEqual([
			"case-operation",
			"query-repeat",
		]);
		expect(verdict(doc, plan.batch).ok).toBe(true);
	});

	it("returns the batch and its candidate as they are when every hold still expresses its target", () => {
		const doc = published();
		const edit: Mutation[] = [
			{
				kind: "updateField",
				uuid: U("remark"),
				targetKind: "text",
				patch: { hint: { parts: [{ kind: "text", text: "Anything else" }] } },
			} as Mutation,
		];
		const prepared = prepareMutationCandidate(doc, admitMutationBatch(edit));
		const plan = withIdentityMoves(doc, edit, { prepared });
		expect(plan.batch).toBe(edit);
		expect(plan.moves).toEqual([]);
		expect(plan.prepared).toBe(prepared);
	});

	it("returns the batch unchanged for a document that holds nothing", () => {
		const doc = moveFixture();
		expect(documentHoldsIdentity(doc)).toBe(false);
		const edit = [setRemark(doc, computed)];
		const plan = withIdentityMoves(doc, edit);
		expect(plan.batch).toBe(edit);
		expect(plan.moves).toEqual([]);
		expect(plan.prepared).toBeUndefined();
		expect(documentHoldsIdentity(published())).toBe(true);
	});

	it("states the move a redo re-applies, and none for a restore of the recorded hold", () => {
		const doc = published();
		const recorded = recordedOf(doc);
		const forward = withIdentityMoves(doc, [setQuery(PATIENTS_NAMED)]);
		const moved = verdict(doc, forward.batch);
		if (!moved.ok) throw new Error("The move commits.");
		// The undo restores the content and the recorded hold: no move.
		const undo = [setQuery(OPEN_PATIENTS), holds(...holdEntriesOf(recorded))];
		const undone = withIdentityMoves(moved.nextDoc, undo, { recorded });
		expect(undone.moves).toEqual([]);
		const after = verdict(moved.nextDoc, undone.batch);
		if (!after.ok) throw new Error("The undo commits.");
		// The redo carries its hold change itself; the planner appends nothing
		// and states the move.
		const redo = withIdentityMoves(after.nextDoc, forward.batch, { recorded });
		expect(redo.batch).toBe(forward.batch);
		expect(redo.moves).toEqual(forward.moves);
	});

	function holdEntriesOf(recorded: Map<string, PlacementHold>) {
		return [...recorded.values()].filter(
			(hold) => hold.target === "query-repeat",
		);
	}
});

describe("identityMovesBetween", () => {
	it("leaves out a move a later step took back", () => {
		const base = published();
		const first = withIdentityMoves(base, [setRemark(base, computed)]);
		const moved = verdict(base, first.batch);
		if (!moved.ok) throw new Error("The move commits.");
		// The later step restores the bare read; Save to Case still holds the
		// change, and Case Management would hold it too.
		const second = withIdentityMoves(moved.nextDoc, [
			setRemark(moved.nextDoc, read("remark")),
		]);
		expect(second.moves).toEqual([]);
		const final = verdict(moved.nextDoc, second.batch);
		if (!final.ok) throw new Error("The restore commits.");
		expect(identityMovesBetween(base, final.nextDoc)).toEqual([]);
	});

	it("states no move for a hold change back to the recorded hold, which reads as one without the recording", () => {
		// The registration's two new cases hold indices 0 and 1; removing the
		// first renumbers the second, and the undo puts both back.
		const base = holdPlanned(withSecondKid(moveFixture()), REGISTRATION);
		const recorded = recordedOf(base);
		const [first, second] = (
			base.forms[REGISTRATION].caseOperations ?? []
		).filter(isCreate);
		const removal: Mutation = {
			kind: "updateForm",
			uuid: REGISTRATION,
			patch: {},
			caseOperationChange: { operation: "remove", uuid: first.uuid },
		};
		const removed = verdict(base, withIdentityMoves(base, [removal]).batch);
		if (!removed.ok) throw new Error("The removal commits.");
		const { placement: firstHold, ...firstUnheld } = first;
		const undo: Mutation[] = [
			{
				kind: "updateForm",
				uuid: REGISTRATION,
				patch: {},
				caseOperationChange: { operation: "add", value: firstUnheld },
			} as Mutation,
			{
				kind: "updateForm",
				uuid: REGISTRATION,
				patch: {},
				caseOperationPatch: {
					operation: "move",
					uuid: first.uuid,
					after: ownOf(base, REGISTRATION),
				},
			} as Mutation,
			holds(
				{
					target: "case-operation",
					formUuid: REGISTRATION,
					operationUuid: first.uuid,
					placement: firstHold ?? null,
				},
				{
					target: "case-operation",
					formUuid: REGISTRATION,
					operationUuid: second.uuid,
					placement: second.placement ?? null,
				},
			),
		];
		const restored = verdict(removed.nextDoc, undo);
		expect(restored.ok ? [] : restored.findings.map((f) => f.message)).toEqual(
			[],
		);
		if (!restored.ok) return;
		expect(
			identityMovesBetween(removed.nextDoc, restored.nextDoc, { recorded }),
		).toEqual([]);
		expect(
			withIdentityMoves(removed.nextDoc, undo, { recorded }).moves,
		).toEqual([]);
		expect(
			identityMovesBetween(removed.nextDoc, restored.nextDoc).map(
				(move) => move.subject,
			),
		).toEqual([
			{
				kind: "case-operation",
				formUuid: REGISTRATION,
				operationUuid: second.uuid,
			},
		]);
	});
});

describe("admittedHoldChanges, as a history step calls it", () => {
	it("keeps the move and the restore, and drops a restore a later publish replaced", () => {
		const base = published();
		const recorded = recordedOf(base);
		const ownUuid = ownOf(base, FOLLOWUP);
		const forward = withIdentityMoves(base, [setRemark(base, computed)]);
		const moved = verdict(base, forward.batch);
		if (!moved.ok) throw new Error("The move commits.");
		const restoreHold: PlacementHoldEntry = {
			target: "case-operation",
			formUuid: FOLLOWUP,
			operationUuid: ownUuid,
			placement: { kind: "basic", slot: "own" },
		};
		const inverse = admitMutationBatch([
			setRemark(moved.nextDoc, read("remark")),
			holds(restoreHold),
		]);
		// Arm (b): the restore of the recorded hold.
		expect(
			holdEntries(admittedHoldChanges(moved.nextDoc, inverse, recorded)),
		).toEqual([restoreHold]);
		// Arm (a): the redo moves a hold its content strands.
		expect(
			holdEntries(
				admittedHoldChanges(
					verdict(moved.nextDoc, inverse).nextDoc,
					admitMutationBatch(forward.batch),
					recorded,
				),
			),
		).toEqual(holdEntries(forward.batch));
		// A publish recorded the moved place: the undo's hold change is no
		// longer a restore, Save to Case still holds the change, so the hold
		// change is dropped and the content kept.
		const republished = recordedOf(moved.nextDoc);
		const kept = admittedHoldChanges(moved.nextDoc, inverse, republished);
		expect(holdEntries(kept)).toEqual([]);
		expect(kept).toEqual([inverse[0]]);
	});
});

describe("planConflictReplay", () => {
	const hintEdit: Mutation = {
		kind: "updateField",
		uuid: U("remark"),
		targetKind: "text",
		patch: { hint: { parts: [{ kind: "text", text: "Anything else" }] } },
	} as Mutation;

	it("plans edits composed before a publish recorded its holds as one batch with their moves", () => {
		// The tab composed two edits over a document that held nothing.
		const stale = moveFixture();
		const first = [setRemark(stale, computed)];
		const second = [setQuery(PATIENTS_NAMED)];
		expect(refusalCodes(stale, first)).toEqual([]);
		expect(refusalCodes(stale, [...first, ...second])).toEqual([]);
		// A publish recorded every place; the head refuses the edits as they
		// were made.
		const head = published();
		const recorded = recordedOf(head);
		expect(refusalCodes(head, [...first, ...second])).toEqual(
			expect.arrayContaining([
				"HELD_PLACEMENT_INEXPRESSIBLE",
				"QUERY_REPEAT_MODEL_ITERATION_SHAPE",
			]),
		);
		const plan = planConflictReplay(head, [first, second], recorded);
		expect(plan.moves.map((move) => move.subject)).toEqual([
			{
				kind: "case-operation",
				formUuid: FOLLOWUP,
				operationUuid: ownOf(head, FOLLOWUP),
			},
			{ kind: "query-repeat", formUuid: FOLLOWUP, fieldUuid: VISITS },
		]);
		expect(plan.batch.slice(0, 2)).toEqual([...first, ...second]);
		expect(plan.batch.slice(2).map((m) => m.kind)).toEqual(["holdPlacements"]);
		const result = verdict(head, plan.batch);
		expect(result.ok ? [] : result.findings.map((f) => f.message)).toEqual([]);
	});

	it("drops a hold change the kernel would refuse and keeps the content beside it", () => {
		const head = published();
		const recorded = recordedOf(head);
		// A move to Save to Case, planned where the own case's change could no
		// longer stay; on the head nothing strands it.
		const [stranded] = holdEntries(
			withIdentityMoves(head, [setRemark(head, computed)]).batch,
		);
		const plan = planConflictReplay(
			head,
			[[hintEdit, holds(stranded)]],
			recorded,
		);
		expect(plan.batch).toEqual([hintEdit]);
		expect(plan.moves).toEqual([]);
		expect(verdict(head, plan.batch).ok).toBe(true);
	});

	it("returns no move for a replay whose content strands no hold", () => {
		const head = published();
		const plan = planConflictReplay(head, [[hintEdit], []], recordedOf(head));
		expect(plan.batch).toEqual([hintEdit]);
		expect(plan.moves).toEqual([]);
	});

	it("keeps the later of two holds the replay gives one target", () => {
		const base = published();
		const recorded = recordedOf(base);
		const forward = withIdentityMoves(base, [setRemark(base, computed)]);
		const moved = verdict(base, forward.batch);
		if (!moved.ok) throw new Error("The move commits.");
		const [movedHold] = holdEntries(forward.batch);
		const restore: PlacementHoldEntry = {
			...movedHold,
			placement: { kind: "basic", slot: "own" },
		} as PlacementHoldEntry;
		// The earlier batch puts the recorded hold back, and the later one
		// takes the target to where it already is: together they change
		// nothing.
		const plan = planConflictReplay(
			moved.nextDoc,
			[[holds(restore)], [holds(movedHold)]],
			recorded,
		);
		expect(plan.batch).toEqual([]);
		expect(plan.moves).toEqual([]);
	});

	it("plans a stale move again where a publish recorded another change in its place", () => {
		const { head, undo, first, firstHold, second } = republishedRegistration();
		if (firstHold === undefined) throw new Error("The first kid was held.");
		// The kernel reads the first kid's recorded hold from the recording
		// that last held it, before the tab removed it.
		const recorded = recordedOf(head);
		const firstRecorded: PlacementHold = {
			target: "case-operation",
			formUuid: REGISTRATION,
			operationUuid: first,
			placement: firstHold,
		};
		recorded.set(placementTargetKey(firstRecorded), firstRecorded);
		// Kept as made, the undo's move of the second kid lands on the third
		// kid's recorded place.
		expect(
			refusalCodes(
				head,
				admittedHoldChanges(head, admitMutationBatch(undo), recorded),
			),
		).toContain("CASE_PLACEMENT_SHARED");
		const plan = planConflictReplay(head, [undo], recorded);
		const result = verdict(head, plan.batch);
		expect(result.ok ? [] : result.findings.map((f) => f.message)).toEqual([]);
		// The second kid's move is planned over the head, around the third
		// kid's recorded place, and stated.
		expect(plan.moves.map((move) => move.subject)).toEqual([
			{ kind: "case-operation", formUuid: REGISTRATION, operationUuid: second },
		]);
	});
});

describe("identityMoveReportSchema", () => {
	it("parses each subject a report names and refuses an unknown one", () => {
		const uuid = FOLLOWUP;
		for (const subject of [
			{ kind: "case-operation", formUuid: uuid, operationUuid: uuid },
			{ kind: "own-close", formUuid: uuid },
			{ kind: "query-repeat", formUuid: uuid, fieldUuid: uuid },
			{ kind: "module-kind", moduleUuid: uuid },
		])
			expect(
				identityMoveReportSchema.safeParse({ subject, sentence: "Moves." })
					.success,
			).toBe(true);
		expect(
			identityMoveReportSchema.safeParse({
				subject: { kind: "own-close", formUuid: "not-a-uuid" },
				sentence: "Moves.",
			}).success,
		).toBe(false);
		expect(
			identityMoveReportSchema.safeParse({
				subject: { kind: "own-close", formUuid: uuid },
				sentence: "",
			}).success,
		).toBe(false);
	});
});
