/**
 * Identity moves: an edit that leaves a held identity (where a published
 * app keeps a case change, its own close, or a query repeat's record ids)
 * unable to stay where a publish recorded it moves that identity, and the
 * move is stated before it commits. This module is the one planner every
 * editor runs: the builder's dispatch and history, and the SA and MCP
 * workspaces.
 *
 * `withIdentityMoves` hands the candidate an edit produces to each move
 * source in order (menu kinds, then case operations and own closes, then
 * query repeats) and appends one `holdPlacements` carrying every entry they return, so the
 * commit gate and the commit kernel's placement rule see one batch that
 * moves exactly the holds it strands. `identityMovesBetween` states every
 * move between two documents, so a redo that re-applies a recorded move
 * states it too, and a restore of the hold a recording wrote states none.
 * `planConflictReplay` plans the edits a placement conflict handed back
 * over the reloaded document, as one batch.
 *
 * One of the allowlisted `lib/doc` consumers of `lib/commcare` in
 * `biome.json`: whether a held case placement still expresses its change is
 * `lib/commcare/placement.ts`'s answer, and whether a menu is emitted
 * advanced is `lib/commcare/moduleKind.ts`'s.
 */

import { produce } from "immer";
import { z } from "zod";
import {
	placementIneligibility,
	planPlacements,
} from "@/lib/commcare/placement";
import {
	type PreparedMutationCandidate,
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { documentHoldsIdentity } from "@/lib/doc/heldIdentity";
import {
	carriedCreateKindMoves,
	type ModuleKindMoveReason,
	moduleKindMove,
	planModuleKindMoves,
} from "@/lib/doc/moduleKindMoves";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import { applyHoldPlacements } from "@/lib/doc/mutations/placements";
import {
	admittedHoldChanges,
	holdChangeRestores,
	NO_RECORDED_HOLDS,
	type PlacementHoldChange,
	placementHoldChanges,
	placementHoldEntry,
	placementTargetKey,
	placementTargetOf,
	type RecordedPlacementHolds,
	withHeldPlacement,
} from "@/lib/doc/placementHolds";
import { planOperationPlacementMoves } from "@/lib/doc/placementMoves";
import { planQueryRepeatPlacementMoves } from "@/lib/doc/queryRepeatPlacement";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import {
	advancedKindBlockers,
	type BlueprintDoc,
	type CasePlacement,
	type PlacementIneligibility,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { formOfField } from "@/lib/domain/fieldForm";
import {
	type PlacementLabel,
	placementLabel,
} from "@/lib/domain/placementCopy";
import {
	type QueryRepeatNeed,
	queryRepeatPlacementNeeds,
} from "@/lib/domain/queryRepeatPlacement";

export { documentHoldsIdentity };

/** What an identity move is about. Every UUID is the entity's own. */
export type IdentityMoveSubject =
	| {
			readonly kind: "case-operation";
			readonly formUuid: Uuid;
			readonly operationUuid: Uuid;
	  }
	| { readonly kind: "own-close"; readonly formUuid: Uuid }
	| {
			readonly kind: "query-repeat";
			readonly formUuid: Uuid;
			readonly fieldUuid: Uuid;
	  }
	| { readonly kind: "module-kind"; readonly moduleUuid: Uuid };

/** Why a held identity can no longer stay where it is, in its owner's own
 *  reason ids: the first condition a case placement fails, the first thing
 *  model iteration cannot run for a query repeat, or why a menu's kind
 *  moves. */
export type IdentityMoveReason =
	| {
			readonly source: "case-placement";
			readonly reason: PlacementIneligibility;
	  }
	| { readonly source: "query-repeat"; readonly reason: QueryRepeatNeed }
	| {
			readonly source: "module-kind";
			readonly reason: ModuleKindMoveReason;
			/** The menu selects a parent case, so once its kind moves its
			 *  forms read the cases chosen through it under new names. */
			readonly chosenCasesRenamed: boolean;
	  };

export interface IdentityMove {
	readonly subject: IdentityMoveSubject;
	readonly from: PlacementLabel;
	readonly to: PlacementLabel;
	readonly reason: IdentityMoveReason;
}

export interface IdentityMovePlan {
	/** The edit's batch, with one `holdPlacements` appended where a move
	 *  needs it. */
	readonly batch: readonly Mutation[];
	/** Every move the batch's result makes, appended or carried by the
	 *  batch itself. */
	readonly moves: readonly IdentityMove[];
	/** The candidate of `batch` over the document, where planning prepared
	 *  one, for the caller's verdict to evaluate without preparing again.
	 *  Absent for a document that holds no identity, or a batch whose wire
	 *  shape admission refuses. */
	readonly prepared?: PreparedMutationCandidate;
}

export interface IdentityMoveOptions {
	/** The edit's candidate over the same document and batch, when the
	 *  caller has prepared it already. */
	readonly prepared?: PreparedMutationCandidate;
	/** The hold each target's latest recording wrote. A hold change back to
	 *  it returns the answers to where the published app keeps them, so it
	 *  is no move. */
	readonly recorded?: RecordedPlacementHolds;
}

/** One stated move, as a tool result carries it. */
export interface IdentityMoveReport {
	readonly subject: IdentityMoveSubject;
	/** `identityMoveCopy.ts::identityMoveSentence`. */
	readonly sentence: string;
}

export const identityMoveSubjectSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("case-operation"),
		formUuid: uuidSchema,
		operationUuid: uuidSchema,
	}),
	z.strictObject({ kind: z.literal("own-close"), formUuid: uuidSchema }),
	z.strictObject({
		kind: z.literal("query-repeat"),
		formUuid: uuidSchema,
		fieldUuid: uuidSchema,
	}),
	z.strictObject({ kind: z.literal("module-kind"), moduleUuid: uuidSchema }),
]);

