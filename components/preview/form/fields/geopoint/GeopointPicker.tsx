// components/preview/form/fields/geopoint/GeopointPicker.tsx
//
// The interactive GPS picker shown in preview/running mode. Composes the
// Google map (draggable pin), Places address autocomplete, "use my
// location", and a manual lat/lon fallback into one control whose committed
// value is the wire geopoint string.
//
// The engine value (`value`) is the single source of truth: the readout and
// map center derive from `parseGeopoint(value)`, and every interaction
// commits through `onChange`. Map gestures commit on settle (not mid-drag),
// so the form engine never recomputes during a pan. Reverse geocoding fills
// the address readout after a map move; it's debounced.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCurrentLocation from "@iconify-icons/tabler/current-location";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useEffect, useRef, useState } from "react";
import { showToast } from "@/lib/ui/toastStore";
import { ValidationError } from "../ValidationError";
import { AddressSearch, type PlacePick } from "./AddressSearch";
import { GeolocationError, requestGeolocation } from "./geolocation";
import {
	formatGeopoint,
	formatLatLonLabel,
	type GeoPoint,
	isValidLat,
	isValidLon,
	parseGeopoint,
} from "./geopointValue";
import { googleMapsConfigured, loadGeocoding } from "./googleMaps";
import { type MapHandle, MapView } from "./MapView";
import { useInView } from "./useInView";

const REVERSE_DEBOUNCE_MS = 400;

interface GeopointPickerProps {
	/** Committed wire value ("lat lon alt acc" or ""). */
	readonly value: string;
	/** Commit a new wire value (or "" to clear). */
	readonly onChange: (value: string) => void;
	/** Mark the field touched (for required-validation surfacing). */
	readonly onBlur: () => void;
	readonly showError: boolean;
	readonly errorMessage?: string;
}

