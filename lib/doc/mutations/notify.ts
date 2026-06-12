import { showToast } from "@/lib/ui/toastStore";
import type { MoveFieldResult } from "./fields";

/**
 * Show an info toast when a cross-level move auto-renamed a field to
 * avoid a sibling ID collision. No-op when the move didn't trigger dedup.
 */
export function notifyMoveRename(result: MoveFieldResult): void {
	if (!result.renamed) return;
	const { oldId, newId, xpathFieldsRewritten } = result.renamed;
	showToast(
		"info",
		"Field renamed to avoid conflict",
		`"${oldId}" → "${newId}" (${xpathFieldsRewritten} reference${xpathFieldsRewritten === 1 ? "" : "s"} updated)`,
	);
}

/**
 * Show the error toast for an edit the validity gate rejected — the
 * builder analog of the SA tools' `{ error }` envelope, used by dispatch
 * surfaces with NO contextual anchor to hang the rejection on (toggles,
 * deletes, drag moves). Call sites that render the returned outcome
 * beside the control (inline notices, editor tooltips, dialog footers)
 * dispatch through the `inline` flavor instead and never reach this.
 *
 * Each finding's `message` is the validator's own person-to-person
 * sentence (what's wrong, where it lives, what to look at); they ride
 * the toast's structured `lines` so each finding reads as its own row.
 * Typed against the message shape (not the validator's error type) so
 * this UI emitter stays outside the `@/lib/commcare` boundary.
 */
export function notifyRejectedCommit(
	introduced: ReadonlyArray<{ message: string }>,
): void {
	showToast("error", "Change not applied", undefined, {
		lines: introduced.map((err) => err.message),
	});
}
