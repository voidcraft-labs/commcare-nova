// components/preview/form/fields/geopoint/geolocation.ts
//
// Adapters over the browser Geolocation API. `requestGeolocation` is the
// one-shot read behind the geopoint picker's "Your location" affordance: a
// promise the picker can `await`, normalized into the picker's coordinate
// shape (altitude/accuracy fall back to 0 when the device doesn't report
// them). `watchGeolocation` is the running list's watch behind `here()`: a
// stream of fixes with the browser's own accuracy, which the caller stops.

import type { GeoPoint } from "@/lib/preview/engine/geopointValue";

export type GeolocationFailureReason =
	| "permission-denied"
	| "unavailable"
	| "timeout"
	| "unsupported";

/** Browser failure classification; the worker presentation owns its wording. */
export class GeolocationError extends Error {
	constructor(readonly reason: GeolocationFailureReason) {
		super(reason);
		this.name = "GeolocationError";
	}
}

const TIMEOUT_MS = 10_000;

/**
 * Resolve with the device's current position as a `GeoPoint`, or reject
 * with a `GeolocationError` carrying a typed reason (permission
 * denied, unavailable, timed out, unsupported).
 */
export function requestGeolocation(): Promise<GeoPoint> {
	return new Promise((resolve, reject) => {
		if (typeof navigator === "undefined" || !navigator.geolocation) {
			reject(new GeolocationError("unsupported"));
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				resolve({
					lat: pos.coords.latitude,
					lon: pos.coords.longitude,
					alt: pos.coords.altitude ?? 0,
					accuracy: pos.coords.accuracy ?? 0,
				});
			},
			(err) => {
				reject(new GeolocationError(failureReason(err)));
			},
			POSITION_OPTIONS,
		);
	});
}

/** One position the browser reported. `accuracy` is the browser's radius in
 *  metres, or `Infinity` when it reported none, so a fix of unknown accuracy
 *  never counts as good enough to stop on. */
export interface GeolocationFix {
	readonly latitude: number;
	readonly longitude: number;
	/** Metres above the ellipsoid, or `null` when the browser gives none. */
	readonly altitude: number | null;
	readonly accuracy: number;
}

/**
 * Watch the device's position until the returned function is called.
 * Every position reaches `onFix`; every failure reaches `onFailure` with
 * the same typed reasons as {@link requestGeolocation}. A refusal clears the
 * watch, since the browser sends nothing more after one. A timeout or an
 * unavailable position leaves it running, because the browser keeps trying
 * and a later position still arrives. An unsupported browser reports once,
 * and stopping is then a no-op. Stopping twice is harmless.
 */
export function watchGeolocation(handlers: {
	readonly onFix: (fix: GeolocationFix) => void;
	readonly onFailure: (reason: GeolocationFailureReason) => void;
}): () => void {
	if (typeof navigator === "undefined" || !navigator.geolocation) {
		handlers.onFailure("unsupported");
		return () => {};
	}
	const geolocation = navigator.geolocation;
	let stopped = false;
	let watchId: number | undefined;
	const stop = () => {
		stopped = true;
		if (watchId === undefined) return;
		geolocation.clearWatch(watchId);
		watchId = undefined;
	};
	watchId = geolocation.watchPosition(
		(pos) => {
			if (stopped) return;
			const accuracy = pos.coords.accuracy;
			const altitude = pos.coords.altitude;
			handlers.onFix({
				latitude: pos.coords.latitude,
				longitude: pos.coords.longitude,
				altitude:
					typeof altitude === "number" && Number.isFinite(altitude)
						? altitude
						: null,
				accuracy:
					typeof accuracy === "number" && Number.isFinite(accuracy)
						? accuracy
						: Number.POSITIVE_INFINITY,
			});
		},
		(err) => {
			if (stopped) return;
			const reason = failureReason(err);
			if (reason === "permission-denied") stop();
			handlers.onFailure(reason);
		},
		POSITION_OPTIONS,
	);
	/* A refusal reported before `watchPosition` returned stopped the watch
	 * before its id existed; clear it now that it does. */
	if (stopped) stop();
	return stop;
}

const POSITION_OPTIONS: PositionOptions = {
	enableHighAccuracy: true,
	timeout: TIMEOUT_MS,
	maximumAge: 0,
};

function failureReason(
	err: GeolocationPositionError,
): GeolocationFailureReason {
	return err.code === err.PERMISSION_DENIED
		? "permission-denied"
		: err.code === err.POSITION_UNAVAILABLE
			? "unavailable"
			: "timeout";
}
