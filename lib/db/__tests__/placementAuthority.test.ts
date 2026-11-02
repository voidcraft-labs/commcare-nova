/**
 * Who may change a held placement, over documents made by the production
 * reducer. The plausible failures: a forged autosave that gains or replaces
 * a hold and is admitted, a move or a restore of the recorded hold that is
 * refused (an identity move or its undo could never save), a key the kernel
 * leaves out of its recordings read (a restore is then judged without its
 * recording), and a builder tab whose history keeps a hold change the kernel
 * refuses or drops one it admits.
 */
import { describe, expect, it } from "vitest";
import { placementCandidates } from "@/lib/commcare/placement";
import {
	holdFixture,
	OWN,
	operationHold,
	ownCloseHold,
	PATIENTS_NAMED,
	queryRepeatHold,
	read,
	saveToCase,
	UPDATE,
	update,
	VISITS,
} from "@/lib/doc/__tests__/placementHoldFixture";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	admittedHoldChanges,
	NO_RECORDED_HOLDS,
	type PlacementHold,
	placementTargetKey,
	type RecordedPlacementHolds,
} from "@/lib/doc/placementHolds";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	Field,
	OwnClosePlacement,
	Uuid,
} from "@/lib/domain";
import {
	PLACEMENT_CHANGE_REFUSAL,
	placementChangeRefusal,
	placementChangesToJustify,
} from "../placementAuthority";
import type { BlueprintMutationAppChangeKind } from "../types";

const RECORDED = saveToCase("nova_operations", "upd");
const EDITOR_MOVED = saveToCase("nova_operations", "moved_upd");
const CONDITIONED = saveToCase("nova_operations", "nova_condition_upd", "upd");

const hold = (...holds: PlacementHoldEntry[]): Mutation => ({
	kind: "holdPlacements",
	holds,
});

function recordedOf(...holds: PlacementHoldEntry[]): RecordedPlacementHolds {
	return new Map(
		holds.map((h) => [placementTargetKey(h), h as PlacementHold] as const),
	);
}

function holdEntries(batch: readonly Mutation[]): PlacementHoldEntry[] {
	return batch.flatMap((m) => (m.kind === "holdPlacements" ? m.holds : []));
}

function holdOn(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
	placement: CaseOperation["placement"],
): void {
	const op = doc.forms[formUuid].caseOperations?.find((o) => o.uuid === uuid);
	if (op === undefined) throw new Error(`The fixture holds ${uuid}.`);
	op.placement = placement;
}

function holdQueryRepeat(
	doc: BlueprintDoc,
	placement: "model-iteration" | "count",
): void {
	doc.fields[VISITS] = { ...doc.fields[VISITS], placement } as Field;
}

interface Judged {
	readonly refusal: string | null;
	readonly toJustify: readonly string[];
}

/**
 * The kernel's verdict on `batch` over `prev` under `kind`, and, for an
 * editor's kind, the tab's: `admittedHoldChanges` keeps a batch the kernel
 * admits whole, and every batch it keeps is one the kernel admits.
 */
function judge(
	prev: BlueprintDoc,
	batch: readonly Mutation[],
	recorded: RecordedPlacementHolds,
	kind: BlueprintMutationAppChangeKind = "autosave",
): Judged {
	const admitted = admitMutationBatch(structuredClone([...batch]));
	const next = prepareMutationCandidate(prev, admitted).nextDoc;
	const refusal = placementChangeRefusal(prev, next, kind, recorded);
	const toJustify = placementChangesToJustify(prev, next, kind);
	if (kind !== "blueprint-migration" && kind !== "publish-placement") {
		const kept = admittedHoldChanges(prev, admitted, recorded);
		const keptNext = prepareMutationCandidate(prev, kept).nextDoc;
		expect(placementChangeRefusal(prev, keptNext, kind, recorded)).toBeNull();
		if (refusal === null) {
			expect(holdEntries(kept)).toEqual(holdEntries(batch));
		} else {
			expect(holdEntries(kept).length).toBeLessThan(holdEntries(batch).length);
		}
	}
	return { refusal, toJustify };
}

const opKey = (formUuid: Uuid, operationUuid: Uuid) =>
	placementTargetKey({ target: "case-operation", formUuid, operationUuid });
const ownCloseKey = (formUuid: Uuid) =>
	placementTargetKey({ target: "own-close", formUuid });
const queryRepeatKey = placementTargetKey({
	target: "query-repeat",
	fieldUuid: VISITS,
});

