// components/preview/form/fields/geopoint/MapView.tsx
//
// The Google Maps view for the GPS picker. The Maps JS API is bundled-
// loaded once via `googleMaps.ts`; each instance creates its own
// `google.maps.Map` with a real **draggable marker**: drag the pin, or click
// the map to drop/move it. Commit happens on drag-END (and on click), so the
// form engine never recomputes mid-drag.
//
// Two rendering modes, chosen by whether a vector Map ID is configured
// (`NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`):
//   • Map ID set → WebGL **vector** basemap + `AdvancedMarkerElement`
//     (modern, no deprecation notice) styled as a Nova-violet pin.
//   • No Map ID → **raster** basemap + classic `google.maps.Marker`
//     (works with no provisioning; logs a one-time deprecation notice).
// The drag-pin UX is identical either way.

"use client";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";
import type { GeoPoint } from "./geopointValue";
import { googleMapsMapId, loadMaps, loadMarker } from "./googleMaps";

const DEFAULT_CENTER = { lat: 20, lng: 0 };
const DEFAULT_ZOOM = 2;
const FOCUS_ZOOM = 16;
/** The teardrop pin extends *upward* from its tip, so a pick in the top strip
 *  of the map has its head clipped by the rounded, overflow-hidden map box. A
 *  pick whose vertical position sits within this fraction of the top edge gets
 *  recentered so the whole pin shows; picks lower down are left where the user
 *  put them (no needless camera motion). */
const TOP_SAFE_FRACTION = 0.2;
/** Nova-violet pin (brand accent) for the Advanced Marker. */
const PIN_BG = "#8b5cf6";
const PIN_BORDER = "#6d28d9";
const PIN_GLYPH = "#ede9fe";

export interface MapHandle {
	/** Recenter the camera on a coordinate. Used for external picks (address
	 *  select / geolocate / manual entry). */
	panTo: (point: GeoPoint) => void;
}

interface MapViewProps {
	/** Committed location, or null when there's no value yet. The pin marks it. */
	readonly point: GeoPoint | null;
	/** Fired when the user drops/drags the pin or clicks the map — carries the
	 *  new coordinate (lng in Google's order). */
	readonly onPick: (lat: number, lng: number) => void;
}

/** A draggable pin, abstracted over Advanced vs. classic markers. */
interface PinMarker {
	setPosition(lat: number, lng: number): void;
	remove(): void;
}

/** A Nova-violet teardrop pin for the Advanced Marker's `content`. Built as
 *  a data-URL `<img>` from a fully static SVG (no `innerHTML`, no untrusted
 *  input) rather than `PinElement`, whose `.element` accessor is deprecated —
 *  so the console stays clean. The Advanced Marker anchors the element's
 *  bottom-center (the teardrop tip) on the coordinate. */
function createPinElement(): HTMLElement {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34"><path d="M13 0C5.82 0 0 5.82 0 13c0 9.25 11.5 20.2 12 20.66.27.25.73.25 1 0 .5-.46 13-11.41 13-20.66C26 5.82 20.18 0 13 0z" fill="${PIN_BG}" stroke="${PIN_BORDER}" stroke-width="1.5"/><circle cx="13" cy="13" r="4.5" fill="${PIN_GLYPH}"/></svg>`;
	const img = document.createElement("img");
	img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
	img.width = 26;
	img.height = 34;
	img.alt = "";
	img.style.display = "block";
	img.style.filter = "drop-shadow(0 2px 2px rgba(0,0,0,0.4))";
	return img;
}

/** Slide the camera down just enough to reveal a pin dropped near the top
 *  edge (where its upward teardrop head would otherwise be clipped). Only
 *  pans when the pick sits in the top band; leaves lower picks untouched. */
function panIfClipped(map: google.maps.Map, lat: number, lng: number): void {
	const bounds = map.getBounds();
	if (!bounds) return;
	const ne = bounds.getNorthEast();
	const sw = bounds.getSouthWest();
	const span = ne.lat() - sw.lat();
	if (span <= 0) return;
	const fromTop = (ne.lat() - lat) / span; // 0 = north edge, 1 = south edge
	if (fromTop < TOP_SAFE_FRACTION) map.panTo({ lat, lng });
}

/** Read lat/lng from any of the shapes `AdvancedMarkerElement.position`
 *  can take (LatLng has accessor methods; literal/altitude have number
 *  fields). */
