import { builderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import {
	describeCommitFindings,
	mutationCommitVerdict,
	preparedCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { type IdentityMove, withIdentityMoves } from "@/lib/doc/identityMoves";
import type { LookupCommitState } from "@/lib/doc/lookupCommitContext";
import type { PendingIdentityMoveSlot } from "@/lib/doc/pendingIdentityMove";
import type { BlueprintDocState, HistoryAction } from "@/lib/doc/store";

/**
 * Collaborative undo/redo gate — the pure decision the hook runs before it
 * mutates.
 *
 * An undo is an ordinary edit: it applies the recorded step's inverse through
 * the same write path everything else uses, so it is gated the same way. A
 * peer's committed change can make that inverse reintroduce a validator finding
 * — restoring a field a peer's rename now collides with, say — so the gate runs
 * the batch against the doc on screen and refuses with the finding rather than
 * letting the PUT 409 into a conflict reload.
 *
 * Held placements meet the commit kernel's placement rule here as they do at
 * commit. The store keeps only the hold changes the rule admits over the holds
 * the latest recordings wrote (`historyStepBatch`): a restore of the recorded
 * hold, or a move the step's own content needs. The identity-move planner then
 * runs over that batch; a step that moves a held identity (a redo of a move, or
 * an undo whose content strands a hold a later publish recorded) is stated
 * before it applies, so it waits in the identity-move dialog and the cursor
 * stays where it was.
 *
 * `lookupContext` is the Project's lookup-definition context the builder
 * holds (`useLookupCommitState`). The gate is absolute: on a doc that carries
 * a lookup-backed select, an unavailable context refuses EVERY step, including
 * one that never touched the lookup, so the caller supplies the same context
 * every other builder write runs under — after `builderWriteAdmission` has
 * already refused a viewer, a catalog that is loading or failed, and a change
 * already waiting in the dialog.
 *
 * Pure of React + the store so it is exercised as a state model.
 */

export type HistoryStepResult =
	| { kind: "empty" }
	| { kind: "refused"; message: string }
	| {
			kind: "applied";
			/** A target's hold went back to where the published app keeps it. */
			restoredHold: boolean;
			/** A hold change the step carried was left out, since only a
			 *  publish records a new place. */
			droppedHoldChange: boolean;
	  }
	| {
			kind: "deferred";
			/** The moves the identity-move dialog states. */
			moves: readonly IdentityMove[];
	  };

/** A step that moves a held identity, with no session to state it in. */
const UNSTATED_MOVE_MESSAGE =
	"This step moves where CommCare HQ keeps some answers, and Nova can only make it once you have seen where they go. Open the app in the builder to make it.";

/** Execute history under the same admission and current-document verdict as
 * other edits. The browser supplies flushSync so restored nodes exist before
 * its scroll and highlight effects; ordinary state consumers commit directly. */
export function runHistoryStep(
	state: BlueprintDocState,
	action: HistoryAction,
	access: {
		canEdit: boolean;
		lookupCommitState: LookupCommitState;
		identityMoves?: PendingIdentityMoveSlot;
	},
	commit: (apply: () => void) => void = (apply) => apply(),
): HistoryStepResult {
	const step = state.historyStepBatch(action);
	if (step === undefined) return { kind: "empty" };
	const admission = builderWriteAdmission({
		canEdit: access.canEdit,
		lookupCommitState: access.lookupCommitState,
		identityMovePending: (access.identityMoves?.read() ?? null) !== null,
	});
	if (!admission.ok)
		return { kind: "refused", message: admission.messages.join(" ") };
	const lookupContext = access.lookupCommitState.lookupContext;
	const plan = withIdentityMoves(state, step.batch, {
		recorded: state.recordedHolds,
	});
	const verdict =
		plan.prepared === undefined
			? mutationCommitVerdict(state, plan.batch, lookupContext)
			: preparedCommitVerdictWithPrevalidation(
					state,
					plan.prepared,
					lookupContext,
				);
	if (!verdict.ok)
		return {
			kind: "refused",
			message: describeCommitFindings(verdict.findings),
		};
	if (plan.moves.length > 0) {
		if (access.identityMoves === undefined)
			return { kind: "refused", message: UNSTATED_MOVE_MESSAGE };
		access.identityMoves.set({
			batch: verdict.mutations,
			moves: plan.moves,
			origin: action,
		});
		return { kind: "deferred", moves: plan.moves };
	}
	let outcome: ReturnType<BlueprintDocState["applyHistoryStep"]>;
	commit(() => {
		outcome = state.applyHistoryStep(action, verdict.mutations);
	});
	return {
		kind: "applied",
		restoredHold: outcome?.restoredHold ?? false,
		droppedHoldChange:
			(outcome?.droppedHoldChange ?? false) || step.droppedHoldChange,
	};
}

/** The info toast a history step leaves about where CommCare HQ keeps the
 *  answers it touched, or `undefined` where it changed no held place. */
export function historyStepHoldNote(
	action: HistoryAction,
	result: { restoredHold: boolean; droppedHoldChange: boolean },
): { title: string; message: string } | undefined {
	const title = action === "undo" ? "Undone" : "Redone";
	if (result.droppedHoldChange)
		return {
			title,
			message:
				"CommCare HQ keeps these answers where your last publish put them, since only a publish records a new place.",
		};
	if (result.restoredHold)
		return {
			title,
			message: "These answers are back where your published app keeps them.",
		};
	return undefined;
}
