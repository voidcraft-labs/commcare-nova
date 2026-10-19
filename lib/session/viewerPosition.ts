/**
 * The viewer's position while a running list reads `here()`.
 *
 * One state for the browser tab, the way CommCare Android keeps one static
 * location handler for every list (`app/src/org/commcare/utils/
 * AndroidHereFunctionHandler.java`): the browser is asked once while Preview
 * runs, the latest position and the one a list last showed carry from one
 * list to the next, and each list that mounts starts its own watch, which
 * stops when a position is good enough (`lib/preview/engine/viewerLocation.ts`
 * holds that rule) or when the list goes away.
 *
 * Nothing here is stored or sent anywhere but the case-list request that
 * reads it. The reducers are pure; the store below writes through them.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { GeolocationFailureReason } from "@/components/preview/form/fields/geopoint/geolocation";
import {
	shouldReReadForPosition,
	type ViewerLocation,
} from "@/lib/preview/engine/viewerLocation";

/**
 * Where the browser stands on sharing the position:
 * - `unasked`: nothing has asked it yet;
 * - `waiting`: asked, with no position and no failure yet;
 * - `sharing`: a position has arrived;
 * - `refused`: the person, or the browser on their behalf, said no;
 * - `unavailable`: the browser could not find a position, or took too long;
 * - `unsupported`: the browser has no location to share.
 */
export type ViewerPositionStatus =
	| "unasked"
	| "waiting"
	| "sharing"
	| "refused"
	| "unavailable"
	| "unsupported";

/** A position with the browser's accuracy radius in metres. */
export interface ViewerFix extends ViewerLocation {
	readonly accuracy: number;
}

export interface ViewerPositionState {
	readonly status: ViewerPositionStatus;
	/** The newest position the browser reported. Every read sends this one. */
	readonly latest: ViewerFix | undefined;
	/** The position a list last showed, which the next move is measured from. */
	readonly shown: ViewerLocation | undefined;
	/**
	 * Counts the moves that re-read a list: the first position, every move
	 * past 30 metres from the shown one, and a refusal that takes a shown
	 * position away. A list that reads `here()` keys its read on it.
	 */
	readonly moves: number;
}

export const INITIAL_VIEWER_POSITION: ViewerPositionState = Object.freeze({
	status: "unasked",
	latest: undefined,
	shown: undefined,
	moves: 0,
});

/**
 * Whether a list that mounts starts watching on its own. A browser that
 * refused or cannot share is not asked again unprompted; the list's note
 * offers the way forward instead. An ask still waiting for its answer is
 * watched again: the browser holds the one prompt it showed rather than
 * showing another, and a list that went away while it was open (or mounted
 * twice) needs a watch of its own to hear the answer.
 */
export function watchesOnMount(status: ViewerPositionStatus): boolean {
	return status !== "refused" && status !== "unsupported";
}

/** A watch started: the browser has now been asked. */
export function positionAsked(state: ViewerPositionState): ViewerPositionState {
	if (state.status === "sharing" || state.status === "waiting") return state;
	return { ...state, status: "waiting" };
}

/** A position arrived. It becomes the latest, and the shown one too when it
 *  is the first or has moved past 30 metres from the shown one. */
export function positionReported(
	state: ViewerPositionState,
	fix: ViewerFix,
): ViewerPositionState {
	const location = { latitude: fix.latitude, longitude: fix.longitude };
	if (!shouldReReadForPosition(state.shown, location)) {
		return { ...state, status: "sharing", latest: fix };
	}
	return {
		status: "sharing",
		latest: fix,
		shown: location,
		moves: state.moves + 1,
	};
}

/**
 * A watch failed. A refusal forgets every position, since columns that use
 * it must go blank, and re-reads a list that showed one. A browser that
 * could not find a position this time keeps the one it already shared.
 */
export function positionFailed(
	state: ViewerPositionState,
	reason: GeolocationFailureReason,
): ViewerPositionState {
	switch (reason) {
		case "permission-denied":
			return {
				status: "refused",
				latest: undefined,
				shown: undefined,
				moves: state.shown === undefined ? state.moves : state.moves + 1,
			};
		case "unavailable":
		case "timeout":
			return state.status === "sharing"
				? state
				: { ...state, status: "unavailable" };
		case "unsupported":
			return { ...state, status: "unsupported" };
	}
}

/** A list read went out with this position, so it is now the shown one. */
export function positionShown(
	state: ViewerPositionState,
	location: ViewerLocation,
): ViewerPositionState {
	if (
		state.shown !== undefined &&
		state.shown.latitude === location.latitude &&
		state.shown.longitude === location.longitude
	) {
		return state;
	}
	return { ...state, shown: location };
}

export interface ViewerPositionStore extends ViewerPositionState {
	asked: () => void;
	reported: (fix: ViewerFix) => void;
	failed: (reason: GeolocationFailureReason) => void;
	/** The position a list read sends: the latest, recorded as shown. */
	takeForListRead: () => ViewerLocation | null;
	/** The position a Details or tile read sends, without recording it. */
	latestLocation: () => ViewerLocation | null;
}

export function createViewerPositionStore(): StoreApi<ViewerPositionStore> {
	return createStore<ViewerPositionStore>()((set, get) => {
		const write = (next: ViewerPositionState) => {
			const current = get();
			if (
				next.status !== current.status ||
				next.latest !== current.latest ||
				next.shown !== current.shown ||
				next.moves !== current.moves
			) {
				set(next);
			}
		};
		const latestLocation = (): ViewerLocation | null => {
			const latest = get().latest;
			return latest === undefined
				? null
				: { latitude: latest.latitude, longitude: latest.longitude };
		};
		return {
			...INITIAL_VIEWER_POSITION,
			asked: () => write(positionAsked(get())),
			reported: (fix) => write(positionReported(get(), fix)),
			failed: (reason) => write(positionFailed(get(), reason)),
			takeForListRead: () => {
				const location = latestLocation();
				if (location !== null) write(positionShown(get(), location));
				return location;
			},
			latestLocation,
		};
	});
}

/** The tab's one position state. */
export const viewerPositionStore = createViewerPositionStore();
