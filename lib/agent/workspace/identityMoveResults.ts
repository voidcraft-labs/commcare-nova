/**
 * How the two workspace hosts carry identity moves: the staged sequence a
 * planned batch writes, the reports a tool result gives, and the merge of
 * those reports into the result a model reads.
 *
 * `lib/doc/identityMoves.ts::withIdentityMoves` appends at most one
 * `holdPlacements` to an edit's batch. A staged write keeps that entry in its
 * last stage, so the hold change lands in the same stage as the content that
 * needs it.
 */

import { identityMoveReport } from "@/lib/doc/identityMoveCopy";
import type { IdentityMove, IdentityMoveReport } from "@/lib/doc/identityMoves";
import type {
	AdmittedMutationBatch,
	AdmittedMutationStageSlice,
} from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";

/** Each move as a tool result states it, worded over the document the
 *  write produces. */
export function identityMoveReports(
	doc: BlueprintDoc,
	moves: readonly IdentityMove[],
): readonly IdentityMoveReport[] {
	return moves.map((move) => identityMoveReport(doc, move));
}

/**
 * The stage slices of `planned`, the batch the planner returned for
 * `original`. The planner returns the batch itself where nothing moves, or
 * the batch with one `holdPlacements` appended; the appended entry joins the
 * last stage. A tool batch carries no hold of its own, so any other shape
 * means the planner and the hosts no longer agree on what a plan is.
 */
export function plannedStageSlices(
	original: AdmittedMutationBatch,
	slices: readonly AdmittedMutationStageSlice[],
	planned: readonly unknown[],
): readonly AdmittedMutationStageSlice[] {
	if (planned === original) return slices;
	const appended =
		planned.length === original.length + 1 &&
		!original.some((mutation) => mutation.kind === "holdPlacements") &&
		(planned[planned.length - 1] as { kind?: unknown }).kind ===
			"holdPlacements";
	if (!appended)
		throw new Error(
			`The identity-move planner returned a batch of ${planned.length} edits for a tool batch of ${original.length}, and a plan only ever appends one held-placement change to a batch that holds none. The planner and the workspace hosts disagree on what a plan is.`,
		);
	const last = slices.at(-1);
	if (last === undefined) return slices;
	return [...slices.slice(0, -1), { ...last, end: last.end + 1 }];
}

/**
 * A tool's return with the invocation's moves added to the result a model
 * reads, as `identityMoves`. A result with no moves, a refusal, and a value
 * that is not a mutating tool's envelope are returned as they are.
 */
export function withIdentityMovesInResult<T>(
	value: T,
	moves: readonly IdentityMoveReport[],
): T {
	if (moves.length === 0) return value;
	if (value === null || typeof value !== "object") return value;
	const envelope = value as { kind?: unknown; result?: unknown };
	if (envelope.kind !== "mutate") return value;
	const result = envelope.result;
	if (result === null || typeof result !== "object" || Array.isArray(result))
		return value;
	if (typeof (result as { error?: unknown }).error === "string") return value;
	return {
		...value,
		result: { ...result, identityMoves: moves },
	};
}
