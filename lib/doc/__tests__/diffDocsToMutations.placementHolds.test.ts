/**
 * The diff writer and held placements: a held slot travels only in one
 * trailing `holdPlacements`, after every structural mutation, so a replay of
 * the diff through JSON, the strict mutation schema and the real commit gate
 * reproduces the target's holds exactly. The plausible failures are a held
 * slot copied into a structural payload (which the schema refuses, losing the
 * whole batch), a hold that differs and is not written (the replay drops it),
 * a hold written for a target its owner's removal took away (target
 * admission refuses it), and a born target whose hold lands before the
 * target exists.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	holdFixture,
	OPEN_PATIENTS,
	OWN,
	operationHold,
	queryRepeatHold,
	saveToCase,
	U,
	UPDATE,
	update,
	VISITS,
} from "./placementHoldFixture";

const HELD = saveToCase("nova_operations", "upd");
const SECOND = U("second_visits");
const SECOND_NOTE = U("second_note");

/** `doc` with the update operation holding `placement` (or nothing). */
function holdingUpdate(
	doc: BlueprintDoc,
	formUuid: Uuid,
	placement: CaseOperation["placement"],
): BlueprintDoc {
	return produce(doc, (draft) => {
		const operation = draft.forms[formUuid].caseOperations?.find(
			(op) => op.uuid === UPDATE,
		);
		if (operation === undefined) throw new Error("The fixture updates.");
		if (placement === undefined) delete operation.placement;
		else operation.placement = placement;
	});
}

/** `doc` with the visits query repeat holding `placement` (or nothing). */
function holdingVisits(
	doc: BlueprintDoc,
	placement: "model-iteration" | "count" | undefined,
): BlueprintDoc {
	return produce(doc, (draft) => {
		const field = draft.fields[VISITS];
		if (field.kind !== "repeat" || field.repeat_mode !== "query_bound")
			throw new Error("The fixture's visits is a query repeat.");
		if (placement === undefined) delete field.placement;
		else field.placement = placement;
	});
}

/**
 * The diff, sent through JSON and the strict schema as persistence sends it,
 * then admitted (identity, sequence and target admission) and applied to
 * `from` as a replay applies it. The fixture is the placement planner's,
 * whose shapes are chosen for placement rather than to pass every validator
 * rule, so the gate-backed replay of admitted documents lives in the diff's
 * fuzz test.
 */
function replay(from: BlueprintDoc, mutations: readonly Mutation[]) {
	const wire: unknown = JSON.parse(JSON.stringify(mutations));
	if (!Array.isArray(wire)) throw new Error("The diff is an array.");
	const prepared = prepareMutationCandidate(
		from,
		admitMutationBatch(wire.map((mutation) => mutationSchema.parse(mutation))),
	);
	expect(prepared.identityAdmissionIssue).toBeUndefined();
	expect(prepared.sequenceAdmissionIssue).toBeUndefined();
	expect(prepared.targetAdmissionIssue).toBeUndefined();
	return prepared.nextDoc;
}

function expectReplays(from: BlueprintDoc, to: BlueprintDoc): Mutation[] {
	const diff = diffDocsToMutations(from, to);
	expect(toPersistableDoc(replay(from, diff))).toEqual(toPersistableDoc(to));
	return diff;
}

/** Every structural payload of `diff`, as JSON, must hold no held slot. */
function expectNoHeldSlotOutsideHolds(diff: readonly Mutation[]): void {
	for (const mutation of diff) {
		if (mutation.kind === "holdPlacements") continue;
		expect(JSON.stringify(mutation)).not.toMatch(
			/"(placement|ownClosePlacement)"/,
		);
	}
}

function holdsOf(diff: readonly Mutation[]) {
	return diff.filter((mutation) => mutation.kind === "holdPlacements");
}

