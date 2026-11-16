"use client";

import { useLayoutEffect, useRef } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import type { Location } from "@/lib/routing/types";
import {
	readBuilderHistoryMove,
	readCurrentPreviewSearchContexts,
	readCurrentPreviewStandingSearches,
	recordPreviewStandingSearches,
	usePreviewSearchContexts,
	usePreviewStandingSearches,
} from "@/lib/routing/useClientPath";
import { usePreviewPlatformRules } from "@/lib/session/hooks";
import { searchInputsGivenIn } from "@/lib/session/previewSearchState";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { previewSearchArrival, previewSearchScreenOf } from "../searchStanding";

/**
 * Arriving on a running screen, by a step forward or by Back and Forward,
 * lets go of every search whose list is not on the path to it: the entry
 * keeps only the searches that still stand there (`searchStanding.ts`), so a
 * step forward from it carries no search the worker left behind, as Web
 * Apps' address carries none past a screen above its list. A search that
 * still stands there and that the session has since replaced (the menu's
 * default search run again after a submission or a crumb) is the module's
 * search again (`previewSearchHistory.ts::previewSearchesOnEntry`), as Web
 * Apps answers the query the address it returns to still holds, and on Web
 * Apps the search of the list on show runs with the answers the worker last
 * gave its query (`searchStanding.ts::previewSearchArrival`). `listShown` is
 * the module whose case list the shell shows for the location
 * (`usePreviewScreenForLocation`), the one screen that runs that query.
 */
export function usePreviewSearchArrival(
	mode: "edit" | "preview",
	loc: Location,
	listShown: Uuid | undefined,
): void {
	const doc = useBlueprintDocApi();
	const session = useBuilderSessionApi();
	const replay = usePreviewPlatformRules().searchReplay;
	/* History can return to another entry on the same screen (Back off a
	 * list's held form menu onto the list), so the entry's record is an
	 * arrival as well as the location. */
	const standingOnEntry = usePreviewStandingSearches();
	const contextsOnEntry = usePreviewSearchContexts();
	/* The history move the last arrival ran at, with the list it showed: a
	 * run at the same move on the same screen is the entry's record rewritten
	 * in place, no arrival, while the list coming on show at that move (its
	 * menu's condition read only now) is the arrival on it. */
	const arrivedAtRef = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (mode !== "preview") return;
		const arrivedAt = `${readBuilderHistoryMove()} ${listShown ?? ""}`;
		const moved = arrivedAtRef.current !== arrivedAt;
		arrivedAtRef.current = arrivedAt;
		void standingOnEntry;
		void contextsOnEntry;
		const state = session.getState();
		const docState = doc.getState();
		const selections = state.previewMenuCaseSelections;
		const screen = previewSearchScreenOf(docState, loc, {
			menuSelections: selections,
			caseTarget: state.previewCaseTarget,
			registrationEntry: state.previewCaseListRegistrationEntry,
			parentCaseRequest: state.previewParentCaseRequest,
			listShown,
		});
		if (screen === undefined) return;
		const arrival = previewSearchArrival({
			source: docState,
			screen,
			selections,
			states: state.previewSearchStates,
			standing: readCurrentPreviewStandingSearches(),
			contexts: readCurrentPreviewSearchContexts(),
			session: state.previewSessionId,
			replay,
			moved,
			latest: searchInputsGivenIn(
				state.previewSearchInputs,
				state.previewSessionId,
			),
		});
		recordPreviewStandingSearches(arrival.standing);
		for (const [moduleUuid, search] of Object.entries(arrival.searches))
			state.setPreviewSearchState(moduleUuid, search);
	}, [
		contextsOnEntry,
		doc,
		listShown,
		loc,
		mode,
		replay,
		session,
		standingOnEntry,
	]);
}