export const identityMoveReportSchema = z.strictObject({
	subject: identityMoveSubjectSchema,
	sentence: z.string().min(1),
});

/**
 * The batch with every hold change its edit needs appended as one
 * `holdPlacements` mutation, and every identity the result moves. A
 * document that holds no identity returns the batch unchanged with no move.
 * Over a document that holds one, the candidate is prepared once (or taken
 * from `options.prepared`), each move source plans over the candidate the
 * earlier sources left, and the planned batch's own candidate is returned
 * for the verdict. A batch admission refuses is returned as it is: its
 * refusal is the gate's to give.
 */
export function withIdentityMoves(
	doc: BlueprintDoc,
	batch: readonly Mutation[],
	options: IdentityMoveOptions = {},
): IdentityMovePlan {
	if (!documentHoldsIdentity(doc))
		return {
			batch,
			moves: [],
			...(options.prepared !== undefined && { prepared: options.prepared }),
		};
	let prepared = options.prepared;
	if (prepared === undefined) {
		try {
			prepared = prepareMutationCandidate(doc, admitMutationBatch(batch));
		} catch (error) {
			if (error instanceof MutationWireCanonicalityError)
				return { batch, moves: [] };
			throw error;
		}
	}
	if (preparedCandidateHasAdmissionIssue(prepared))
		return { batch, moves: [], prepared };
	const recorded = options.recorded ?? NO_RECORDED_HOLDS;
	// A menu's kind decides which placements its forms can keep, so the
	// kind's entries are applied before the case changes are planned.
	const kinds = planModuleKindMoves(doc, prepared.nextDoc);
	const afterKinds = withHolds(prepared.nextDoc, kinds.holds);
	const operations = planOperationPlacementMoves(afterKinds);
	const afterOperations = withHolds(afterKinds, operations.holds);
	const repeats = planQueryRepeatPlacementMoves(afterOperations);
	const holds: PlacementHoldEntry[] = [
		...kinds.holds,
		...operations.holds,
		...repeats.holds,
	];
	if (holds.length === 0)
		return {
			batch,
			moves: identityMovesBetween(doc, prepared.nextDoc, { recorded }),
			prepared,
		};
	// Cloned before admission: an admitted batch's frozen values carry the
	// internal markers a fresh admission refuses as not canonical.
	const planned = admitMutationBatch(
		structuredClone([
			...withoutHoldsFor(batch, new Set(holds.map(placementTargetKey))),
			{ kind: "holdPlacements", holds },
		]),
	);
	const final = prepareMutationCandidate(doc, planned);
	return {
		batch: planned,
		moves: preparedCandidateHasAdmissionIssue(final)
			? [...kinds.moves, ...operations.moves, ...repeats.moves]
			: identityMovesBetween(doc, final.nextDoc, { recorded }),
		prepared: final,
	};
}

