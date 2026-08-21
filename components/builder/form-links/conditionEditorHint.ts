// components/builder/form-links/conditionEditorHint.ts
//
// A one-shot hand-off from the list to the detail: "this link was just
// added, open its condition editor on arrival". A fresh conditional link
// is seeded with `false()`, and the whole point of landing on its detail
// is to replace that, so the editor should already be open.
//
// The hint is not document state (a peer must not see an editor open) and
// not URL state (a refresh must not reopen it), so it lives in this
// module for exactly one detail. The detail reads it while rendering
// (`peek`, pure, so a repeated render initializer agrees with itself) and
// clears it once mounted (`clear`, an effect); after that it is gone.

import type { Uuid } from "@/lib/doc/types";

let pending: Uuid | undefined;

/** Ask the next detail for `uuid` to open with its condition editor. */
export function requestConditionEditorOpen(uuid: Uuid): void {
	pending = uuid;
}

/** Whether the detail for `uuid` was asked to open its editor. Pure. */
export function peekConditionEditorOpen(uuid: Uuid): boolean {
	return pending === uuid;
}

/** Retire the ask for `uuid` once its detail has taken it. */
export function clearConditionEditorOpen(uuid: Uuid): void {
	if (pending === uuid) pending = undefined;
}
