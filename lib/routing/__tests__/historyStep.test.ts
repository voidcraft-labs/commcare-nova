import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	availableLookupContext,
	DESTINATIONS_LOOKUP,
} from "@/lib/__tests__/lookupFixtures";
import { placementChangeRefusal } from "@/lib/db/placementAuthority";
import {
	COMPUTED_REMARK,
	commitWithMoves,
	FOLLOWUP,
	foldPublish,
	heldStore,
	holdEntries,
	ownHold,
	ownOf,
	read,
	recordCurrentHolds,
	setRemark,
} from "@/lib/doc/__tests__/heldHistoryFixture";
import {
	holdPlanned,
	isCreate,
	moveFixture,
	REGISTRATION,
	withSecondKid,
} from "@/lib/doc/__tests__/placementMoveFixture";
import { IDENTITY_MOVE_PENDING_MESSAGE } from "@/lib/doc/builderWriteAdmission";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupCommitState } from "@/lib/doc/lookupCommitContext";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { PendingIdentityMove } from "@/lib/doc/pendingIdentityMove";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import { historyStepHoldNote, runHistoryStep } from "../historyStep";

const APPLIED = {
	kind: "applied",
	restoredHold: false,
	droppedHoldChange: false,
} as const;

const ready = {
	canEdit: true,
	lookupCommitState: {
		kind: "ready",
		lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
	},
} as const;

function fixture(lookup = false) {
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								lookup
									? f({
											kind: "single_select",
											id: "a",
											optionsSource: DESTINATIONS_LOOKUP.optionsSource,
										})
									: f({ kind: "text", id: "a" }),
								f({ kind: "text", id: "b" }),
							],
						},
					],
				},
			],
		}),
	);
	store.getState().startTracking();
	const mod = store.getState().moduleOrder[0];
	const form = store.getState().formOrder[mod][0];
	const [first, second] = store.getState().fieldOrder[form];
	return { store, first, second };
}

function renameSecond(h: ReturnType<typeof fixture>) {
	h.store.getState().applyMany([
		{
			kind: "updateField",
			uuid: h.second,
			targetKind: "text",
			patch: { id: "renamed" },
		},
	]);
	h.store.getState().takeCommandBatches();
}

function applyPeer(h: ReturnType<typeof fixture>, mutations: Mutation[]) {
	h.store.getState().beginRemoteApply();
	try {
		h.store.getState().applyMany(mutations);
	} finally {
		h.store.getState().endRemoteApply();
	}
}

