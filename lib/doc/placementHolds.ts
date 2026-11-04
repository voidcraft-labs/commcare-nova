// lib/doc/placementHolds.ts
//
// The held placements of a document, as every reader of them names them: a
// case operation's `placement`, a form's `ownClosePlacement`, and a query
// repeat's `placement`. `holdPlacements` is the one mutation that writes
// them (`mutations/placements.ts`), and who may change one is decided over
// two documents and the recordings: an editor's change is admitted where the
// batch leaves the earlier hold unable to express its target (a move), or
// where it restores exactly the hold the target's latest recording wrote.
// The per-change decision here is the one the client's history and the
// commit kernel's placement rule both read, so the two cannot disagree.
//
// Whether a hold can express its target is each owner's predicate: Case
// Management and Save to Case placements are `lib/commcare/placement.ts`'s,
// a query repeat's is `lib/domain/queryRepeatPlacement.ts`'s. This is one of
// the allowlisted `lib/doc` consumers of `lib/commcare` in `biome.json`.

import { produce } from "immer";
import { placementExpresses } from "@/lib/commcare/placement";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { deepEqual } from "@/lib/doc/deepEqual";
import { orderedFieldUuids, orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";
import { applyHoldPlacements } from "@/lib/doc/mutations/placements";
import {
	type Mutation,
	type PlacementHoldEntry,
	placementTargetKey,
} from "@/lib/doc/types";
import { type BlueprintDoc, ownRecordValue, type Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { formOfField } from "@/lib/domain/fieldForm";
import { queryRepeatPlacementExpresses } from "@/lib/domain/queryRepeatPlacement";

export type { PlacementHoldEntry };
export { placementTargetKey };

/** What a held placement belongs to. */
export type PlacementTarget =
	| {
			readonly target: "case-operation";
			readonly formUuid: Uuid;
			readonly operationUuid: Uuid;
	  }
	| { readonly target: "own-close"; readonly formUuid: Uuid }
	| { readonly target: "query-repeat"; readonly fieldUuid: Uuid };

/** A `PlacementHoldEntry` that holds a placement rather than clearing one. */
export type PlacementHold = PlacementHoldEntry & {
	readonly placement: NonNullable<PlacementHoldEntry["placement"]>;
};

/** A held value of any target, or `null` for none. */
export type HeldPlacementValue = PlacementHoldEntry["placement"];

/** The hold each target's latest recording wrote, keyed by target key; a
 *  target no recording holds is absent. */
export type RecordedPlacementHolds = ReadonlyMap<string, PlacementHold>;

export const NO_RECORDED_HOLDS: RecordedPlacementHolds = new Map();

/** The finding codes that mean a held placement no longer expresses its
 *  target: an operation's or an own close's, and a query repeat's. */
export const PLACEMENT_CONFLICT_CODES: ReadonlySet<string> = new Set([
	"HELD_PLACEMENT_INEXPRESSIBLE",
	"QUERY_REPEAT_MODEL_ITERATION_SHAPE",
]);

/** The target an entry names, without its placement. */
export function placementTargetOf(entry: PlacementTarget): PlacementTarget {
	switch (entry.target) {
		case "case-operation":
			return {
				target: "case-operation",
				formUuid: entry.formUuid,
				operationUuid: entry.operationUuid,
			};
		case "own-close":
			return { target: "own-close", formUuid: entry.formUuid };
		case "query-repeat":
			return { target: "query-repeat", fieldUuid: entry.fieldUuid };
	}
}

/** `target` holding `placement`, as one `holdPlacements` entry. */
export function placementHoldEntry(
	target: PlacementTarget,
	placement: HeldPlacementValue,
): PlacementHoldEntry {
	switch (target.target) {
		case "case-operation":
			return {
				...target,
				placement: placement as Extract<
					PlacementHoldEntry,
					{ target: "case-operation" }
				>["placement"],
			};
		case "own-close":
			return {
				...target,
				placement: placement as Extract<
					PlacementHoldEntry,
					{ target: "own-close" }
				>["placement"],
			};
		case "query-repeat":
			return {
				...target,
				placement: placement as Extract<
					PlacementHoldEntry,
					{ target: "query-repeat" }
				>["placement"],
			};
	}
}

function queryRepeatField(doc: BlueprintDoc, fieldUuid: Uuid) {
	const field = ownRecordValue(doc.fields, fieldUuid);
	return field?.kind === "repeat" && field.repeat_mode === "query_bound"
		? field
		: undefined;
}

/** Whether the target still exists in the document. A query repeat that
 *  stopped being a query repeat is gone as a target. */
export function placementTargetExists(
	doc: BlueprintDoc,
	target: PlacementTarget,
): boolean {
	switch (target.target) {
		case "case-operation":
			return (
				ownRecordValue(doc.forms, target.formUuid)?.caseOperations?.some(
					(op) => op.uuid === target.operationUuid,
				) === true
			);
		case "own-close":
			return ownRecordValue(doc.forms, target.formUuid) !== undefined;
		case "query-repeat":
			return queryRepeatField(doc, target.fieldUuid) !== undefined;
	}
}

/** What the target holds in the document, `null` for none or for a target
 *  the document does not hold. */
export function heldPlacementOf(
	doc: BlueprintDoc,
	target: PlacementTarget,
): HeldPlacementValue {
	switch (target.target) {
		case "case-operation":
			return (
				ownRecordValue(doc.forms, target.formUuid)?.caseOperations?.find(
					(op) => op.uuid === target.operationUuid,
				)?.placement ?? null
			);
		case "own-close":
			return (
				ownRecordValue(doc.forms, target.formUuid)?.ownClosePlacement ?? null
			);
		case "query-repeat":
			return queryRepeatField(doc, target.fieldUuid)?.placement ?? null;
	}
}

const holdsByDoc = new WeakMap<
	BlueprintDoc,
	ReadonlyMap<string, PlacementHold>
>();

/**
 * Every held slot of the document, keyed by target key, in document order:
 * modules in `moduleOrder`, their forms in `formOrder`, and for each form its
 * operations in array order, its own close, then its query repeats in field
 * order. Memoized per document object.
 */
export function readPlacementHolds(
	doc: BlueprintDoc,
): ReadonlyMap<string, PlacementHold> {
	const cached = holdsByDoc.get(doc);
	if (cached !== undefined) return cached;
	const holds = new Map<string, PlacementHold>();
	const add = (hold: PlacementHold) =>
		holds.set(placementTargetKey(hold), hold);
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of orderedFormUuids(doc, moduleUuid)) {
			const form = ownRecordValue(doc.forms, formUuid);
			if (form === undefined) continue;
			for (const operation of form.caseOperations ?? []) {
				if (operation.placement === undefined) continue;
				add({
					target: "case-operation",
					formUuid,
					operationUuid: operation.uuid,
					placement: operation.placement,
				});
			}
			if (form.ownClosePlacement !== undefined)
				add({
					target: "own-close",
					formUuid,
					placement: form.ownClosePlacement,
				});
			const walk = (parentUuid: Uuid): void => {
				for (const fieldUuid of orderedFieldUuids(doc, parentUuid)) {
					const field = ownRecordValue(doc.fields, fieldUuid);
					if (field === undefined) continue;
					if (
						field.kind === "repeat" &&
						field.repeat_mode === "query_bound" &&
						field.placement !== undefined
					)
						add({
							target: "query-repeat",
							fieldUuid,
							placement: field.placement,
						});
					walk(fieldUuid);
				}
			};
			walk(formUuid);
		}
	}
	holdsByDoc.set(doc, holds);
	return holds;
}