export function GeopointPicker({
	value,
	onChange,
	onBlur,
	showError,
	errorMessage,
}: GeopointPickerProps) {
	const point = parseGeopoint(value);
	const configured = googleMapsConfigured();

	const mapRef = useRef<MapHandle | null>(null);
	// The map box is the IntersectionObserver target; the Google map mounts
	// only while on screen (browser WebGL-context cap — see useInView) and is
	// released when scrolled away, so many geopoint fields don't all run live
	// maps at once.
	const mapBoxRef = useRef<HTMLDivElement>(null);
	const mapInView = useInView(mapBoxRef);
	// Resolved address shown in the search box + readout. Local UI state —
	// the engine only stores coordinates, never the address text.
	const [address, setAddress] = useState("");
	const [locating, setLocating] = useState(false);
	const [manualOpen, setManualOpen] = useState(false);

	// Debounced reverse geocode for map moves / geolocation. A monotonic id
	// drops a stale response (the Geocoder has no abort).
	const reverseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reverseReqRef = useRef(0);
	useEffect(() => {
		return () => {
			if (reverseTimerRef.current) clearTimeout(reverseTimerRef.current);
		};
	}, []);

	const reverseGeocode = useCallback((p: GeoPoint) => {
		if (reverseTimerRef.current) clearTimeout(reverseTimerRef.current);
		reverseTimerRef.current = setTimeout(async () => {
			const reqId = ++reverseReqRef.current;
			try {
				const { Geocoder } = await loadGeocoding();
				const { results } = await new Geocoder().geocode({
					location: { lat: p.lat, lng: p.lon },
				});
				if (reqId !== reverseReqRef.current) return; // superseded
				setAddress(results[0]?.formatted_address ?? "");
			} catch {
				/* reverse lookup is best-effort — leave the address as-is */
			}
		}, REVERSE_DEBOUNCE_MS);
	}, []);

	/** Commit a coordinate to the engine. `recenter` pans the map (for
	 *  off-map picks: address / geolocate / manual); map-origin picks leave
	 *  the camera where the user already positioned it. */
	const commit = useCallback(
		(p: GeoPoint, opts: { recenter?: boolean; label?: string } = {}) => {
			onChange(formatGeopoint(p));
			onBlur();
			if (opts.label !== undefined) {
				setAddress(opts.label);
			} else {
				reverseGeocode(p);
			}
			if (opts.recenter) mapRef.current?.panTo(p);
		},
		[onChange, onBlur, reverseGeocode],
	);

	// User positioned via the map (drag settle or click) — coordinates are
	// Google's (lat, lng); store lng as `lon`. The map is already centered
	// there, so no recenter.
	const handleMapPick = useCallback(
		(lat: number, lng: number) => {
			commit({ lat, lon: lng, alt: 0, accuracy: 0 });
		},
		[commit],
	);

	const handleAddressSelect = useCallback(
		(pick: PlacePick) => {
			commit(
				{ lat: pick.lat, lon: pick.lng, alt: 0, accuracy: 0 },
				{ recenter: true, label: pick.label },
			);
		},
		[commit],
	);

	const handleUseMyLocation = useCallback(async () => {
		setLocating(true);
		try {
			const p = await requestGeolocation();
			commit(p, { recenter: true });
		} catch (err) {
			const message =
				err instanceof GeolocationError
					? err.message
					: "Couldn't get your location.";
			showToast("error", "Location unavailable", message);
		} finally {
			setLocating(false);
		}
	}, [commit]);

	const handleClear = useCallback(() => {
		onChange("");
		onBlur();
		setAddress("");
	}, [onChange, onBlur]);

	return (
		<div className="space-y-2">
			{configured ? (
				<>
					<AddressSearch value={address} onSelect={handleAddressSelect} />

					<div
						ref={mapBoxRef}
						className="relative h-72 overflow-hidden rounded-lg border border-pv-input-border"
					>
						{mapInView ? (
							<MapView ref={mapRef} point={point} onPick={handleMapPick} />
						) : (
							// Lightweight stand-in until the field scrolls into view —
							// keeps layout stable and the map instance unallocated.
							<div className="flex h-full w-full items-center justify-center bg-pv-input-bg">
								<Icon
									icon={tablerMapPin}
									width="24"
									height="24"
									aria-hidden="true"
									className="text-nova-text-muted/40"
								/>
							</div>
						)}

						<button
							type="button"
							onClick={handleUseMyLocation}
							disabled={locating}
							className="absolute right-2 top-2 z-raised flex items-center gap-1.5 rounded-md border border-pv-input-border bg-pv-surface/90 px-2.5 py-1.5 text-xs font-medium text-nova-text shadow-sm backdrop-blur-sm transition-colors hover:border-pv-input-focus disabled:opacity-60"
						>
							<Icon
								icon={tablerCurrentLocation}
								width="14"
								height="14"
								aria-hidden="true"
								className={locating ? "animate-pulse" : ""}
							/>
							{locating ? "Locating…" : "My location"}
						</button>

						{!point && (
							<div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-pv-bg/90 to-transparent px-3 py-2 text-center text-xs text-nova-text-muted">
								Search an address, click the map to drop a pin, or use your
								location
							</div>
						)}
					</div>
				</>
			) : (
				<div className="rounded-lg border border-dashed border-pv-input-border bg-pv-surface px-4 py-3 text-sm text-nova-text-muted">
					Map unavailable — set <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to
					enable it. You can still enter coordinates manually below.
				</div>
			)}

			{point && (
				<div className="flex items-start justify-between gap-2 rounded-lg bg-pv-surface px-3 py-2">
					<div className="flex min-w-0 items-start gap-2">
						<Icon
							icon={tablerMapPin}
							width="16"
							height="16"
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-nova-violet-bright"
						/>
						<div className="min-w-0">
							{address && (
								<div className="truncate text-sm text-nova-text">{address}</div>
							)}
							<div className="font-mono text-xs text-nova-text-muted">
								{formatLatLonLabel(point)}
							</div>
						</div>
					</div>
					<button
						type="button"
						onClick={handleClear}
						aria-label="Clear location"
						className="shrink-0 rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text"
					>
						<Icon icon={tablerX} width="15" height="15" aria-hidden="true" />
					</button>
				</div>
			)}

			<ManualEntry
				point={point}
				open={manualOpen}
				onToggle={() => setManualOpen((o) => !o)}
				onCommit={(p) => commit(p, { recenter: true })}
			/>

			{showError && errorMessage && <ValidationError message={errorMessage} />}
		</div>
	);
}

