/**
 * Moves of a menu's kind, through the real commit gate. The plausible
 * failures: a published advanced menu a blocker meets whose held kind is
 * cleared without a statement (or not cleared, so the edit can never
 * commit); its forms' held advanced placements left where a basic form
 * cannot use them; a published ordinary menu a carried create turns
 * advanced whose move nobody is told about, or told without the renamed
 * session values of a parent selection; a move stated for a menu no publish
 * recorded; and an undo of the move the commit kernel refuses.
 */
import { describe, expect, it } from "vitest";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { placementChangeRefusal } from "@/lib/db/placementAuthority";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { identityMoveSentence } from "@/lib/doc/identityMoveCopy";
import {
	identityMovesBetween,
	withIdentityMoves,
} from "@/lib/doc/identityMoves";
import { planModuleKindMoves } from "@/lib/doc/moduleKindMoves";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	admittedHoldChanges,
	type PlacementHold,
	readPlacementHolds,
} from "@/lib/doc/placementHolds";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { isBlank, prop } from "@/lib/domain/expression/builders";
import {
	CHECK_IN,
	carryVisit,
	DIRECTORY,
	HOUSEHOLDS,
	K,
	kindFixture,
	MEMBERS,
	memberUnderTwoNames,
	publishedAdvanced,
	publishedBasic,
	VISITS,
} from "./moduleKindMoveFixture";
import { holds, refusalCodes, verdict } from "./placementMoveFixture";

const holdEntries = (batch: readonly Mutation[]): PlacementHoldEntry[] =>
	batch.flatMap((m) => (m.kind === "holdPlacements" ? m.holds : []));

const recordedOf = (doc: BlueprintDoc): Map<string, PlacementHold> =>
	new Map(readPlacementHolds(doc));

/** Every placement the menu's forms hold, by kind. */
function heldPlacementKinds(doc: BlueprintDoc, moduleUuid: Uuid): string[] {
	return (doc.formOrder[moduleUuid] ?? []).flatMap((formUuid) =>
		(doc.forms[formUuid].caseOperations ?? []).flatMap((op) =>
			op.placement === undefined ? [] : [op.placement.kind],
		),
	);
}

/** The form's starting values that read its case, which a several-case
 *  form cannot read as one case. */
const noPreload = (id: string): Mutation =>
	({
		kind: "updateField",
		uuid: K(id),
		targetKind: "int",
		patch: { default_value: null },
	}) as Mutation;