/**
 * Whether `entry`'s placement can express its target as `doc` holds it, by
 * the predicate the target's owner and its gate rule read. A cleared entry
 * holds nothing to express, so it expresses; a target the document does not
 * hold cannot be expressed.
 */
export function holdExpresses(
	doc: BlueprintDoc,
	entry: PlacementHoldEntry,
): boolean {
	if (entry.placement === null) return true;
	if (!placementTargetExists(doc, entry)) return false;
	switch (entry.target) {
		case "case-operation":
			return placementExpresses(
				doc,
				entry.formUuid,
				{ kind: "operation", operationUuid: entry.operationUuid },
				entry.placement,
			);
		case "own-close":
			return placementExpresses(
				doc,
				entry.formUuid,
				{ kind: "own-close" },
				entry.placement,
			);
		case "query-repeat": {
			const formUuid = formOfField(doc, entry.fieldUuid);
			const structure =
				formUuid === undefined ? undefined : formStructure(doc, formUuid);
			if (structure === undefined) return false;
			return queryRepeatPlacementExpresses(
				structure,
				entry.fieldUuid,
				entry.placement,
			);
		}
	}
}

/** `doc` with `entry`'s target holding `entry`'s placement, and nothing else
 *  changed. */
export function withHeldPlacement(
	doc: BlueprintDoc,
	entry: PlacementHoldEntry,
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyHoldPlacements(draft, { kind: "holdPlacements", holds: [entry] });
	});
}