describe("diffDocsToMutations and held placements", () => {
	it("emits one trailing holdPlacements for every hold that differs", () => {
		const { doc, formUuid } = holdFixture();
		const from = holdingVisits(doc, "model-iteration");
		const to = produce(
			holdingVisits(holdingUpdate(from, formUuid, HELD), "count"),
			(draft) => {
				draft.forms[formUuid].name = "Review visit";
			},
		);

		const diff = expectReplays(from, to);
		expect(holdsOf(diff)).toHaveLength(1);
		expect(diff.at(-1)).toEqual({
			kind: "holdPlacements",
			holds: [
				operationHold(formUuid, UPDATE, HELD),
				queryRepeatHold(VISITS, "count"),
			],
		});
		expectNoHeldSlotOutsideHolds(diff);

		// The way back clears the operation's hold and restores the repeat's;
		// the own case, held by neither side, is never named.
		const back = expectReplays(to, from);
		expect(back.at(-1)).toEqual({
			kind: "holdPlacements",
			holds: [
				operationHold(formUuid, UPDATE, null),
				queryRepeatHold(VISITS, "model-iteration"),
			],
		});
		expect(
			holdsOf(back)
				.flatMap((m) => m.holds)
				.some(
					(entry) =>
						entry.target === "case-operation" && entry.operationUuid === OWN,
				),
		).toBe(false);

		// Documents whose holds agree emit no holdPlacements at all.
		expect(holdsOf(diffDocsToMutations(to, structuredClone(to)))).toEqual([]);
	});

	it("emits nothing for a hold removed with its owner", () => {
		const { doc, formUuid } = holdFixture();
		const from = holdingVisits(holdingUpdate(doc, formUuid, HELD), "count");
		const to = replay(from, [
			{ kind: "removeField", uuid: VISITS },
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: UPDATE },
			},
		]);

		const diff = expectReplays(from, to);
		expect(holdsOf(diff)).toEqual([]);
		expect(diff).toEqual(
			expect.arrayContaining([{ kind: "removeField", uuid: VISITS }]),
		);
	});

	it("replays a created and held operation exactly", () => {
		const { doc: from, formUuid } = holdFixture(undefined, () => [
			{ uuid: OWN, id: "patient", action: "own" } as CaseOperation,
		]);
		const to = produce(from, (draft) => {
			draft.forms[formUuid].caseOperations?.push(update({ placement: HELD }));
		});

		const diff = expectReplays(from, to);
		const addAt = diff.findIndex(
			(mutation) =>
				mutation.kind === "updateForm" &&
				mutation.caseOperationChange?.operation === "add",
		);
		const add = diff[addAt];
		if (
			add?.kind !== "updateForm" ||
			add.caseOperationChange?.operation !== "add"
		)
			throw new Error("The diff adds the update operation.");
		expect(Object.hasOwn(add.caseOperationChange.value, "placement")).toBe(
			false,
		);
		expect(diff.at(-1)).toEqual({
			kind: "holdPlacements",
			holds: [operationHold(formUuid, UPDATE, HELD)],
		});
		expect(addAt).toBeLessThan(diff.length - 1);
		expectNoHeldSlotOutsideHolds(diff);
	});

	it("replays a query repeat's placement difference as holdPlacements, never updateField", () => {
		const { doc } = holdFixture();
		const from = holdingVisits(doc, "model-iteration");
		const to = holdingVisits(doc, "count");

		expect(expectReplays(from, to)).toEqual([
			{
				kind: "holdPlacements",
				holds: [queryRepeatHold(VISITS, "count")],
			},
		]);
		// A cleared hold is a `null` entry, never an `updateField` clear.
		expect(expectReplays(from, doc)).toEqual([
			{
				kind: "holdPlacements",
				holds: [queryRepeatHold(VISITS, null)],
			},
		]);
	});

	it("adds a born query repeat unheld and then holds it", () => {
		const { doc: from, formUuid } = holdFixture();
		const to = produce(from, (draft) => {
			draft.fields[SECOND] = {
				uuid: SECOND,
				kind: "repeat",
				id: "second_visits",
				label: proseText("Second visits"),
				repeat_mode: "query_bound",
				data_source: { ids_query: OPEN_PATIENTS },
				placement: "count",
			} as BlueprintDoc["fields"][string];
			draft.fields[SECOND_NOTE] = {
				uuid: SECOND_NOTE,
				kind: "text",
				id: "second_note",
				label: proseText("Second note"),
			} as BlueprintDoc["fields"][string];
			draft.fieldOrder[formUuid] = [
				...(draft.fieldOrder[formUuid] ?? []),
				SECOND,
			];
			draft.fieldOrder[SECOND] = [SECOND_NOTE];
		});

		const diff = expectReplays(from, to);
		expect(
			diff.some(
				(mutation) =>
					mutation.kind === "updateField" ||
					(mutation.kind === "addField" &&
						Object.hasOwn(mutation.field, "placement")),
			),
		).toBe(false);
		expect(diff.at(-1)).toEqual({
			kind: "holdPlacements",
			holds: [queryRepeatHold(SECOND, "count")],
		});
	});
});
