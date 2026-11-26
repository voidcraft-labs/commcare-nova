/**
 * Identity moves of held query repeats, through the real commit gate. The
 * plausible failures: an edit that leaves a repeat held at model iteration
 * in a shape model iteration cannot run commits unstated (or is refused
 * with no way through), a held count or an unheld repeat is stated as a
 * move, and an undo or a re-creation the commit kernel would refuse.
 */
import { describe, expect, it } from "vitest";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { identityMovesBetween } from "@/lib/doc/identityMoves";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	admittedHoldChanges,
	NO_RECORDED_HOLDS,
	type PlacementHold,
	readPlacementHolds,
} from "@/lib/doc/placementHolds";
import { planQueryRepeatPlacementMoves } from "@/lib/doc/queryRepeatPlacement";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, literal, now, term } from "@/lib/domain/expression/builders";
import {
	FOLLOWUP,
	holds,
	holdVisits,
	moveFixture,
	OPEN_PATIENTS,
	PATIENTS_BY_ENTERED_ID,
	read,
	refusalCodes,
	U,
	verdict,
} from "./placementMoveFixture";

const VISITS = U("visits");

const visitsHold = (
	placement: "model-iteration" | "count" | null,
): PlacementHoldEntry => ({
	target: "query-repeat",
	fieldUuid: VISITS,
	placement,
});

const setQuery = (query: typeof OPEN_PATIENTS): Mutation =>
	({
		kind: "updateField",
		uuid: VISITS,
		targetKind: "repeat",
		patch: { data_source: { ids_query: query } },
	}) as Mutation;

const FOLLOW = `You can let its rows follow its query as the form is filled in, which moves where CommCare HQ keeps each row's record id`;

interface Row {
	readonly name: string;
	readonly edit: Mutation[];
	readonly need: Record<string, unknown>;
	readonly message: string;
}

const ROWS: readonly Row[] = [
	{
		name: "nesting it in another repeat",
		edit: [
			{
				kind: "moveField",
				uuid: VISITS,
				toParentUuid: U("rounds"),
				after: U("round_note"),
			},
		],
		need: { kind: "nested", repeatUuid: U("rounds") },
		message: `"Visits" takes its rows once, when the form opens, as your published app does, and inside "rounds" that would give its rows the wrong records. ${FOLLOW}, or keep it outside "rounds".`,
	},
	{
		name: "an answer added to its query",
		edit: [setQuery(PATIENTS_BY_ENTERED_ID)],
		need: { kind: "query-reads-answers" },
		message: `"Visits" takes its rows once, when the form opens, as your published app does, before the answer its query matches a record ID against is given, so it would find no records. ${FOLLOW}, or give that answer a starting value.`,
	},
];

function candidateOf(doc: BlueprintDoc, edit: readonly Mutation[]) {
	return prepareMutationCandidate(doc, admitMutationBatch(edit)).nextDoc;
}

const holdEntries = (batch: readonly Mutation[]): PlacementHoldEntry[] =>
	batch.flatMap((m) => (m.kind === "holdPlacements" ? m.holds : []));

describe("planQueryRepeatPlacementMoves", () => {
	it("keeps the open snapshot for changing row and group conditions when the opening assignments still run", () => {
		const doc = holdVisits(moveFixture(), "model-iteration");
		for (const [uuid, targetKind, relevant] of [
			[VISITS, "repeat", eq(now(), now())],
			[U("extra"), "group", eq(read("remark"), term(literal("more")))],
		] as const) {
			const edit = [
				{ kind: "updateField", uuid, targetKind, patch: { relevant } },
			] as Mutation[];
			expect(verdict(doc, edit).ok).toBe(true);
			expect(
				planQueryRepeatPlacementMoves(candidateOf(doc, edit)).moves,
			).toEqual([]);
		}
	});

	it.each([
		["count", "on-open", "model-iteration"],
		["model-iteration", "as-answers-change", "count"],
	] as const)(
		"moves a published %s only with the reviewed choice %s",
		(from, timing, to) => {
			const doc = holdVisits(moveFixture(), from);
			const edit: Mutation = {
				kind: "updateField",
				uuid: VISITS,
				targetKind: "repeat",
				patch: { rowTiming: timing },
			};
			expect(refusalCodes(doc, [edit])).toContain("QUERY_REPEAT_TIMING_MOVE");
			const change = planQueryRepeatPlacementMoves(candidateOf(doc, [edit]));
			expect(change.holds).toEqual([visitsHold(to)]);
			expect(change.moves[0]?.reason).toEqual({
				source: "query-timing",
				timing,
			});
			const result = verdict(doc, [edit, holds(...change.holds)]);
			if (!result.ok)
				throw new Error(result.findings.map((f) => f.message).join("\n"));
			expect(identityMovesBetween(doc, result.nextDoc)).toEqual(change.moves);
		},
	);

	for (const row of ROWS) {
		it(`moves a repeat held at model iteration to the count placement on ${row.name}`, () => {
			const doc = holdVisits(moveFixture(), "model-iteration");
			expect(refusalCodes(doc, [])).toEqual([]);
			const alone = verdict(doc, row.edit);
			expect(alone.ok).toBe(false);
			if (alone.ok) return;
			const finding = alone.findings.find(
				(f) => f.code === "QUERY_REPEAT_MODEL_ITERATION_SHAPE",
			);
			expect(finding?.message).toBe(row.message);
			const plan = planQueryRepeatPlacementMoves(candidateOf(doc, row.edit));
			expect(plan).toEqual({
				holds: [visitsHold("count")],
				moves: [
					{
						subject: {
							kind: "query-repeat",
							formUuid: FOLLOWUP,
							fieldUuid: VISITS,
						},
						from: "rows-set-when-opened",
						to: "rows-follow-query",
						reason: { source: "query-repeat", reason: row.need },
					},
				],
			});
			const result = verdict(doc, [...row.edit, holds(...plan.holds)]);
			expect(result.ok ? [] : result.findings.map((f) => f.message)).toEqual(
				[],
			);
			if (result.ok)
				expect(identityMovesBetween(doc, result.nextDoc)).toEqual(plan.moves);
		});
	}

	it("never states a held count or an unheld repeat", () => {
		for (const doc of [holdVisits(moveFixture(), "count"), moveFixture()]) {
			for (const row of ROWS) {
				expect(
					planQueryRepeatPlacementMoves(candidateOf(doc, row.edit)),
				).toEqual({ holds: [], moves: [] });
				expect(refusalCodes(doc, row.edit)).toEqual([]);
			}
		}
	});
});