describe("planModuleKindMoves, for a held kind a blocker meets", () => {
	const rows: readonly {
		readonly blocker: string;
		readonly module: Uuid;
		readonly edit: (doc: BlueprintDoc) => Mutation[];
	}[] = [
		{
			blocker: "several-cases",
			module: HOUSEHOLDS,
			edit: () => [
				noPreload("size"),
				{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
				{
					kind: "setCaseListMeta",
					uuid: HOUSEHOLDS,
					patch: { selection: { kind: "multiple", maximum: 5 } },
				} as Mutation,
			],
		},
		{
			blocker: "forms-read-search",
			module: VISITS,
			edit: () => [
				{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
				{
					kind: "updateModule",
					uuid: VISITS,
					patch: {},
					caseSearchConfigPatch: { searchFirst: true },
				} as Mutation,
			],
		},
		{
			blocker: "case-list-menu-item-narrowed",
			module: DIRECTORY,
			edit: () => [
				{
					kind: "setCaseListMeta",
					uuid: DIRECTORY,
					patch: { filter: isBlank(prop("household", "size")) },
				} as Mutation,
			],
		},
		{
			blocker: "chain-index",
			module: MEMBERS,
			edit: () => memberUnderTwoNames,
		},
	];

	for (const row of rows)
		it(`clears the held kind and states the move under ${row.blocker}, and part 01 moves the forms' held placements`, () => {
			const doc = publishedAdvanced(kindFixture(), row.module);
			expect(verdict(doc, []).ok).toBe(true);
			expect(
				heldPlacementKinds(doc, row.module).every(
					(kind) => kind === "advanced",
				),
			).toBe(true);
			const edit = row.edit(doc);
			// Without the planner the held kind can no longer express the menu.
			expect(refusalCodes(doc, edit)).toContain("HELD_PLACEMENT_INEXPRESSIBLE");
			const kinds = planModuleKindMoves(
				doc,
				verdictCandidate(doc, edit, { stranded: true }),
			);
			expect(kinds.holds).toEqual([
				{ target: "module-kind", moduleUuid: row.module, placement: null },
			]);
			expect(kinds.moves).toEqual([
				{
					subject: { kind: "module-kind", moduleUuid: row.module },
					from: "advanced-menu",
					to: "ordinary-menu",
					reason: {
						source: "module-kind",
						reason: row.blocker,
						chosenCasesRenamed: row.module === MEMBERS,
					},
				},
			]);
			const plan = withIdentityMoves(doc, edit);
			// The menu's move comes first, then the moves of its forms' case
			// changes, which part 01 plans over the cleared kind.
			expect(plan.moves[0]).toEqual(kinds.moves[0]);
			const formMoves = plan.moves.slice(1);
			// A menu with no forms has no case change to move.
			expect(formMoves.length > 0).toBe(
				(kindFixture().formOrder[row.module] ?? []).length > 0,
			);
			for (const move of formMoves) {
				expect(move.subject.kind).toBe("case-operation");
				expect(move.from).toBe("case-actions");
				expect(move.reason).toEqual({
					source: "case-placement",
					reason: { reason: "module-basic" },
				});
			}
			expect(holdEntries(plan.batch)[0]).toEqual(kinds.holds[0]);
			const result = verdict(doc, plan.batch);
			expect(result.ok ? [] : result.findings.map((f) => f.message)).toEqual(
				[],
			);
			if (!result.ok) return;
			expect(result.nextDoc.modules[row.module].heldKind).toBeUndefined();
			expect(emittedModuleKind(result.nextDoc, row.module)).toBe("basic");
			expect(heldPlacementKinds(result.nextDoc, row.module)).not.toContain(
				"advanced",
			);
		});

	it("states that a parent selection's forms read their chosen cases under new names", () => {
		const doc = publishedAdvanced(kindFixture(), MEMBERS);
		const [move] = withIdentityMoves(doc, memberUnderTwoNames).moves;
		expect(identityMoveSentence(doc, move)).toBe(
			"“Members” moves from an advanced menu to an ordinary menu. Its cases now link to their parent case under more than one name. Its forms also read the cases chosen through its parent case under new names. From your next publish, CommCare HQ's exports show these answers under new columns.",
		);
	});

	it("words each reason of a menu's move in its own sentence", () => {
		const doc = kindFixture();
		const sentences = (
			[
				"several-cases",
				"forms-read-search",
				"case-list-menu-item-narrowed",
				"chain-index",
				"advanced-change",
			] as const
		).map((reason) =>
			identityMoveSentence(doc, {
				subject: { kind: "module-kind", moduleUuid: VISITS },
				from: "advanced-menu",
				to: "ordinary-menu",
				reason: { source: "module-kind", reason, chosenCasesRenamed: false },
			}),
		);
		const lead = "“Visits” moves from an advanced menu to an ordinary menu.";
		const exports =
			"From your next publish, CommCare HQ's exports show these answers under new columns.";
		expect(sentences).toEqual([
			`${lead} It now lets workers choose several cases, which an advanced menu can't do. ${exports}`,
			`${lead} It now opens on its Search screen with its forms reading the search, which an advanced menu can't do. ${exports}`,
			`${lead} Its case list in the menu now has a filter or a parent case, which an advanced menu would leave out. ${exports}`,
			`${lead} Its cases now link to their parent case under more than one name. ${exports}`,
			`${lead} A form in it now saves a case change only an advanced menu can. ${exports}`,
		]);
	});

	it("leaves a held kind no blocker meets as it is", () => {
		const doc = publishedAdvanced(kindFixture(), HOUSEHOLDS);
		const edit: Mutation[] = [
			{
				kind: "updateModule",
				uuid: HOUSEHOLDS,
				patch: { name: "Homes" },
			} as Mutation,
		];
		const plan = withIdentityMoves(doc, edit);
		expect(plan.batch).toBe(edit);
		expect(plan.moves).toEqual([]);
	});
});

describe("planModuleKindMoves, for a menu a carried create turns advanced", () => {
	it("states a published ordinary menu's move to an advanced menu, with no hold of its own", () => {
		const doc = publishedBasic(kindFixture(), HOUSEHOLDS);
		expect(verdict(doc, []).ok).toBe(true);
		const edit = carryVisit();
		const plan = withIdentityMoves(doc, edit);
		expect(plan.moves[0]).toEqual({
			subject: { kind: "module-kind", moduleUuid: HOUSEHOLDS },
			from: "ordinary-menu",
			to: "advanced-menu",
			reason: {
				source: "module-kind",
				reason: "advanced-change",
				chosenCasesRenamed: false,
			},
		});
		expect(
			holdEntries(plan.batch).filter((entry) => entry.target === "module-kind"),
		).toEqual([]);
		const result = verdict(doc, plan.batch);
		expect(result.ok ? [] : result.findings.map((f) => f.message)).toEqual([]);
		if (!result.ok) return;
		expect(emittedModuleKind(result.nextDoc, HOUSEHOLDS)).toBe("advanced");
		expect(identityMoveSentence(result.nextDoc, plan.moves[0])).toBe(
			"“Households” moves from an ordinary menu to an advanced menu. A form in it now saves a case change only an advanced menu can. From your next publish, CommCare HQ's exports show these answers under new columns.",
		);
		// A redo of the same change states the move again.
		expect(identityMovesBetween(doc, result.nextDoc)[0]).toEqual(plan.moves[0]);
	});

	it("states the renamed session values where the menu selects a parent case", () => {
		const doc = publishedBasic(kindFixture(), MEMBERS);
		const edit = carryVisit(CHECK_IN, "member");
		const candidate = verdictCandidate(doc, edit, { stranded: true });
		expect(emittedModuleKind(candidate, MEMBERS)).toBe("advanced");
		expect(planModuleKindMoves(doc, candidate)).toEqual({
			holds: [],
			moves: [
				{
					subject: { kind: "module-kind", moduleUuid: MEMBERS },
					from: "ordinary-menu",
					to: "advanced-menu",
					reason: {
						source: "module-kind",
						reason: "advanced-change",
						chosenCasesRenamed: true,
					},
				},
			],
		});
	});

	it("states no move for a menu no publish recorded", () => {
		const doc = kindFixture();
		const edit = carryVisit();
		const candidate = verdictCandidate(doc, edit, { stranded: false });
		expect(emittedModuleKind(candidate, HOUSEHOLDS)).toBe("advanced");
		expect(planModuleKindMoves(doc, candidate)).toEqual({
			holds: [],
			moves: [],
		});
		const plan = withIdentityMoves(doc, edit);
		expect(plan.batch).toBe(edit);
		expect(plan.moves).toEqual([]);
	});
});

describe("the undo of a menu's move", () => {
	it("restores the recorded hold, which the commit kernel admits and nobody is told about", () => {
		const base = publishedAdvanced(kindFixture(), VISITS);
		const recorded = recordedOf(base);
		const edit: Mutation[] = [
			{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
			{
				kind: "updateModule",
				uuid: VISITS,
				patch: {},
				caseSearchConfigPatch: { searchFirst: true },
			} as Mutation,
		];
		const forward = withIdentityMoves(base, edit);
		const moved = verdict(base, forward.batch);
		if (!moved.ok) throw new Error("The move commits.");
		expect(
			placementChangeRefusal(base, moved.nextDoc, "autosave", recorded),
		).toBeNull();
		// The inverse turns Search first off again and puts back every hold
		// the publish recorded.
		const inverse = admitMutationBatch([
			{
				kind: "updateModule",
				uuid: VISITS,
				patch: {},
				caseSearchConfigPatch: { searchFirst: null },
			} as Mutation,
			holds(...([...recorded.values()] as PlacementHoldEntry[])),
		]);
		const kept = admittedHoldChanges(moved.nextDoc, inverse, recorded);
		expect(holdEntries(kept)).toEqual(holdEntries(inverse));
		const undone = verdict(moved.nextDoc, kept);
		expect(undone.ok ? [] : undone.findings.map((f) => f.message)).toEqual([]);
		if (!undone.ok) return;
		expect(undone.nextDoc.modules[VISITS].heldKind).toBe("advanced");
		expect(
			placementChangeRefusal(
				moved.nextDoc,
				undone.nextDoc,
				"autosave",
				recorded,
			),
		).toBeNull();
		expect(
			identityMovesBetween(moved.nextDoc, undone.nextDoc, { recorded }),
		).toEqual([]);
		expect(withIdentityMoves(moved.nextDoc, kept, { recorded }).moves).toEqual(
			[],
		);
		// Without the recordings the restored kind is a first hold: still no
		// move of the menu.
		expect(
			identityMovesBetween(moved.nextDoc, undone.nextDoc).filter(
				(move) => move.subject.kind === "module-kind",
			),
		).toEqual([]);
	});
});

/** The document `edit` makes of `doc`, admitted or not: the candidate a
 *  planner reads. `stranded` says whether the gate refuses it as it is. */
function verdictCandidate(
	doc: BlueprintDoc,
	edit: readonly Mutation[],
	{ stranded }: { readonly stranded: boolean },
): BlueprintDoc {
	const codes = refusalCodes(doc, edit);
	if (stranded) expect(codes.length).toBeGreaterThan(0);
	else expect(codes).toEqual([]);
	return prepareMutationCandidate(doc, admitMutationBatch([...edit])).nextDoc;
}
