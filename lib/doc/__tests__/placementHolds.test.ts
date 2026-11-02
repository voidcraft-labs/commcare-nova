/**
 * The held placements of a document and who may change one. The plausible
 * failures: a reader that lists holds out of document order or under the
 * wrong key (the kernel and the tab's recorded holds are keyed alike), a
 * `holdExpresses` that answers differently from the gate's own predicate (so
 * the kernel would admit a move the gate calls needless, or refuse one it
 * needs), and an `admittedHoldChanges` that keeps a hold change the kernel
 * refuses, or drops the restore or the move it admits.
 */
import { describe, expect, it } from "vitest";
import {
	placementCandidates,
	placementExpresses,
} from "@/lib/commcare/placement";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	admittedHoldChanges,
	holdExpresses,
	NO_RECORDED_HOLDS,
	type PlacementHold,
	placementHoldChanges,
	placementTargetKey,
	readPlacementHolds,
} from "@/lib/doc/placementHolds";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	OwnClosePlacement,
	Uuid,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { queryRepeatPlacementExpresses } from "@/lib/domain/queryRepeatPlacement";
import {
	holdFixture,
	OWN,
	operationHold,
	ownCloseAt,
	ownCloseHold,
	PATIENTS_NAMED,
	queryRepeatHold,
	read,
	saveToCase,
	UPDATE,
	update,
	VISITS,
} from "./placementHoldFixture";

function operation(doc: BlueprintDoc, formUuid: Uuid, uuid: Uuid) {
	const found = doc.forms[formUuid].caseOperations?.find(
		(op) => op.uuid === uuid,
	);
	if (found === undefined) throw new Error(`The fixture holds ${uuid}.`);
	return found;
}

function holdOn(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
	placement: CaseOperation["placement"],
): void {
	const op = operation(doc, formUuid, uuid);
	if (placement === undefined) delete op.placement;
	else op.placement = placement;
}

const hold = (...holds: PlacementHoldEntry[]): Mutation => ({
	kind: "holdPlacements",
	holds,
});

function recordedOf(...holds: PlacementHold[]) {
	return new Map(holds.map((h) => [placementTargetKey(h), h]));
}

function holdEntries(batch: readonly Mutation[]): PlacementHoldEntry[] {
	return batch.flatMap((m) => (m.kind === "holdPlacements" ? m.holds : []));
}

describe("readPlacementHolds", () => {
	it("lists every held slot in document order under its key", () => {
		const { doc, formUuid } = holdFixture((d, form) => {
			holdOn(d, form, UPDATE, saveToCase("nova_operations", "upd"));
			holdOn(d, form, OWN, { kind: "basic", slot: "own" });
			d.forms[form].ownClosePlacement = ownCloseAt("nova_close");
			d.fields[VISITS] = { ...d.fields[VISITS], placement: "count" } as never;
			// A form of the next menu holds an own close too.
			const kidSurvey = d.formOrder[d.moduleOrder[1]][0];
			d.forms[kidSurvey].ownClosePlacement = ownCloseAt("kid_close");
		});
		const kidSurvey = doc.formOrder[doc.moduleOrder[1]][0];
		expect([...readPlacementHolds(doc)]).toEqual([
			[
				`case-operation:${formUuid}:${OWN}`,
				operationHold(formUuid, OWN, { kind: "basic", slot: "own" }),
			],
			[
				`case-operation:${formUuid}:${UPDATE}`,
				operationHold(formUuid, UPDATE, saveToCase("nova_operations", "upd")),
			],
			[
				`own-close:${formUuid}`,
				ownCloseHold(formUuid, ownCloseAt("nova_close")),
			],
			[`query-repeat:${VISITS}`, queryRepeatHold(VISITS, "count")],
			[
				`own-close:${kidSurvey}`,
				ownCloseHold(kidSurvey, ownCloseAt("kid_close")),
			],
		]);
	});

	it("lists nothing for a document no publish has held", () => {
		expect(readPlacementHolds(holdFixture().doc).size).toBe(0);
	});
});

