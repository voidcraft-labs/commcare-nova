// components/preview/form/fields/geopoint/geolocation.ts
//
// Promise wrapper around the browser Geolocation API for the "use my
// location" affordance. The native API is callback-based; this adapts it
// to a promise the picker can `await` with a try/catch, and normalizes
// the result into the picker's coordinate shape (altitude/accuracy fall
// back to 0 when the device doesn't report them).

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
				const reason =
					err.code === err.PERMISSION_DENIED
						? "permission-denied"
						: err.code === err.POSITION_UNAVAILABLE
							? "unavailable"
							: "timeout";
				reject(new GeolocationError(reason));
			},
			{ enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: 0 },
		);
	});
}
