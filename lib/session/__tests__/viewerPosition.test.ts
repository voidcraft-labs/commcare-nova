import { describe, expect, it } from "vitest";
import {
	createViewerPositionStore,
	INITIAL_VIEWER_POSITION,
	positionAsked,
	positionFailed,
	positionReported,
	watchesOnMount,
} from "../viewerPosition";

/* About 11 metres of latitude per 1e-4 degrees at the equator. */
const HERE = { latitude: 0, longitude: 0, accuracy: 2000 };
const TEN_METRES = { latitude: 0.00009, longitude: 0, accuracy: 2000 };
const FORTY_METRES = { latitude: 0.00036, longitude: 0, accuracy: 2000 };

describe("viewer position", () => {
	it("asks the browser once, then lets a list watch only when that can help", () => {
		expect(watchesOnMount("unasked")).toBe(true);
		const asked = positionAsked(INITIAL_VIEWER_POSITION);
		expect(asked.status).toBe("waiting");
		/* An ask the browser has not answered is not repeated unprompted. */
		expect(watchesOnMount(asked.status)).toBe(false);
		expect(watchesOnMount("sharing")).toBe(true);
		expect(watchesOnMount("unavailable")).toBe(true);
		expect(watchesOnMount("refused")).toBe(false);
		expect(watchesOnMount("unsupported")).toBe(false);
	});

	it("re-reads for the first position and for a move past 30 metres only", () => {
		const first = positionReported(
			positionAsked(INITIAL_VIEWER_POSITION),
			HERE,
		);
		expect(first).toMatchObject({ status: "sharing", moves: 1 });
		const near = positionReported(first, TEN_METRES);
		expect(near.moves).toBe(1);
		expect(near.latest).toBe(TEN_METRES);
		expect(near.shown).toEqual({ latitude: 0, longitude: 0 });
		const far = positionReported(near, FORTY_METRES);
		expect(far.moves).toBe(2);
		expect(far.shown).toEqual({ latitude: 0.00036, longitude: 0 });
	});

	it("forgets every position on a refusal and re-reads a list that showed one", () => {
		const sharing = positionReported(INITIAL_VIEWER_POSITION, HERE);
		const refused = positionFailed(sharing, "permission-denied");
		expect(refused).toEqual({
			status: "refused",
			latest: undefined,
			shown: undefined,
			moves: sharing.moves + 1,
		});
		const neverShown = positionFailed(
			positionAsked(INITIAL_VIEWER_POSITION),
			"permission-denied",
		);
		expect(neverShown.moves).toBe(0);
	});

	it("keeps a shared position through a later timeout", () => {
		const sharing = positionReported(INITIAL_VIEWER_POSITION, HERE);
		expect(positionFailed(sharing, "timeout")).toBe(sharing);
		expect(
			positionFailed(positionAsked(INITIAL_VIEWER_POSITION), "unavailable")
				.status,
		).toBe("unavailable");
	});

	it("sends the latest position with a list read and records it as shown", () => {
		const store = createViewerPositionStore();
		expect(store.getState().takeForListRead()).toBeNull();
		store.getState().reported(HERE);
		store.getState().reported(TEN_METRES);
		expect(store.getState().takeForListRead()).toEqual({
			latitude: 0.00009,
			longitude: 0,
		});
		expect(store.getState().shown).toEqual({
			latitude: 0.00009,
			longitude: 0,
		});
		/* Recording what a read showed is not a move. */
		expect(store.getState().moves).toBe(1);
		expect(store.getState().latestLocation()).toEqual({
			latitude: 0.00009,
			longitude: 0,
		});
	});
});
