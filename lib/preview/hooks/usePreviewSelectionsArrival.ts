"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type PreviewSessionSelections,
	previewSelectionsArrival,
	previewSelectionsInDocument,
	previewSelectionsTargetOf,
} from "@/lib/routing/previewSelectionsHistory";
import type { Location } from "@/lib/routing/types";
import {
	getBuilderPathSegmentsSnapshot,
	readCurrentPreviewSelections,
	recordPreviewSelections,
	subscribeBuilderHistoryPop,
	usePreviewSelectionsSnapshot,
} from "@/lib/routing/useClientPath";
import {
	usePreviewCaseTarget,
	usePreviewMenuCaseSelections,
	usePreviewPlatformRules,
	usePreviewSelectedCase,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type {
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewSelectedCase,
} from "@/lib/session/types";

function sessionSelections(state: {
	readonly previewMenuCaseSelections: Readonly<
		Record<string, PreviewMenuCaseSelection>
	>;
	readonly previewCaseTarget: PreviewCaseTarget | undefined;
	readonly previewSelectedCase: PreviewSelectedCase | undefined;
}): PreviewSessionSelections {
	return {
		menu: state.previewMenuCaseSelections,
		target: previewSelectionsTargetOf(state.previewCaseTarget),
		selected: state.previewSelectedCase,
	};
}

/**
 * Each Preview history entry records the case selections it was shown with,
 * and Back or Forward puts them back on Web Apps wherever the session holds
 * others (past Home, taking up the entry's task again), as Formplayer
 * replays a popped address's selections
 * (`lib/routing/previewSelectionsHistory.ts`).
 *
 * The record follows the session on every screen but Home (a layout
 * effect, after each write and each change of the selections). The return
 * happens on the popstate itself, before the screens render the entry
 * (`useClientPath.ts::subscribeBuilderHistoryPop`): a screen that reads the
 * selections as it mounts (a menu asking for its parent case, a form binding
 * its case) must find the entry's, never the empty session Home left.
 */
export function usePreviewSelectionsArrival(
	mode: "edit" | "preview",
	loc: Location,
): void {
	const doc = useBlueprintDocApi();
	const session = useBuilderSessionApi();
	const replay = usePreviewPlatformRules().poppedEntrySelections;
	const replayRef = useRef(replay);
	replayRef.current = replay;
	const modeRef = useRef(mode);
	modeRef.current = mode;

	useEffect(
		() =>
			subscribeBuilderHistoryPop(() => {
				if (modeRef.current !== "preview") return;
				const state = session.getState();
				const arrival = previewSelectionsArrival({
					replay: replayRef.current,
					atHome: getBuilderPathSegmentsSnapshot().length === 0,
					onEntry: readCurrentPreviewSelections(),
					session: state.previewSessionId,
					task: state.previewTaskId,
					current: sessionSelections(state),
				});
				if (arrival.kind === "keep") return;
				const recorded = previewSelectionsInDocument(
					arrival.recorded,
					doc.getState(),
				);
				if (arrival.kind === "restore")
					state.restorePreviewSelections(recorded);
				else state.replayPreviewSelections(recorded);
			}),
		[doc, session],
	);

	/* The record follows the entry and the session's selections. */
	const snapshot = usePreviewSelectionsSnapshot();
	const menu = usePreviewMenuCaseSelections();
	const target = usePreviewCaseTarget();
	const selected = usePreviewSelectedCase();
	useLayoutEffect(() => {
		if (mode !== "preview" || loc.kind === "home") return;
		void snapshot;
		void menu;
		void target;
		void selected;
		/* A return to the entry's selections happens on the popstate,
		 * before this; whatever the session holds now is what the entry
		 * shows, so the entry records it. */
		const state = session.getState();
		recordPreviewSelections({
			session: state.previewSessionId,
			task: state.previewTaskId,
			...sessionSelections(state),
		});
	}, [loc, menu, mode, selected, session, snapshot, target]);
}
