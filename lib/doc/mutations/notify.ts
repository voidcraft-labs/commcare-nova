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
 * builder analog of the SA tools' `{ error }` envelope. Each finding's
 * `message` is the validator's own person-to-person sentence (what's
 * wrong, where it lives, what to look at); the toast body lists them one
 * per line so the user can fix the edit without guessing. Typed against
 * the message shape (not the validator's error type) so this UI emitter
 * stays outside the `@/lib/commcare` boundary.
 */
export function notifyRejectedCommit(
	introduced: ReadonlyArray<{ message: string }>,
): void {
	showToast(
		"error",
		"That change would break the app, so it wasn't applied",
		introduced.map((err) => err.message).join("\n"),
	);
}