describe("undo and redo of a query repeat's move", () => {
	const recordedOf = (doc: BlueprintDoc): Map<string, PlacementHold> =>
		new Map(readPlacementHolds(doc));

	it("restores model iteration with the content by the recorded hold, and the redo states the move again", () => {
		const doc = holdVisits(moveFixture(), "model-iteration");
		const recorded = recordedOf(doc);
		const forward = admitMutationBatch([
			setQuery(PATIENTS_BY_ENTERED_ID),
			holds(visitsHold("count")),
		]);
		const moved = verdict(doc, forward);
		if (!moved.ok) throw new Error("The move commits.");
		const inverse = admitMutationBatch([
			setQuery(OPEN_PATIENTS),
			holds(visitsHold("model-iteration")),
		]);
		const kept = admittedHoldChanges(moved.nextDoc, inverse, recorded);
		expect(holdEntries(kept)).toEqual([visitsHold("model-iteration")]);
		const undone = verdict(moved.nextDoc, kept);
		if (!undone.ok) throw new Error("The undo commits.");
		expect(readPlacementHolds(undone.nextDoc)).toEqual(recorded);
		expect(
			identityMovesBetween(moved.nextDoc, undone.nextDoc, { recorded }),
		).toEqual([]);
		// The redo moves the restored hold again: admitted as a move, and
		// stated.
		expect(
			holdEntries(admittedHoldChanges(undone.nextDoc, forward, recorded)),
		).toEqual([visitsHold("count")]);
		const redone = verdict(undone.nextDoc, forward);
		if (!redone.ok) throw new Error("The redo commits.");
		expect(
			identityMovesBetween(undone.nextDoc, redone.nextDoc, { recorded }).map(
				(move) => move.subject,
			),
		).toEqual([
			{ kind: "query-repeat", formUuid: FOLLOWUP, fieldUuid: VISITS },
		]);
	});

	it("re-creates a removed held query repeat with its hold", () => {
		const doc = holdVisits(moveFixture(), "model-iteration");
		const recorded = recordedOf(doc);
		const removed = verdict(doc, [{ kind: "removeField", uuid: VISITS }]);
		if (!removed.ok) throw new Error("The removal commits.");
		// The content the undo replays, then the recorded hold.
		const content = diffDocsToMutations(removed.nextDoc, doc).filter(
			(m) => m.kind !== "holdPlacements",
		);
		const inverse = admitMutationBatch([
			...content,
			holds(visitsHold("model-iteration")),
		]);
		const kept = admittedHoldChanges(removed.nextDoc, inverse, recorded);
		expect(holdEntries(kept)).toEqual([visitsHold("model-iteration")]);
		const undone = verdict(removed.nextDoc, kept);
		if (!undone.ok) throw new Error("The undo commits.");
		expect(readPlacementHolds(undone.nextDoc)).toEqual(recorded);
	});

	it("drops an editor's move to count while model iteration still runs the repeat", () => {
		const doc = holdVisits(moveFixture(), "model-iteration");
		const batch = admitMutationBatch([holds(visitsHold("count"))]);
		for (const recorded of [recordedOf(doc), NO_RECORDED_HOLDS])
			expect(holdEntries(admittedHoldChanges(doc, batch, recorded))).toEqual(
				[],
			);
	});
});
