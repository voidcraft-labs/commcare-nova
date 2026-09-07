"use client";

import { useCallback } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { readBuilderLocation, useNavigate } from "@/lib/routing/hooks";
import { previewModeNavigation } from "./previewModeNavigation";

/**
 * Wrap the session's preview setter with the URL transitions preview mode
 * owns. The three case-workspace authoring URLs already preserve the tab the
 * author entered Preview from while the running app stays on its assembled
 * case list. A case-record URL means the worker has moved to the Details
 * surface, so every exit path (button, Escape, or P) maps that surface to the
 * Details authoring tab before turning preview off. Otherwise the record
 * deep-link synchronizer would immediately turn Preview back on, and mapping
 * every record to Results would lose the flipbook's current screen.
 *
 * Entering Preview from either configuration workspace leaves for the app
 * home. App setup is app administration: worker information, roles, personas
 *, and Project data holds lookup tables the project shares across apps;
 * nobody using the app opens any of it, so neither has a running counterpart
 * to show. The two alternatives are both worse: keeping the workspace on
 * screen would make
 * Preview a no-op press (and hand it a full-bleed canvas with both navigation
 * flanks collapsed), and blocking the toggle would make the app's one Run
 * control unreachable from a whole workspace. Running the app from its home
 * is what "Preview" means here.
 */
export function usePreviewModeTransition(
	setPreviewing: (on: boolean) => void,
): (on: boolean) => void {
	const docApi = useBlueprintDocApi();
	const navigate = useNavigate();
	return useCallback(
		(on: boolean) => {
			const loc = readBuilderLocation(docApi.getState());
			const change = previewModeNavigation(on, loc);
			if (change) navigate[change.method](change.location);
			setPreviewing(on);
		},
		[docApi, navigate, setPreviewing],
	);
}
