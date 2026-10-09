"use client";

import { useCallback, useRef } from "react";
import {
	useAccessPhase,
	useProjectCanEdit,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { useOptionalBuilderSessionApi } from "@/lib/session/provider";

/** Files belong to a Project. The initial-build blueprint lock never changes
 * file authority. Standalone surfaces supply their server-resolved permission;
 * inside a builder the live session is always authoritative. */
export function useMediaAuthority(standaloneCanManageFiles?: boolean) {
	const session = useOptionalBuilderSessionApi();
	const accessPhase = useAccessPhase();
	const projectCanEdit = useProjectCanEdit();
	const scopeEpoch = useProjectScopeEpoch();
	const standalonePermission = useRef(standaloneCanManageFiles === true);
	standalonePermission.current = standaloneCanManageFiles === true;

	const ownsScope = useCallback(
		(epoch = scopeEpoch) => {
			const current = session?.getState();
			return current
				? current.accessPhase === "authorized" && current.scopeEpoch === epoch
				: epoch === scopeEpoch;
		},
		[session, scopeEpoch],
	);
	const mayManageFiles = useCallback(
		(epoch = scopeEpoch) =>
			ownsScope(epoch) &&
			(session
				? session.getState().projectCanEdit
				: standalonePermission.current),
		[ownsScope, scopeEpoch, session],
	);

	return {
		canManageFiles:
			accessPhase === "authorized" &&
			(session ? projectCanEdit : standaloneCanManageFiles === true),
		ownsScope,
		mayManageFiles,
	};
}
