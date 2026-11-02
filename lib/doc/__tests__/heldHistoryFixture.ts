/**
 * A builder store over the identity-move patient app with its follow-up and
 * close forms held as a publish records them, and the edits that move or
 * keep the follow-up's own case change. Shared by the store's history tests,
 * the history step's and the builder commands', so each reads the same
 * published app and the same recordings.
 */
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import {
	DISCHARGE,
	FOLLOWUP,
	holdPlanned,
	holdVisits,
	isOwn,
	moveFixture,
	operationOf,
	read,
} from "./placementMoveFixture";

export { FOLLOWUP, read };

/** The patient app as a publish left it: every follow-up and close
 *  placement held, and the query repeat held to model iteration. */
export function publishedDoc(): BlueprintDoc {
	const doc = holdVisits(moveFixture(), "model-iteration");
	for (const form of [FOLLOWUP, DISCHARGE]) holdPlanned(doc, form);
	return doc;
}

/** A live builder store over `doc`, tracking history, whose recordings are
 *  the holds `doc` carries. */
export function heldStore(doc: BlueprintDoc = publishedDoc()) {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.getState().startTracking();
	recordCurrentHolds(store);
	return store;
}

/** A publish recorded every hold the store's document carries now. */
export function recordCurrentHolds(store: BlueprintDocStoreApi): void {
	store
		.getState()
		.setRecordedPlacementHolds(new Map(readPlacementHolds(store.getState())));
}

/** The follow-up's own case change. */
export const ownOf = (doc: BlueprintDoc): Uuid =>
	operationOf(doc, FOLLOWUP, isOwn).uuid;

/** The follow-up saves `value` to `remark`. */
export const setRemark = (doc: BlueprintDoc, value: Expression): Mutation =>
	({
		kind: "updateForm",
		uuid: FOLLOWUP,
		patch: {},
		caseOperationPatch: {
			operation: "update-write",
			uuid: ownOf(doc),
			key: { property: "remark" },
			patch: { value },
		},
	}) as Mutation;

/** A calculation Case Management cannot save, which moves the own case
 *  change to Save to Case. */
export const COMPUTED_REMARK: Expression = concat(
	read("remark"),
	term(literal("!")),
);

/** The own case change's hold. */
export function ownHold(doc: BlueprintDoc): PlacementHoldEntry["placement"] {
	return operationOf(doc, FOLLOWUP, isOwn).placement ?? null;
}

/** The hold entries `batch` carries. */
export const holdEntries = (batch: readonly Mutation[]): PlacementHoldEntry[] =>
	batch.flatMap((m) => (m.kind === "holdPlacements" ? m.holds : []));

/**
 * Commit `edit` as one undo step with the moves the planner appends, as the
 * builder's dialog commits a stated move.
 */
export function commitWithMoves(
	store: BlueprintDocStoreApi,
	edit: readonly Mutation[],
): void {
	const state = store.getState();
	const plan = withIdentityMoves(state, edit, {
		recorded: state.recordedHolds,
	});
	const verdict = mutationCommitVerdict(
		state,
		plan.batch,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok)
		throw new Error(
			`The edit commits: ${verdict.findings.map((f) => f.message).join(" ")}`,
		);
	state.commitDoc(verdict.nextDoc, verdict.mutations);
}

/** A publish frame the tab folds: `holds` land outside the author's history. */
export function foldPublish(
	store: BlueprintDocStoreApi,
	holds: readonly PlacementHoldEntry[],
): void {
	const state = store.getState();
	state.beginRemoteApply();
	try {
		state.applyMany([{ kind: "holdPlacements", holds: [...holds] }]);
	} finally {
		state.endRemoteApply();
	}
	recordCurrentHolds(store);
}