describe("holdExpresses", () => {
	it("answers what Case Management's and Save to Case's predicate answers", () => {
		const held = saveToCase("nova_operations", "upd");
		const plain = holdFixture();
		// A condition wraps the block in a group, so the held path no longer
		// names the block.
		const conditioned = holdFixture(undefined, () => [
			{ uuid: OWN, id: "patient", action: "own" } as CaseOperation,
			update({ condition: read("flag") }),
		]);
		const answers = [plain, conditioned].map(({ doc, formUuid }) => {
			const entry = operationHold(formUuid, UPDATE, held);
			const owner = placementExpresses(
				doc,
				formUuid,
				{ kind: "operation", operationUuid: UPDATE },
				held,
			);
			expect(holdExpresses(doc, entry)).toBe(owner);
			return owner;
		});
		expect(answers).toEqual([true, false]);
	});

	it("answers what the own close's predicate answers", () => {
		const closing = holdFixture(undefined, undefined, "close");
		const [candidate] = placementCandidates(closing.doc, closing.formUuid, {
			kind: "own-close",
		});
		if (candidate?.kind !== "save-to-case")
			throw new Error("A close form's own close has a Save to Case place.");
		const held: OwnClosePlacement = {
			kind: "save-to-case",
			path: candidate.path,
		};
		const wrongShape: OwnClosePlacement = {
			kind: "save-to-case",
			path: [...candidate.path, "extra"],
		};
		// A follow-up form closes no case, so no own close can be held there.
		const followup = holdFixture();
		const answers = [
			[closing, held],
			[closing, wrongShape],
			[followup, held],
		].map(([fixture, placement]) => {
			const { doc, formUuid } = fixture as typeof closing;
			const owner = placementExpresses(
				doc,
				formUuid,
				{ kind: "own-close" },
				placement as OwnClosePlacement,
			);
			expect(
				holdExpresses(
					doc,
					ownCloseHold(formUuid, placement as OwnClosePlacement),
				),
			).toBe(owner);
			return owner;
		});
		expect(answers).toEqual([true, false, false]);
	});

	it("answers what the query repeat's predicate answers", () => {
		const overAnswer = holdFixture((d) => {
			const field = d.fields[VISITS];
			if (field.kind !== "repeat" || field.repeat_mode !== "query_bound")
				throw new Error("The fixture's visits is a query repeat.");
			d.fields[VISITS] = {
				...field,
				data_source: { ...field.data_source, ids_query: PATIENTS_NAMED },
			};
		});
		const answers = [holdFixture(), overAnswer].flatMap(({ doc, formUuid }) =>
			(["model-iteration", "count"] as const).map((placement) => {
				const structure = formStructure(doc, formUuid);
				if (structure === undefined) throw new Error("The form exists.");
				const owner = queryRepeatPlacementExpresses(
					structure,
					VISITS,
					placement,
				);
				expect(holdExpresses(doc, queryRepeatHold(VISITS, placement))).toBe(
					owner,
				);
				return owner;
			}),
		);
		expect(answers).toEqual([true, true, false, true]);
	});
});

