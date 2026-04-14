import { showToast } from "@/lib/services/toastStore";
import type { MoveQuestionResult } from "./questions";

/**
 * Show an info toast when a cross-level move auto-renamed a question to
 * avoid a sibling ID collision. No-op when the move didn't trigger dedup.
 */
export function notifyMoveRename(result: MoveQuestionResult): void {
	if (!result.renamed) return;
	const { oldId, newId, xpathFieldsRewritten } = result.renamed;
	showToast(
		"info",
		"Question renamed to avoid conflict",
		`"${oldId}" → "${newId}" (${xpathFieldsRewritten} reference${xpathFieldsRewritten === 1 ? "" : "s"} updated)`,
	);
}
