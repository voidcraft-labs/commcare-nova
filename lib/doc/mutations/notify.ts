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
 * Takes already-rendered USER lines — each caller projects its findings
 * through `lib/doc/userFacingErrors.ts::userFacingError` before getting
 * here, so the toast and the caller's inline `CommitOutcome.messages`
 * speak the identical concise copy (the SA keeps the verbose
 * `ValidationError.message`; this surface never does). Pure presentation:
 * no validator types cross into this emitter.
 */
export function notifyRejectedCommit(lines: string[]): void {
	showToast("error", "Change not applied", undefined, { lines });
}
