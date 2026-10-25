import { showActiveProjectToast } from "@/lib/ui/toastStore";

/**
 * Show the error toast for an edit the validity gate rejected — the
 * builder analog of the SA tools' `{ error }` envelope, used by dispatch
 * surfaces with NO contextual anchor to hang the rejection on (toggles,
 * deletes, drag moves). Call sites that render the returned outcome
 * beside the control (inline notices, editor tooltips, dialog footers)
 * dispatch through the `inline` flavor instead and never reach this.
 *
 * Takes already-rendered USER lines — each caller projects its findings
 * through `lib/doc/userFacingErrors.ts::userFacingError` before getting
 * here, so the toast and the caller's inline `CommitOutcome.messages`
 * speak the identical concise copy (the SA keeps the verbose
 * `ValidationError.message`; this surface never does). Pure presentation:
 * no validator types cross into this emitter.
 */
export function notifyRejectedCommit(lines: string[]): void {
	showActiveProjectToast("error", "Change not applied", undefined, { lines });
}

/** Announce automatic value preservation only after its batch commits. */
export function notifyPreservedChoices(count: number): void {
	showActiveProjectToast(
		"info",
		`Kept ${count} choice ${count === 1 ? "value" : "values"} in your rules.`,
	);
}

/** Announce a date-and-time split the planner or the gate refused, in the
 *  split's own words: what failed, then the first reason, which already
 *  names its next step. */
export function notifyRefusedSplit(message: string | undefined): void {
	showActiveProjectToast("error", "Nova couldn't split this question", message);
}