/** `doc` with `holds` applied; `doc` itself where there are none. */
function withHolds(
	doc: BlueprintDoc,
	holds: readonly PlacementHoldEntry[],
): BlueprintDoc {
	if (holds.length === 0) return doc;
	return produce(doc, (draft) => {
		applyHoldPlacements(draft, { kind: "holdPlacements", holds: [...holds] });
	});
}

/**
 * The edits a placement conflict handed back, planned again over the
 * reloaded document: `replay` holds one array per rejected human batch, in
 * the order they were made, then the queued commands' mutations
 * (`store.ts::queuedCommandMutations`) as one more array. They are joined
 * into one batch, which is offered as one edit; where two of them hold one
 * target, the later hold is the one kept, as applying them in turn would
 * leave it.
 *
 * Of the joined batch's hold changes, only a restore of the hold `recorded`
 * gives its target survives, and only where `admittedHoldChanges` admits it
 * over `doc`. Every other hold change either is one the commit kernel would
 * refuse (dropped, with the content beside it kept), or is a move planned
 * over the document the edit was composed on, whose destination a publish
 * may since have taken: `withIdentityMoves` plans every move the content
 * needs again over `doc`, so each move lands where `doc` leaves room. A
 * replay whose content strands no hold returns no move.
 *
 * A joined batch that mutation admission refuses (a batch-exclusive
 * command beside others) is returned as it is, with no move; its refusal
 * is the gate's to give.
 */
export function planConflictReplay(
	doc: BlueprintDoc,
	replay: readonly (readonly Mutation[])[],
	recorded: RecordedPlacementHolds,
): IdentityMovePlan {
	const joined = laterHoldsKept(replay.flat());
	let admitted: AdmittedMutationBatch;
	try {
		// Cloned before admission: an admitted batch's frozen values carry the
		// internal markers a fresh admission refuses as not canonical.
		admitted = admitMutationBatch(structuredClone(joined));
	} catch (error) {
		if (error instanceof MutationWireCanonicalityError)
			return { batch: joined, moves: [] };
		throw error;
	}
	const kept = admittedHoldChanges(doc, admitted, recorded);
	const restores = keepingRestores(kept, recorded);
	return withIdentityMoves(
		doc,
		restores === kept
			? kept
			: admitMutationBatch(structuredClone([...restores])),
		{ recorded },
	);
}

/** `mutations` with each hold entry a later entry of the same target
 *  replaces left out; a `holdPlacements` left with none is removed. */
function laterHoldsKept(mutations: readonly Mutation[]): Mutation[] {
	const seen = new Set<string>();
	const kept: Mutation[] = [];
	for (let index = mutations.length - 1; index >= 0; index--) {
		const mutation = mutations[index];
		if (mutation.kind !== "holdPlacements") {
			kept.push(mutation);
			continue;
		}
		const holds: PlacementHoldEntry[] = [];
		for (let at = mutation.holds.length - 1; at >= 0; at--) {
			const hold = mutation.holds[at];
			const key = placementTargetKey(hold);
			if (seen.has(key)) continue;
			seen.add(key);
			holds.unshift(hold);
		}
		if (holds.length === mutation.holds.length) kept.push(mutation);
		else if (holds.length > 0) kept.push({ kind: "holdPlacements", holds });
	}
	return kept.reverse();
}

/** `batch` keeping, of its hold entries, the restores of the hold `recorded`
 *  gives their target; `batch` itself where every entry is one. */
function keepingRestores(
	batch: AdmittedMutationBatch,
	recorded: RecordedPlacementHolds,
): readonly Mutation[] {
	const restores = (entry: PlacementHoldEntry) =>
		holdChangeRestores(
			{
				key: placementTargetKey(entry),
				target: placementTargetOf(entry),
				from: null,
				to: entry.placement,
			},
			recorded,
		);
	if (
		batch.every((m) => m.kind !== "holdPlacements" || m.holds.every(restores))
	)
		return batch;
	const kept: Mutation[] = [];
	for (const mutation of batch) {
		if (mutation.kind !== "holdPlacements") {
			kept.push(mutation);
			continue;
		}
		const holds = mutation.holds.filter(restores);
		if (holds.length > 0) kept.push({ kind: "holdPlacements", holds });
	}
	return kept;
}