describe("admittedHoldChanges", () => {
	const RECORDED = saveToCase("nova_operations", "upd");
	const EDITOR_MOVED = saveToCase("nova_operations", "moved_upd");
	const CONDITIONED = saveToCase(
		"nova_operations",
		"nova_condition_upd",
		"upd",
	);
	const addCondition: Mutation = {
		kind: "updateForm",
		uuid: "" as Uuid,
		patch: {},
		caseOperationPatch: {
			operation: "update",
			uuid: UPDATE,
			targetAction: "update",
			patch: { condition: read("flag") },
		},
	} as Mutation;
	const withForm = (m: Mutation, formUuid: Uuid): Mutation =>
		({ ...m, uuid: formUuid }) as Mutation;

	it("keeps an exact restore of the recorded hold", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, EDITOR_MOVED),
		);
		const restore = operationHold(formUuid, UPDATE, RECORDED);
		const batch = admitMutationBatch([hold(restore)]);
		const kept = admittedHoldChanges(
			doc,
			batch,
			recordedOf({ ...restore, placement: RECORDED } as PlacementHold),
		);
		expect(holdEntries(kept)).toEqual([restore]);
	});

	it("keeps a move of a hold the batch strands", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, RECORDED),
		);
		const move = operationHold(formUuid, UPDATE, CONDITIONED);
		const batch = admitMutationBatch([
			withForm(addCondition, formUuid),
			hold(move),
		]);
		const kept = admittedHoldChanges(doc, batch, NO_RECORDED_HOLDS);
		expect(holdEntries(kept)).toEqual([move]);
		expect(kept.length).toBe(2);
	});

	it("drops a restore of an unrecorded hold and keeps the content", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, EDITOR_MOVED),
		);
		// The editor's move is taken back to a hold no recording wrote, which
		// still expresses the change.
		const batch = admitMutationBatch([
			hold(operationHold(formUuid, UPDATE, RECORDED)),
		]);
		expect(
			holdEntries(admittedHoldChanges(doc, batch, NO_RECORDED_HOLDS)),
		).toEqual([]);
		// A recording that wrote another hold is no recording of this one.
		expect(
			holdEntries(
				admittedHoldChanges(
					doc,
					batch,
					recordedOf(
						operationHold(formUuid, UPDATE, CONDITIONED) as PlacementHold,
					),
				),
			),
		).toEqual([]);
		const content = withForm(addCondition, formUuid);
		const withContent = admitMutationBatch([
			content,
			hold(operationHold(formUuid, UPDATE, EDITOR_MOVED)),
		]);
		const kept = admittedHoldChanges(doc, withContent, NO_RECORDED_HOLDS);
		expect(kept).toEqual([content]);
	});

	it("drops a replacement of an expressible hold", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, RECORDED),
		);
		const recorded = recordedOf(
			operationHold(formUuid, UPDATE, RECORDED) as PlacementHold,
		);
		for (const placement of [EDITOR_MOVED, null]) {
			const batch = admitMutationBatch([
				hold(operationHold(formUuid, UPDATE, placement)),
			]);
			expect(holdEntries(admittedHoldChanges(doc, batch, recorded))).toEqual(
				[],
			);
		}
	});

	it("drops a hold that sets what is already held", () => {
		const { doc, formUuid } = holdFixture((d, form) =>
			holdOn(d, form, UPDATE, RECORDED),
		);
		const batch = admitMutationBatch([
			hold(operationHold(formUuid, UPDATE, RECORDED)),
		]);
		expect(
			holdEntries(
				admittedHoldChanges(
					doc,
					batch,
					recordedOf(
						operationHold(formUuid, UPDATE, RECORDED) as PlacementHold,
					),
				),
			),
		).toEqual([]);
	});

	it("keeps exactly the hold changes the kernel's per-change rule admits", () => {
		const { doc, formUuid } = holdFixture((d, form) => {
			holdOn(d, form, UPDATE, RECORDED);
			d.fields[VISITS] = {
				...d.fields[VISITS],
				placement: "model-iteration",
			} as never;
		});
		const batch = admitMutationBatch([
			withForm(addCondition, formUuid),
			hold(
				operationHold(formUuid, UPDATE, CONDITIONED),
				// Model iteration still runs the repeat, so nothing moves it.
				queryRepeatHold(VISITS, "count"),
			),
		]);
		const kept = admittedHoldChanges(doc, batch, NO_RECORDED_HOLDS);
		expect(holdEntries(kept)).toEqual([
			operationHold(formUuid, UPDATE, CONDITIONED),
		]);
		// The kept batch's candidate changes exactly the admitted hold.
		const next = prepareMutationCandidate(doc, kept).nextDoc;
		expect(placementHoldChanges(doc, next).map((c) => c.key)).toEqual([
			`case-operation:${formUuid}:${UPDATE}`,
		]);
	});
});
