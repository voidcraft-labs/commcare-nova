"use client";

import { useLayoutEffect } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { previewSearchesOnEntry } from "@/lib/routing/previewSearchHistory";
import type { Location } from "@/lib/routing/types";
import {
	readCurrentPreviewSearchContexts,
	readCurrentPreviewStandingSearches,
	recordPreviewStandingSearches,
	usePreviewSearchContexts,
	usePreviewStandingSearches,
} from "@/lib/routing/useClientPath";
import { useBuilderSessionApi } from "@/lib/session/provider";
import {
	previewSearchesStandingAt,
	previewSearchScreenOf,
} from "../searchStanding";

/**
 * Arriving on a running screen, by a step forward or by Back and Forward,
 * lets go of every search whose list is not on the path to it: the entry
 * keeps only the searches that still stand there (`searchStanding.ts`), so a
 * step forward from it carries no search the worker left behind, as Web
 * Apps' address carries none past a screen above its list. A search that
 * still stands there and that the session has since replaced (the menu's
 * default search run again after a submission or a crumb) is the module's
 * search again (`previewSearchHistory.ts::previewSearchesOnEntry`), as Web
 * Apps answers the query the address it returns to still holds.
 */
export function usePreviewSearchArrival(
	mode: "edit" | "preview",
	loc: Location,
): void {
	const doc = useBlueprintDocApi();
	const session = useBuilderSessionApi();
	/* History can return to another entry on the same screen (Back off a
	 * list's held form menu onto the list), so the entry's record is an
	 * arrival as well as the location. */
	const standingOnEntry = usePreviewStandingSearches();
	const contextsOnEntry = usePreviewSearchContexts();
	useLayoutEffect(() => {
		if (mode !== "preview") return;
		void standingOnEntry;
		void contextsOnEntry;
		const state = session.getState();
		const docState = doc.getState();
		const screen = previewSearchScreenOf(docState, loc, {
			menuSelections: state.previewMenuCaseSelections,
			caseTarget: state.previewCaseTarget,
			registrationEntry: state.previewCaseListRegistrationEntry,
			parentCaseRequest: state.previewParentCaseRequest,
		});
		if (screen === undefined) return;
		const current = readCurrentPreviewStandingSearches();
		const standing = new Set(current);
		const held = previewSearchesOnEntry(
			state.previewSearchStates,
			standing,
			readCurrentPreviewSearchContexts(),
			state.previewSessionId,
		);
		const kept = new Set(
			previewSearchesStandingAt(docState, held, standing, screen),
		);
		recordPreviewStandingSearches(
			current.filter((submission) => kept.has(submission)),
		);
		for (const [moduleUuid, search] of Object.entries(held))
			if (
				search !== state.previewSearchStates[moduleUuid] &&
				search.kind !== "not-searched" &&
				kept.has(search.submission)
			)
				state.setPreviewSearchState(moduleUuid, search);
	}, [contextsOnEntry, doc, loc, mode, session, standingOnEntry]);
}
