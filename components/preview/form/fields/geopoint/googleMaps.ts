// components/preview/form/fields/geopoint/googleMaps.ts
//
// Thin singleton wrapper around the official Google Maps JS API loader.
// `setOptions` runs once (lazily, on first use) and `importLibrary` loads
// each Maps library on demand and dedupes the underlying script — so the
// Maps JS API is fetched a single time no matter how many geopoint fields
// mount their own map. The browser key is the referrer-restricted public
// key (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`); that exposure is the documented
// model for the Maps JS API, secured by HTTP-referrer + per-API
// restrictions on the key itself.

"use client";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;
let configured = false;

/** True when a browser key is present — the picker degrades to manual
 *  coordinate entry when it isn't (e.g. local dev without the env var). */
export function googleMapsConfigured(): boolean {
	return Boolean(apiKey);
}

/** The vector Map ID, when configured. Its presence switches the map to a
 *  WebGL vector basemap + the modern (draggable) `AdvancedMarkerElement`;
 *  without it the map is raster + the classic `google.maps.Marker`. */
export function googleMapsMapId(): string | undefined {
	return mapId && mapId.length > 0 ? mapId : undefined;
}

function ensureConfigured(): void {
	if (configured) return;
	if (!apiKey) {
		throw new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set");
	}
	// `v: "weekly"` tracks the current stable channel; `loading=async` is
	// implied by the loader's dynamic-import bootstrap.
	setOptions({ key: apiKey, v: "weekly" });
	configured = true;
}

export function loadMaps(): Promise<google.maps.MapsLibrary> {
	ensureConfigured();
	return importLibrary("maps");
}

export function loadPlaces(): Promise<google.maps.PlacesLibrary> {
	ensureConfigured();
	return importLibrary("places");
}

export function loadGeocoding(): Promise<google.maps.GeocodingLibrary> {
	ensureConfigured();
	return importLibrary("geocoding");
}

export function loadMarker(): Promise<google.maps.MarkerLibrary> {
	ensureConfigured();
	return importLibrary("marker");
}
