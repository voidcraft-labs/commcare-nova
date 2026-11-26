"use client";

import type { NavigateActions } from "@/lib/routing/navigation";
import { recordPreviewSelections } from "@/lib/routing/useClientPath";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";

/** Give Back the first menu of the installed frame. A fresh Home navigation
 * has its own history entry with no selected record. */
export function showFrameFirstMenu(
	navigate: Pick<NavigateActions, "goHome">,
	session: BuilderSessionStoreApi,
	menu: Readonly<Record<string, PreviewMenuCaseSelection>>,
) {
	navigate.goHome();
	recordPreviewSelections(() => {
		const state = session.getState();
		return {
			session: state.previewSessionId,
			selections: {
				task: state.previewTaskId,
				menu,
				selected: undefined,
				target: undefined,
			},
		};
	});
}
