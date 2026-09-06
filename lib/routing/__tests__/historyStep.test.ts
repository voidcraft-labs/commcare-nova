import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	availableLookupContext,
	DESTINATIONS_LOOKUP,
} from "@/lib/__tests__/lookupFixtures";
import type { LookupCommitState } from "@/lib/doc/lookupCommitContext";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { runHistoryStep } from "../historyStep";

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
			expect(runHistoryStep(h.store.getState(), action, ready)).toEqual({
				kind: "applied",
			});
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
				expect(runHistoryStep(h.store.getState(), "undo", ready)).toEqual({
					kind: "applied",
				});
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
			expect(runHistoryStep(h.store.getState(), action, ready)).toEqual({
				kind: "applied",
			});
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
		expect(runHistoryStep(h.store.getState(), "undo", ready)).toEqual({
			kind: "applied",
		});
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
			expect(runHistoryStep(h.store.getState(), action, access)).toEqual({
				kind: "applied",
			});
		}
		expect(h.store.getState().fields[h.second].id).toBe("renamed");
	});
});