/**
 * `batch` without its own hold entries for the targets in `keys`: the
 * planner's entry says where such a target goes once the edit has left the
 * batch's entry unable to keep it, and a batch holds each target once.
 */
function withoutHoldsFor(
	batch: readonly Mutation[],
	keys: ReadonlySet<string>,
): Mutation[] {
	const kept: Mutation[] = [];
	for (const mutation of batch) {
		if (mutation.kind !== "holdPlacements") {
			kept.push(mutation);
			continue;
		}
		const holds = mutation.holds.filter(
			(hold) => !keys.has(placementTargetKey(hold)),
		);
		if (holds.length === mutation.holds.length) kept.push(mutation);
		else if (holds.length > 0) kept.push({ kind: "holdPlacements", holds });
	}
	return kept;
}

/**
 * Every held identity `after` keeps in another place than `before` does,
 * with the reason the earlier place no longer expresses it: first each
 * published ordinary menu a carried create turns advanced (a kind change
 * with no hold of its own), then the hold changes in `before`'s document
 * order. A hold change is a move where the earlier hold cannot express its
 * target in `after`. A target `after` no longer holds is no move (its data
 * left with it), nor is an own close whose form stopped closing its case, a
 * first hold, or a change back to the hold the target's latest recording
 * wrote.
 */
export function identityMovesBetween(
	before: BlueprintDoc,
	after: BlueprintDoc,
	options: Pick<IdentityMoveOptions, "recorded"> = {},
): readonly IdentityMove[] {
	const recorded = options.recorded ?? NO_RECORDED_HOLDS;
	const moves: IdentityMove[] = [...carriedCreateKindMoves(before, after)];
	for (const change of placementHoldChanges(before, after)) {
		if (change.from === null || holdChangeRestores(change, recorded)) continue;
		const move = moveOfChange(after, change);
		if (move !== undefined) moves.push(move);
	}
	return moves;
}

function moveOfChange(
	after: BlueprintDoc,
	change: PlacementHoldChange,
): IdentityMove | undefined {
	const { target } = change;
	switch (target.target) {
		case "case-operation":
		case "own-close": {
			const from = change.from as CasePlacement;
			const subject =
				target.target === "own-close"
					? ({ kind: "own-close" } as const)
					: ({
							kind: "operation",
							operationUuid: target.operationUuid,
						} as const);
			// Read with the earlier hold back in its slot, as the commit kernel
			// reads whether a hold change moves it.
			const reading = withHeldPlacement(
				after,
				placementHoldEntry(target, change.from),
			);
			const [reason] = placementIneligibility(
				reading,
				target.formUuid,
				subject,
				from,
			);
			if (reason === undefined || reason.reason === "no-close") return;
			const to =
				(change.to as CasePlacement | null) ??
				planPlacements(after, target.formUuid).placements.get(
					subject.kind === "own-close" ? "own-close" : subject.operationUuid,
				)?.placement;
			if (to === undefined) return;
			return {
				subject:
					target.target === "own-close"
						? { kind: "own-close", formUuid: target.formUuid }
						: {
								kind: "case-operation",
								formUuid: target.formUuid,
								operationUuid: target.operationUuid,
							},
				from: placementLabel(from),
				to: placementLabel(to),
				reason: { source: "case-placement", reason },
			};
		}
		case "query-repeat": {
			// A held count runs every query repeat, so only model iteration
			// can be left unable to run one.
			if (change.from !== "model-iteration") return;
			const formUuid = formOfField(after, target.fieldUuid);
			const structure =
				formUuid === undefined ? undefined : formStructure(after, formUuid);
			if (formUuid === undefined || structure === undefined) return;
			const [need] = queryRepeatPlacementNeeds(structure, target.fieldUuid);
			if (need === undefined) return;
			return {
				subject: {
					kind: "query-repeat",
					formUuid,
					fieldUuid: target.fieldUuid,
				},
				from: "rows-set-when-opened",
				to: "rows-follow-query",
				reason: { source: "query-repeat", reason: need },
			};
		}
		case "module-kind": {
			// A held advanced kind moves only where a blocker keeps the menu
			// from staying advanced; the blockers do not read the hold.
			const [blocker] = advancedKindBlockers(after, target.moduleUuid);
			if (blocker === undefined) return;
			return moduleKindMove(after, target.moduleUuid, "basic", blocker.kind);
		}
	}
}