// ─── Who may change a held placement ──────────────────────────────────────

/** One target whose held value differs between two documents. */
export interface PlacementHoldChange {
	readonly key: string;
	readonly target: PlacementTarget;
	/** The earlier document's hold, `null` for none. */
	readonly from: HeldPlacementValue;
	/** The later document's hold, `null` for none. */
	readonly to: HeldPlacementValue;
}

/**
 * Every target whose hold `next` changes from `prev`, in `prev`'s document
 * order and then `next`'s. A target `prev` holds and `next` no longer has
 * (its owner was removed, or a repeat stopped being a query repeat) is not a
 * change, and neither is an equal value.
 */
export function placementHoldChanges(
	prev: BlueprintDoc,
	next: BlueprintDoc,
): readonly PlacementHoldChange[] {
	const prevHolds = readPlacementHolds(prev);
	const nextHolds = readPlacementHolds(next);
	const changes: PlacementHoldChange[] = [];
	const consider = (key: string, hold: PlacementHold): void => {
		const target = placementTargetOf(hold);
		if (!placementTargetExists(next, target)) return;
		const from = prevHolds.get(key)?.placement ?? null;
		const to = nextHolds.get(key)?.placement ?? null;
		if (deepEqual(from, to)) return;
		changes.push({ key, target, from, to });
	};
	for (const [key, hold] of prevHolds) consider(key, hold);
	for (const [key, hold] of nextHolds) {
		if (!prevHolds.has(key)) consider(key, hold);
	}
	return changes;
}

/**
 * Arm (a), a move: `prev` held a placement and the rest of the batch left it
 * unable to express its target, so the batch moved it. Read on `next` with
 * this target's slot set back to the earlier hold.
 */
export function holdChangeMoves(
	next: BlueprintDoc,
	change: PlacementHoldChange,
): boolean {
	if (change.from === null) return false;
	const earlier = placementHoldEntry(change.target, change.from);
	return !holdExpresses(withHeldPlacement(next, earlier), earlier);
}

/**
 * Arm (b), a restore: `next` holds exactly the hold the target's latest
 * recording wrote. A target no recording holds has no hold to restore.
 */
export function holdChangeRestores(
	change: PlacementHoldChange,
	recorded: RecordedPlacementHolds,
): boolean {
	const hold = recorded.get(change.key);
	return (
		hold !== undefined &&
		change.to !== null &&
		deepEqual(change.to, hold.placement)
	);
}

/** Whether an editor's batch may make `change`: a move (arm a) or a restore
 *  of the recorded hold (arm b). Every other hold change is refused. */
export function holdChangeAdmitted(
	next: BlueprintDoc,
	change: PlacementHoldChange,
	recorded: RecordedPlacementHolds,
): boolean {
	return holdChangeRestores(change, recorded) || holdChangeMoves(next, change);
}