function readPosition(
	pos:
		| google.maps.LatLng
		| google.maps.LatLngLiteral
		| google.maps.LatLngAltitude
		| null
		| undefined,
): { lat: number; lng: number } | null {
	if (!pos) return null;
	const lat = typeof pos.lat === "function" ? pos.lat() : pos.lat;
	const lng = typeof pos.lng === "function" ? pos.lng() : pos.lng;
	return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export const MapView = forwardRef<MapHandle, MapViewProps>(function MapView(
	{ point, onPick },
	ref,
) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const mapRef = useRef<google.maps.Map | null>(null);
	const markerRef = useRef<PinMarker | null>(null);
	// Factory created once the right marker library is loaded; null until then.
	const makeMarkerRef = useRef<
		((lat: number, lng: number) => PinMarker) | null
	>(null);

	// Pin `onPick` so the long-lived map/marker listeners always call the latest.
	const onPickRef = useRef(onPick);
	useEffect(() => {
		onPickRef.current = onPick;
	}, [onPick]);

	// Latest point for the create-once effect (initial center + marker) without
	// making it a dep that would tear down and rebuild the map.
	const pointRef = useRef(point);
	pointRef.current = point;

	// Create or move the draggable pin (idempotent). Only reads refs, so its
	// identity is stable and effects can depend on it without re-running.
	const ensureMarker = useCallback((lat: number, lng: number) => {
		if (markerRef.current) {
			markerRef.current.setPosition(lat, lng);
			return;
		}
		const make = makeMarkerRef.current;
		if (make) markerRef.current = make(lat, lng);
	}, []);

	// Create the map exactly once.
	useEffect(() => {
		let cancelled = false;
		const listeners: google.maps.MapsEventListener[] = [];
		const mapId = googleMapsMapId();

		(async () => {
			const { Map: GoogleMap } = await loadMaps();
			const container = containerRef.current;
			if (cancelled || !container) return;
			const initial = pointRef.current;
			const map = new GoogleMap(container, {
				...(mapId ? { mapId } : {}),
				// Force Google's dark basemap to match the dark preview theme. The
				// Maps API accepts the color-scheme by string literal as well as the
				// `ColorScheme` enum, so we skip importing "core" just for it. Applies
				// to the standard vector style behind our Map ID (and the raster
				// fallback); it can only be set at construction.
				colorScheme: "DARK" as google.maps.ColorScheme,
				center: initial
					? { lat: initial.lat, lng: initial.lon }
					: DEFAULT_CENTER,
				zoom: initial ? FOCUS_ZOOM : DEFAULT_ZOOM,
				tilt: 0,
				disableDefaultUI: true,
				zoomControl: true,
				gestureHandling: "greedy",
				clickableIcons: false,
				keyboardShortcuts: false,
			});
			mapRef.current = map;

			// Build the marker factory: Advanced (vector Map ID) or classic.
			if (mapId) {
				const { AdvancedMarkerElement } = await loadMarker();
				if (cancelled) return;
				makeMarkerRef.current = (lat, lng) => {
					const m = new AdvancedMarkerElement({
						map,
						position: { lat, lng },
						gmpDraggable: true,
						content: createPinElement(),
					});
					m.addListener("dragend", () => {
						const ll = readPosition(m.position);
						if (!ll) return;
						onPickRef.current(ll.lat, ll.lng);
						panIfClipped(map, ll.lat, ll.lng);
					});
					return {
						setPosition: (la, ln) => {
							m.position = { lat: la, lng: ln };
						},
						remove: () => {
							m.map = null;
						},
					};
				};
			} else {
				makeMarkerRef.current = (lat, lng) => {
					const m = new google.maps.Marker({
						map,
						position: { lat, lng },
						draggable: true,
					});
					m.addListener("dragend", () => {
						const pos = m.getPosition();
						if (!pos) return;
						onPickRef.current(pos.lat(), pos.lng());
						panIfClipped(map, pos.lat(), pos.lng());
					});
					return {
						setPosition: (la, ln) => m.setPosition({ lat: la, lng: ln }),
						remove: () => m.setMap(null),
					};
				};
			}

			// Place the initial pin now that the factory exists.
			const p = pointRef.current;
			if (p) ensureMarker(p.lat, p.lon);

			// Click the map to drop / move the pin.
			listeners.push(
				map.addListener("click", (e: google.maps.MapMouseEvent) => {
					if (!e.latLng) return;
					const lat = e.latLng.lat();
					const lng = e.latLng.lng();
					onPickRef.current(lat, lng);
					panIfClipped(map, lat, lng);
				}),
			);
		})().catch(() => {
			/* key missing / load failure — the parent shows a manual-entry
			   fallback when `googleMapsConfigured()` is false. */
		});

		return () => {
			cancelled = true;
			for (const l of listeners) l.remove();
			markerRef.current?.remove();
			markerRef.current = null;
			makeMarkerRef.current = null;
			mapRef.current = null;
		};
	}, [ensureMarker]);

	// Keep the pin in sync with the committed point (create / move / remove).
	useEffect(() => {
		if (!mapRef.current) return;
		if (point) {
			ensureMarker(point.lat, point.lon);
		} else if (markerRef.current) {
			markerRef.current.remove();
			markerRef.current = null;
		}
	}, [point, ensureMarker]);

	useImperativeHandle(
		ref,
		() => ({
			panTo(p) {
				const map = mapRef.current;
				if (!map) return;
				map.panTo({ lat: p.lat, lng: p.lon });
				if ((map.getZoom() ?? 0) < FOCUS_ZOOM) map.setZoom(FOCUS_ZOOM);
			},
		}),
		[],
	);

	return <div ref={containerRef} className="h-full w-full" />;
});