/** A close form and the own close it can hold. */
function closeFixture() {
	const fixture = holdFixture(undefined, undefined, "close");
	const [candidate] = placementCandidates(fixture.doc, fixture.formUuid, {
		kind: "own-close",
	});
	if (candidate?.kind !== "save-to-case")
		throw new Error("A close form's own close has a Save to Case place.");
	const held: OwnClosePlacement = {
		kind: "save-to-case",
		path: candidate.path,
	};
	return { ...fixture, held };
}

const addCondition = (formUuid: Uuid): Mutation =>
	({
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		caseOperationPatch: {
			operation: "update",
			uuid: UPDATE,
			targetAction: "update",
			patch: { condition: read("flag") },
		},
	}) as Mutation;

describe("placementChangeRefusal", () => {
	it("admits any change under blueprint-migration", () => {
		const { doc, formUuid } = holdFixture();
		const batch = [hold(operationHold(formUuid, UPDATE, RECORDED))];
		expect(judge(doc, batch, NO_RECORDED_HOLDS, "blueprint-migration")).toEqual(
			{ refusal: null, toJustify: [] },
		);
		expect(judge(doc, batch, NO_RECORDED_HOLDS, "autosave").refusal).toBe(
			PLACEMENT_CHANGE_REFUSAL,
		);
	});

	it("admits any change under publish-placement", () => {
		const { doc, formUuid } = holdFixture();
		const batch = [hold(operationHold(formUuid, UPDATE, RECORDED))];
		expect(judge(doc, batch, NO_RECORDED_HOLDS, "publish-placement")).toEqual({
			refusal: null,
			toJustify: [],
		});
	});

	it("skips a target removed with its owner", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, RECORDED),
		);
		const remove = {
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: { operation: "remove", uuid: UPDATE },
		} as Mutation;
		expect(judge(doc, [remove], NO_RECORDED_HOLDS)).toEqual({
			refusal: null,
			toJustify: [],
		});
	});

	describe("refuses a hold an editor gains that no recording wrote", () => {
		it("on a case operation", () => {
			const { doc, formUuid } = holdFixture();
			expect(
				judge(
					doc,
					[hold(operationHold(formUuid, UPDATE, RECORDED))],
					NO_RECORDED_HOLDS,
				),
			).toEqual({
				refusal: PLACEMENT_CHANGE_REFUSAL,
				toJustify: [opKey(formUuid, UPDATE)],
			});
		});

		it("on an own close", () => {
			const { doc, formUuid, held } = closeFixture();
			expect(
				judge(doc, [hold(ownCloseHold(formUuid, held))], NO_RECORDED_HOLDS),
			).toEqual({
				refusal: PLACEMENT_CHANGE_REFUSAL,
				toJustify: [ownCloseKey(formUuid)],
			});
		});

		it("on a query repeat", () => {
			const { doc } = holdFixture();
			expect(
				judge(
					doc,
					[hold(queryRepeatHold(VISITS, "model-iteration"))],
					NO_RECORDED_HOLDS,
				),
			).toEqual({
				refusal: PLACEMENT_CHANGE_REFUSAL,
				toJustify: [queryRepeatKey],
			});
		});
	});

	describe("refuses an editor replacing a hold that can still express its target", () => {
		it("on a case operation, replaced or cleared, though the recording holds it", () => {
			const { doc, formUuid } = holdFixture((d, form) =>
				holdOn(d, form, UPDATE, RECORDED),
			);
			const recorded = recordedOf(operationHold(formUuid, UPDATE, RECORDED));
			for (const placement of [EDITOR_MOVED, null]) {
				expect(
					judge(
						doc,
						[hold(operationHold(formUuid, UPDATE, placement))],
						recorded,
					),
				).toEqual({
					refusal: PLACEMENT_CHANGE_REFUSAL,
					toJustify: [opKey(formUuid, UPDATE)],
				});
			}
		});

		it("on an own close", () => {
			const { doc, formUuid, held } = closeFixture();
			doc.forms[formUuid].ownClosePlacement = held;
			expect(
				judge(doc, [hold(ownCloseHold(formUuid, null))], NO_RECORDED_HOLDS),
			).toEqual({
				refusal: PLACEMENT_CHANGE_REFUSAL,
				toJustify: [ownCloseKey(formUuid)],
			});
		});

		it("on a query repeat", () => {
			const { doc } = holdFixture((d) => holdQueryRepeat(d, "model-iteration"));
			expect(
				judge(doc, [hold(queryRepeatHold(VISITS, "count"))], NO_RECORDED_HOLDS),
			).toEqual({
				refusal: PLACEMENT_CHANGE_REFUSAL,
				toJustify: [queryRepeatKey],
			});
		});
	});

	describe("admits an editor moving a hold its edit made inexpressible", () => {
		it("on a case operation", () => {
			const { doc, formUuid } = holdFixture((d, form) =>
				holdOn(d, form, UPDATE, RECORDED),
			);
			expect(
				judge(
					doc,
					[
						addCondition(formUuid),
						hold(operationHold(formUuid, UPDATE, CONDITIONED)),
					],
					NO_RECORDED_HOLDS,
				),
			).toEqual({ refusal: null, toJustify: [] });
		});

		it("on an own close", () => {
			const { doc, formUuid, held } = closeFixture();
			doc.forms[formUuid].ownClosePlacement = held;
			// A follow-up form closes no case, so its own close has no place.
			const toFollowup = {
				kind: "updateForm",
				uuid: formUuid,
				patch: { type: "followup" },
			} as Mutation;
			expect(
				judge(
					doc,
					[toFollowup, hold(ownCloseHold(formUuid, null))],
					NO_RECORDED_HOLDS,
				),
			).toEqual({ refusal: null, toJustify: [] });
		});

		it("on a query repeat", () => {
			const { doc } = holdFixture((d) => holdQueryRepeat(d, "model-iteration"));
			const repeat = doc.fields[VISITS];
			if (repeat.kind !== "repeat" || repeat.repeat_mode !== "query_bound")
				throw new Error("The fixture's visits is a query repeat.");
			// Model iteration cannot run a query that reads an answer.
			const overAnswer = {
				kind: "updateField",
				uuid: VISITS,
				targetKind: "repeat",
				patch: {
					data_source: { ...repeat.data_source, ids_query: PATIENTS_NAMED },
				},
			} as Mutation;
			expect(
				judge(
					doc,
					[overAnswer, hold(queryRepeatHold(VISITS, "count"))],
					NO_RECORDED_HOLDS,
				),
			).toEqual({ refusal: null, toJustify: [] });
		});
	});

	it("admits an editor restoring the recorded hold after a move", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, EDITOR_MOVED),
		);
		const batch = [hold(operationHold(formUuid, UPDATE, RECORDED))];
		expect(
			judge(doc, batch, recordedOf(operationHold(formUuid, UPDATE, RECORDED))),
		).toEqual({ refusal: null, toJustify: [opKey(formUuid, UPDATE)] });
	});

	it("admits an editor re-creating a removed target with its recorded hold", () => {
		const { doc, formUuid } = holdFixture(undefined, () => [
			{ uuid: OWN, id: "patient", action: "own" } as CaseOperation,
		]);
		const recreate = {
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: { operation: "add", value: update() },
		} as Mutation;
		const batch = [recreate, hold(operationHold(formUuid, UPDATE, RECORDED))];
		expect(
			judge(doc, batch, recordedOf(operationHold(formUuid, UPDATE, RECORDED))),
		).toEqual({ refusal: null, toJustify: [opKey(formUuid, UPDATE)] });
		// With no recording, the re-created hold is one the editor gains.
		expect(judge(doc, batch, NO_RECORDED_HOLDS).refusal).toBe(
			PLACEMENT_CHANGE_REFUSAL,
		);
	});

	it("refuses an editor restoring a hold the latest recording did not write", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, EDITOR_MOVED),
		);
		expect(
			judge(
				doc,
				[hold(operationHold(formUuid, UPDATE, RECORDED))],
				recordedOf(operationHold(formUuid, UPDATE, CONDITIONED)),
			),
		).toEqual({
			refusal: PLACEMENT_CHANGE_REFUSAL,
			toJustify: [opKey(formUuid, UPDATE)],
		});
	});

	it("refuses once for several targets, and names only the undecided keys", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, RECORDED),
		);
		expect(
			judge(
				doc,
				[
					addCondition(formUuid),
					hold(
						operationHold(formUuid, UPDATE, CONDITIONED),
						operationHold(formUuid, OWN, { kind: "basic", slot: "own" }),
						queryRepeatHold(VISITS, "count"),
					),
				],
				NO_RECORDED_HOLDS,
			),
		).toEqual({
			refusal: PLACEMENT_CHANGE_REFUSAL,
			// The move of UPDATE is decided; the two gains are not.
			toJustify: [opKey(formUuid, OWN), queryRepeatKey],
		});
	});
});