describe("Builder history commands", () => {
	it("leaves a fresh history and persistence queue empty", () => {
		const h = fixture();
		const before = h.store.getState();
		for (const action of ["undo", "redo"] as const) {
			expect(runHistoryStep(h.store.getState(), action, ready)).toEqual({
				kind: "empty",
			});
			expect(h.store.getState()).toBe(before);
		}
		expect(h.store.getState().takeCommandBatches()).toEqual([]);
	});

	it("restores the field in both directions and queues each accepted history step for persistence", () => {
		const h = fixture();
		renameSecond(h);
		for (const [action, id, canUndo, canRedo] of [
			["undo", "b", false, true],
			["redo", "renamed", true, false],
		] as const) {
			expect(runHistoryStep(h.store.getState(), action, ready)).toEqual(
				APPLIED,
			);
			expect(h.store.getState().fields[h.second].id).toBe(id);
			expect([h.store.getState().canUndo, h.store.getState().canRedo]).toEqual([
				canUndo,
				canRedo,
			]);
			expect(h.store.getState().takeCommandBatches()).toEqual([
				[
					{
						kind: "updateField",
						uuid: h.second,
						targetKind: "text",
						patch: { id },
					},
				],
			]);
		}
	});

	it.each(["undo", "redo"] as const)(
		"retains %s and the document while access or the Project catalog refuses editing",
		(action) => {
			const h = fixture();
			renameSecond(h);
			if (action === "redo") {
				expect(runHistoryStep(h.store.getState(), "undo", ready)).toEqual(
					APPLIED,
				);
				h.store.getState().takeCommandBatches();
			}
			const before = h.store.getState();
			const batch = action === "undo" ? before.undoBatch() : before.redoBatch();
			for (const [canEdit, kind, reason] of [
				[false, "ready", "view-only"],
				[true, "loading", "still loading"],
				[true, "error", "could not load"],
			] as const) {
				const lookupCommitState: LookupCommitState = {
					kind,
					lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
				};
				expect(
					runHistoryStep(h.store.getState(), action, {
						canEdit,
						lookupCommitState,
					}),
				).toEqual({
					kind: "refused",
					message: expect.stringContaining(reason),
				});
				expect(h.store.getState()).toBe(before);
				expect(
					action === "undo" ? before.undoBatch() : before.redoBatch(),
				).toEqual(batch);
				expect(before.takeCommandBatches()).toEqual([]);
			}
			expect(runHistoryStep(h.store.getState(), action, ready)).toEqual(
				APPLIED,
			);
		},
	);

	it("refuses an inverse made invalid by a peer without consuming it, then permits it when the conflict is removed", () => {
		const h = fixture();
		renameSecond(h);
		applyPeer(h, [
			{
				kind: "updateField",
				uuid: h.first,
				targetKind: "text",
				patch: { id: "b" },
			},
		]);
		const before = h.store.getState();
		expect(runHistoryStep(before, "undo", ready).kind).toBe("refused");
		expect(h.store.getState()).toBe(before);
		expect(before.canUndo).toBe(true);
		expect(before.fields[h.second].id).toBe("renamed");
		expect(before.takeCommandBatches()).toEqual([]);
		applyPeer(h, [
			{
				kind: "updateField",
				uuid: h.first,
				targetKind: "text",
				patch: { id: "a" },
			},
		]);
		expect(runHistoryStep(h.store.getState(), "undo", ready)).toEqual(APPLIED);
		expect(h.store.getState().fields[h.second].id).toBe("b");
	});

	it("requires the current lookup definitions even for an unrelated history step", () => {
		const h = fixture(true);
		renameSecond(h);
		const access = {
			canEdit: true,
			lookupCommitState: {
				kind: "ready",
				lookupContext: availableLookupContext([DESTINATIONS_LOOKUP.definition]),
			},
		} as const;
		for (const action of ["undo", "redo"] as const) {
			const before = h.store.getState();
			expect(runHistoryStep(before, action, ready).kind).toBe("refused");
			expect(h.store.getState()).toBe(before);
			expect(runHistoryStep(h.store.getState(), action, access)).toEqual(
				APPLIED,
			);
		}
		expect(h.store.getState().fields[h.second].id).toBe("renamed");
	});
});

