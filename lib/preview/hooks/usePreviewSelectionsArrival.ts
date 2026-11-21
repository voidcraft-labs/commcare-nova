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
	usePreviewSessionId,
} from "@/lib/session/hooks";
import {
	type BuilderSessionStoreApi,
	useBuilderSessionApi,
} from "@/lib/session/provider";
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

/** The menus and forms the document holds, which a returned record keeps. */
interface PreviewSelectionsDocument {
	getState(): {
		readonly modules: Readonly<Record<string, unknown>>;
		readonly forms: Readonly<Record<string, unknown>>;
	};
}

/**
 * Back or Forward onto the current history entry: on Web Apps, its recorded
 * selections become the session's wherever the session holds others
 * (`previewSelectionsHistory.ts::previewSelectionsArrival`). It runs on the
 * popstate itself, before any screen renders the entry
 * (`useClientPath.ts::subscribeBuilderHistoryPop`).
 */
export function returnPreviewSelectionsOnArrival(
	session: BuilderSessionStoreApi,
	doc: PreviewSelectionsDocument,
	replay: "address" | "session",
): void {
	const state = session.getState();
	const arrival = previewSelectionsArrival({
		replay,
		atHome: getBuilderPathSegmentsSnapshot().length === 0,
		onEntry: readCurrentPreviewSelections(state.previewSessionId),
		task: state.previewTaskId,
		current: sessionSelections(state),
	});
	if (arrival.kind === "keep") return;
	const recorded = previewSelectionsInDocument(
		arrival.recorded,
		doc.getState(),
	);
	if (arrival.kind === "restore") state.restorePreviewSelections(recorded);
	else state.replayPreviewSelections(recorded);
}

/** The current history entry's record, in the running Preview session,
 *  holds the selections the session holds: a screen shown with them, once
 *  its entry's arrival has returned its own. */
export function recordSessionSelections(session: BuilderSessionStoreApi): void {
	recordPreviewSelections(() => {
		const state = session.getState();
		return {
			session: state.previewSessionId,
			selections: { task: state.previewTaskId, ...sessionSelections(state) },
		};
	});
}

/**
 * The session keeps, for each Preview history entry, the case selections it
 * was shown with (the entry's record, in memory: `lib/routing/previewEntryRecords.ts`),
 * and Back or Forward puts them back on Web Apps wherever the session holds
 * others (past Home, taking up the entry's task again), as Formplayer
 * replays a popped address's selections
 * (`lib/routing/previewSelectionsHistory.ts`).
 *
 * The record follows the session on every screen but Home on Web Apps (a
 * layout effect, after each write and each change of the selections).
 * Android shows every entry with the session as it stands, so nothing reads
 * a record there and none is kept. The return
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
				returnPreviewSelectionsOnArrival(session, doc, replayRef.current);
			}),
		[doc, session],
	);

	/* The record follows the entry and the session's selections. */
	const previewSessionId = usePreviewSessionId();
	const snapshot = usePreviewSelectionsSnapshot(previewSessionId);
	const menu = usePreviewMenuCaseSelections();
	const target = usePreviewCaseTarget();
	const selected = usePreviewSelectedCase();
	useLayoutEffect(() => {
		if (mode !== "preview" || loc.kind === "home" || replay !== "address")
			return;
		void snapshot;
		void menu;
		void target;
		void selected;
		/* A return to the entry's selections happens on the popstate,
		 * before this; whatever the session holds now is what the entry
		 * shows, so the entry records it. */
		recordSessionSelections(session);
	}, [loc, menu, mode, replay, selected, session, snapshot, target]);
}