// ─── Batches ──────────────────────────────────────────────────────────────

function admitted(mutations: readonly Mutation[]): AdmittedMutationBatch {
	return admitMutationBatch(structuredClone([...mutations]));
}

/** A batch without its `holdPlacements` mutations. */
export function withoutPlacementHolds(
	batch: AdmittedMutationBatch,
): AdmittedMutationBatch {
	if (!batch.some((m) => m.kind === "holdPlacements")) return batch;
	return admitted(batch.filter((m) => m.kind !== "holdPlacements"));
}

/** `batch` keeping, of its hold entries, those `keep` accepts; a
 *  `holdPlacements` left with none is removed. */
function keepingHoldEntries(
	batch: readonly Mutation[],
	keep: (entry: PlacementHoldEntry) => boolean,
): Mutation[] {
	const kept: Mutation[] = [];
	for (const mutation of batch) {
		if (mutation.kind !== "holdPlacements") {
			kept.push(mutation);
			continue;
		}
		const holds = mutation.holds.filter(keep);
		if (holds.length === 0) continue;
		kept.push(
			holds.length === mutation.holds.length
				? mutation
				: { kind: "holdPlacements", holds },
		);
	}
	return kept;
}

/**
 * The client half of the commit kernel's rule for an editor's batch: `batch`
 * keeping each `holdPlacements` entry only where the kernel would admit the
 * change it makes over `doc`. An entry is kept where it restores exactly the
 * hold `recorded` gives its target (arm b), or where the batch's other
 * content leaves the target's current hold unable to express it (arm a). An
 * entry that sets the hold already held, or names a target the batch leaves
 * absent, changes nothing and is dropped. A `holdPlacements` left with no
 * entries is removed.
 *
 * Each verdict is read on the candidate of the batch as kept so far, and the
 * batch is judged again whenever an entry is dropped, so every entry kept is
 * admitted over the candidate the returned batch makes. A batch that target
 * admission refuses whole, its content included, is returned as it is: its
 * refusal is the gate's to give.
 */
export function admittedHoldChanges(
	doc: BlueprintDoc,
	batch: AdmittedMutationBatch,
	recorded: RecordedPlacementHolds,
): AdmittedMutationBatch {
	if (!batch.some((m) => m.kind === "holdPlacements")) return batch;
	let kept: readonly Mutation[] = batch;
	let candidate = prepareMutationCandidate(doc, batch);
	if (candidate.targetAdmissionIssue === true) {
		// A hold whose target the batch leaves absent is refused by target
		// admission; the content alone says which targets are left.
		const content = prepareMutationCandidate(doc, withoutPlacementHolds(batch));
		if (content.targetAdmissionIssue === true) return batch;
		kept = keepingHoldEntries(kept, (entry) =>
			placementTargetExists(content.nextDoc, entry),
		);
		const next = admitted(kept);
		candidate = prepareMutationCandidate(doc, next);
		if (candidate.targetAdmissionIssue === true) return batch;
	}
	for (;;) {
		const next = candidate.nextDoc;
		let dropped = false;
		const survivors = keepingHoldEntries(kept, (entry) => {
			const target = placementTargetOf(entry);
			const change: PlacementHoldChange = {
				key: placementTargetKey(target),
				target,
				from: placementTargetExists(doc, target)
					? heldPlacementOf(doc, target)
					: null,
				to: entry.placement,
			};
			const keep =
				placementTargetExists(next, target) &&
				!deepEqual(change.from, change.to) &&
				holdChangeAdmitted(next, change, recorded);
			if (!keep) dropped = true;
			return keep;
		});
		if (!dropped) return kept === batch ? batch : admitted(kept);
		kept = survivors;
		if (!kept.some((m) => m.kind === "holdPlacements")) return admitted(kept);
		candidate = prepareMutationCandidate(doc, admitted(kept));
	}
}