describe("history steps over held placements", () => {
	function slot() {
		let pending: PendingIdentityMove | null = null;
		return {
			read: () => pending,
			set: (next: PendingIdentityMove) => {
				pending = next;
			},
			clear: () => {
				pending = null;
			},
		};
	}

	/** Run a step and hold every document it applies to the commit kernel's
	 *  placement rule under an editor's kind, with the tab's recordings. */
	function step(
		store: ReturnType<typeof heldStore>,
		action: "undo" | "redo",
		identityMoves = slot(),
	) {
		const before = store.getState();
		const result = runHistoryStep(before, action, {
			...ready,
			identityMoves,
		});
		if (result.kind === "applied")
			expect(
				placementChangeRefusal(
					before,
					store.getState(),
					"autosave",
					before.recordedHolds,
				),
			).toBeNull();
		return { result, identityMoves, before };
	}

	it("undoes a move with its recorded hold and no dialog, and states the move when it is redone", () => {
		const store = heldStore();
		const published = ownHold(store.getState());
		commitWithMoves(store, [setRemark(store.getState(), COMPUTED_REMARK)]);
		store.getState().takeCommandBatches();

		const undo = step(store, "undo");
		expect(undo.result).toEqual({
			kind: "applied",
			restoredHold: true,
			droppedHoldChange: false,
		});
		expect(undo.identityMoves.read()).toBeNull();
		expect(ownHold(store.getState())).toEqual(published);
		if (undo.result.kind !== "applied") return;
		expect(historyStepHoldNote("undo", undo.result)).toEqual({
			title: "Undone",
			message: "These answers are back where your published app keeps them.",
		});

		const redo = step(store, "redo");
		expect(redo.result).toEqual({
			kind: "deferred",
			moves: [
				expect.objectContaining({
					subject: {
						kind: "case-operation",
						formUuid: FOLLOWUP,
						operationUuid: ownOf(store.getState()),
					},
				}),
			],
		});
		// Nothing applied: the cursor stays and nothing queues.
		expect(store.getState()).toBe(redo.before);
		expect(store.getState().canRedo).toBe(true);
		expect(store.getState().peekCommandBatches()).toHaveLength(1);
		expect(redo.identityMoves.read()).toEqual({
			batch: store.getState().redoBatch(),
			moves: redo.result.kind === "deferred" ? redo.result.moves : [],
			origin: "redo",
		});
	});

	it("keeps the place a later publish recorded, undoes the content, and says so", () => {
		const store = heldStore();
		commitWithMoves(store, [setRemark(store.getState(), COMPUTED_REMARK)]);
		const moved = toPersistableDoc(store.getState());
		const movedHold = ownHold(store.getState());
		recordCurrentHolds(store);

		const undo = step(store, "undo");
		expect(undo.result).toEqual({
			kind: "applied",
			restoredHold: false,
			droppedHoldChange: true,
		});
		expect(ownHold(store.getState())).toEqual(movedHold);
		if (undo.result.kind !== "applied") return;
		expect(historyStepHoldNote("undo", undo.result)).toEqual({
			title: "Undone",
			message:
				"CommCare HQ keeps these answers where your last publish put them, since only a publish records a new place.",
		});
		// The redo replays exactly what the undo applied.
		expect(step(store, "redo").result).toEqual(APPLIED);
		expect(toPersistableDoc(store.getState())).toEqual(moved);
	});

	it("re-creates a removed held case change with its hold", () => {
		const base = holdPlanned(withSecondKid(moveFixture()), REGISTRATION);
		const store = heldStore(base);
		const held = (store.getState().forms[REGISTRATION].caseOperations ?? [])
			.filter(isCreate)
			.map((op) => ({ uuid: op.uuid, placement: op.placement }));
		commitWithMoves(store, [
			{
				kind: "updateForm",
				uuid: REGISTRATION,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: held[0].uuid },
			},
		]);

		const undo = step(store, "undo");
		expect(undo.result).toMatchObject({ kind: "applied" });
		expect(
			(store.getState().forms[REGISTRATION].caseOperations ?? [])
				.filter(isCreate)
				.map((op) => ({ uuid: op.uuid, placement: op.placement })),
		).toEqual(held);
	});

	it("states the move an undo needs when its content strands a hold a later publish recorded", () => {
		const store = heldStore();
		const published = ownHold(store.getState());
		commitWithMoves(store, [setRemark(store.getState(), COMPUTED_REMARK)]);
		commitWithMoves(store, [setRemark(store.getState(), read("remark"))]);
		// The publish puts the change back in Case Management and records it.
		foldPublish(store, [
			{
				target: "case-operation",
				formUuid: FOLLOWUP,
				operationUuid: ownOf(store.getState()),
				placement: published as Extract<
					PlacementHoldEntry,
					{ target: "case-operation" }
				>["placement"],
			},
		]);
		store.getState().takeCommandBatches();

		const undo = step(store, "undo");
		expect(undo.result).toMatchObject({
			kind: "deferred",
			moves: [expect.objectContaining({ from: "case-management" })],
		});
		expect(store.getState()).toBe(undo.before);
		expect(store.getState().takeCommandBatches()).toEqual([]);
		const pending = undo.identityMoves.read();
		expect(pending?.origin).toBe("undo");
		expect(holdEntries(pending?.batch ?? [])).toHaveLength(1);
	});

	it("refuses every step while a change waits in the dialog, and a refusal stays a refusal", () => {
		const store = heldStore();
		commitWithMoves(store, [setRemark(store.getState(), COMPUTED_REMARK)]);
		const identityMoves = slot();
		identityMoves.set({ batch: [], moves: [], origin: "edit" });
		const before = store.getState();
		expect(step(store, "undo", identityMoves).result).toEqual({
			kind: "refused",
			message: IDENTITY_MOVE_PENDING_MESSAGE,
		});
		expect(store.getState()).toBe(before);
		expect(
			runHistoryStep(store.getState(), "undo", {
				canEdit: true,
				lookupCommitState: {
					kind: "loading",
					lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
				},
			}).kind,
		).toBe("refused");
		expect(store.getState()).toBe(before);
	});
});
