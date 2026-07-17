"use client";

import { useCallback } from "react";
import { useLocation, useNavigate } from "@/lib/routing/hooks";

/**
 * Wrap the session's preview setter with the one URL transition preview mode
 * owns. A case-record URL is a running-app location with no authoring canvas;
 * every exit path (button, Escape, or P) must return to Results before turning
 * preview off, or the record deep-link synchronizer will immediately turn it
 * back on.
 */
export function usePreviewModeTransition(
	setPreviewing: (on: boolean) => void,
): (on: boolean) => void {
	const loc = useLocation();
	const navigate = useNavigate();
	return useCallback(
		(on: boolean) => {
			if (!on && loc.kind === "cases" && loc.caseId !== undefined) {
				navigate.replace({ kind: "cases", moduleUuid: loc.moduleUuid });
			}
			setPreviewing(on);
		},
		[loc, navigate, setPreviewing],
	);
}
