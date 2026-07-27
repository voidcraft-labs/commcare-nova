"use client";

import {
	useAccessPhase,
	useCanEdit,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import {
	type AttachmentEntryWriteAuthorityToken,
	captureAttachmentEntryWriteAuthority,
} from "./attachmentClient";

/**
 * Subscribe destructive form controls to the session signals that rotate the
 * attachment coordinator's entry authority.
 *
 * The session values drive prompt disabled-state updates, including a
 * refresh that is lost and restored in one React batch. The capability itself
 * still comes from the coordinator, so UI code cannot create a parallel
 * permission decision.
 */
export function useAttachmentEntryWriteAuthority(
	entryKey: string | undefined,
): AttachmentEntryWriteAuthorityToken | undefined {
	const scopeEpoch = useProjectScopeEpoch();
	const accessPhase = useAccessPhase();
	const canEdit = useCanEdit();

	if (entryKey === undefined || accessPhase !== "authorized" || !canEdit) {
		return undefined;
	}
	// Re-capture on every render. The controller's preview identity can resolve
	// after the session coordinates without changing any of this hook's scalar
	// inputs; memoizing those inputs would retain the earlier fail-closed token
	// even after FormScreen installed the complete authority tuple.
	return captureAttachmentEntryWriteAuthority(entryKey, scopeEpoch);
}
