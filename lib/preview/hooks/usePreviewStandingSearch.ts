"use client";

import { useCallback, useMemo } from "react";
import { previewSearchesOnEntry } from "@/lib/routing/previewSearchHistory";
import {
	beginPreviewStandingSearch,
	readCurrentPreviewSearchContexts,
	readCurrentPreviewStandingSearches,
	usePreviewSearchContexts,
	usePreviewStandingSearches,
} from "@/lib/routing/useClientPath";
import {
	usePreviewSearchState,
	usePreviewSessionId,
	useSetPreviewSearchState,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { PreviewSearchState } from "@/lib/session/types";
import { previewStandingSearch } from "../searchStanding";

/** A module's search as the screen on show holds it: the session's context
 *  for the module, or the one the current history entry's record holds where
 *  the session has since replaced it (`previewSearchHistory.ts::previewSearchesOnEntry`),
 *  where that search stands on the entry (`searchStanding.ts`), and none
 *  where the worker has left it behind. */
export function usePreviewStandingSearchState(
	moduleUuid: string | undefined,
): PreviewSearchState | undefined {
	const state = usePreviewSearchState(moduleUuid);
	const standing = usePreviewStandingSearches();
	const session = usePreviewSessionId();
	const contexts = usePreviewSearchContexts(session);
	return useMemo(() => {
		if (moduleUuid === undefined) return undefined;
		const held = previewSearchesOnEntry(
			state === undefined ? {} : { [moduleUuid]: state },
			standing,
			contexts,
		);
		return previewStandingSearch(held[moduleUuid], standing);
	}, [contexts, moduleUuid, standing, state]);
}

/** Set or clear a module's search. A search begun here stands on the
 *  current history entry, named there with its context in the entry's
 *  record before the session holds it, so no render sees the search without its standing, and
 *  a change of its context is recorded there too. */
export function useSetPreviewStandingSearchState(): (
	moduleUuid: string,
	state: PreviewSearchState | undefined,
) => void {
	const set = useSetPreviewSearchState();
	const session = useBuilderSessionApi();
	return useCallback(
		(moduleUuid, state) => {
			if (state !== undefined && state.kind !== "not-searched") {
				const { previewSearchStates, previewSessionId } = session.getState();
				const recorded = readCurrentPreviewStandingSearches();
				const held = previewSearchesOnEntry(
					previewSearchStates,
					new Set(recorded),
					readCurrentPreviewSearchContexts(previewSessionId),
				);
				const live = new Set(
					Object.entries(held)
						.filter(([uuid]) => uuid !== moduleUuid)
						.map(([, search]) =>
							search.kind === "not-searched" ? "" : search.submission,
						),
				);
				/* After a submission's end on this entry, a search written here
				 * (a registration re-keying its menu's search to the new case,
				 * the same search or a new one) is the landing's to carry on. */
				beginPreviewStandingSearch(
					recorded.filter((submission) => live.has(submission)),
					{ moduleUuid, state },
					previewSessionId,
				);
			}
			set(moduleUuid, state);
		},
		[session, set],
	);
}
