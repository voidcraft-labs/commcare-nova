"use client";

import { useCallback } from "react";
import { useLocation, useNavigate } from "@/lib/routing/hooks";

/**
 * Wrap the session's preview setter with the one URL transition preview mode
 * owns. The three case-workspace authoring URLs already preserve the tab the
 * author entered Preview from while the running app stays on its assembled
 * case list. A case-record URL means the worker has moved to the Details
 * surface, so every exit path (button, Escape, or P) maps that surface to the
 * Details authoring tab before turning preview off. Otherwise the record
 * deep-link synchronizer would immediately turn Preview back on, and mapping
 * every record to Results would lose the flipbook's current screen.
 */
export function usePreviewModeTransition(
	setPreviewing: (on: boolean) => void,
): (on: boolean) => void {
	const loc = useLocation();
	const navigate = useNavigate();
	return useCallback(
		(on: boolean) => {
			if (!on && loc.kind === "cases" && loc.caseId !== undefined) {
				navigate.replace({
					kind: "detail-config",
					moduleUuid: loc.moduleUuid,
				});
			}
			setPreviewing(on);
		},
		[loc, navigate, setPreviewing],
	);
}