// ── Manual lat/lon entry ────────────────────────────────────────────
//
// Keyboard-accessible / offline fallback. Two number inputs seeded from
// the current point; commits when both are valid and the user leaves the
// row (blur) or presses Enter. Kept collapsed by default so the map is
// the primary affordance.

interface ManualEntryProps {
	readonly point: GeoPoint | null;
	readonly open: boolean;
	readonly onToggle: () => void;
	readonly onCommit: (point: GeoPoint) => void;
}

function ManualEntry({ point, open, onToggle, onCommit }: ManualEntryProps) {
	const [lat, setLat] = useState(point ? String(point.lat) : "");
	const [lon, setLon] = useState(point ? String(point.lon) : "");

	// Re-seed the inputs whenever the committed point changes from outside
	// (map move, address select, geolocate, clear).
	const seedRef = useRef(pointKey(point));
	useEffect(() => {
		const seed = pointKey(point);
		if (seed !== seedRef.current) {
			seedRef.current = seed;
			setLat(point ? String(point.lat) : "");
			setLon(point ? String(point.lon) : "");
		}
	}, [point]);

	const latNum = Number(lat);
	const lonNum = Number(lon);
	const latOk = lat.trim() !== "" && isValidLat(latNum);
	const lonOk = lon.trim() !== "" && isValidLon(lonNum);
	const bothOk = latOk && lonOk;

	const tryCommit = () => {
		if (bothOk) onCommit({ lat: latNum, lon: lonNum, alt: 0, accuracy: 0 });
	};

	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex items-center gap-1 text-xs text-nova-text-muted transition-colors hover:text-nova-text"
			>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					aria-hidden="true"
					className={`transition-transform ${open ? "" : "-rotate-90"}`}
				/>
				Enter coordinates manually
			</button>

			{open && (
				<div className="mt-2 grid grid-cols-2 gap-2">
					<label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-nova-text-muted">
						Latitude
						<input
							type="number"
							inputMode="decimal"
							step="any"
							value={lat}
							onChange={(e) => setLat(e.target.value)}
							onBlur={tryCommit}
							onKeyDown={(e) => e.key === "Enter" && tryCommit()}
							aria-label="Latitude"
							className={`w-full rounded-md border bg-pv-input-bg px-2 py-1.5 text-sm text-nova-text outline-none transition-colors focus:border-pv-input-focus ${
								lat.trim() !== "" && !latOk
									? "border-nova-rose/60"
									: "border-pv-input-border"
							}`}
						/>
					</label>
					<label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-nova-text-muted">
						Longitude
						<input
							type="number"
							inputMode="decimal"
							step="any"
							value={lon}
							onChange={(e) => setLon(e.target.value)}
							onBlur={tryCommit}
							onKeyDown={(e) => e.key === "Enter" && tryCommit()}
							aria-label="Longitude"
							className={`w-full rounded-md border bg-pv-input-bg px-2 py-1.5 text-sm text-nova-text outline-none transition-colors focus:border-pv-input-focus ${
								lon.trim() !== "" && !lonOk
									? "border-nova-rose/60"
									: "border-pv-input-border"
							}`}
						/>
					</label>
				</div>
			)}
		</div>
	);
}

/** Stable identity for a nullable point, so the seed effect only re-runs
 *  when the actual coordinate changes. */
function pointKey(point: GeoPoint | null): string {
	return point ? formatGeopoint(point) : "";
}
