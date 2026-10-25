// components/preview/form/fields/geopoint/GeopointPicker.tsx
//
// The location question as Web Apps draws it, shown in the running preview
// when it runs as Web Apps (`lib/preview/platform.ts`, `locationQuestion`).
// Composes the Google map (draggable pin), Places address autocomplete and a
// manual lat/lon fallback into one control whose committed value is the wire
// geopoint string. Web Apps' location entry offers no "use my location"
// (the only `getCurrentPosition` in HQ's client is the address question's
// geocoder), so neither does this: the answer is the map's center, with
// altitude and accuracy 0, as Formplayer stores it. Running as Android the
// question is `RecordLocationField` instead.
//
// The engine value (`value`) is the single source of truth: the readout and
// map center derive from `parseGeopoint(value)`, and every interaction
// commits through `onChange`. Map gestures commit on settle (not mid-drag),
// so the form engine never recomputes during a pan. Reverse geocoding fills
// the address readout after a map move; it's debounced.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useReconcilerContext } from "@/lib/collab/context";
import {
	formatGeopoint,
	formatLatLonLabel,
	type GeoPoint,
	isValidLat,
	isValidLon,
	parseGeopoint,
} from "@/lib/preview/engine/geopointValue";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { useAccessPhase } from "@/lib/session/hooks";
import { ValidationError } from "../ValidationError";
import { AddressSearch, type PlacePick } from "./AddressSearch";
import { googleMapsConfigured, loadGeocoding } from "./googleMaps";
import { type MapHandle, MapView } from "./MapView";
import { useInView } from "./useInView";

const REVERSE_DEBOUNCE_MS = 400;

interface GeopointPickerProps {
	/** Committed wire value ("lat lon alt acc" or ""). */
	readonly value: string;
	/** Visible question label rendered by InteractiveFormRenderer. */
	readonly labelledBy?: string;
	/** Commit a new wire value (or "" to clear). */
	readonly onChange: (value: string) => void;
	/** Mark the field touched (for required-validation surfacing). */
	readonly onBlur: () => void;
	readonly showError: boolean;
	readonly errorMessage?: string;
}

export function GeopointPicker({
	value,
	labelledBy,
	onChange,
	onBlur,
	showError,
	errorMessage,
}: GeopointPickerProps) {
	const { language } = useBuilderLanguage();
	const point = parseGeopoint(value);
	const configured = googleMapsConfigured();
	const reconciler = useReconcilerContext();
	const accessPhase = useAccessPhase();

	const mapRef = useRef<MapHandle | null>(null);
	// The map box is the IntersectionObserver target; the Google map mounts
	// only while on screen (browser WebGL-context cap: see useInView) and is
	// released when scrolled away, so many geopoint fields don't all run live
	// maps at once.
	const mapBoxRef = useRef<HTMLDivElement>(null);
	const mapInView = useInView(mapBoxRef);
	// Resolved address shown in the search box + readout. Local UI state:
	// the engine only stores coordinates, never the address text.
	const [address, setAddress] = useState("");
	const [manualOpen, setManualOpen] = useState(false);

	// Debounced reverse geocode for map moves. A monotonic id drops a stale
	// response (the Geocoder has no abort).
	const reverseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reverseReqRef = useRef(0);
	const ownsContinuationRef = useRef(true);
	useEffect(() => {
		ownsContinuationRef.current = true;
		const fenceContinuations = () => {
			/* Maps promises are not abortable. Invalidate them in the
			 * synchronous Project-reset stack. A same-Project access snapshot
			 * re-arms this mounted owner; a terminal entry boundary remounts it. */
			ownsContinuationRef.current = false;
			reverseReqRef.current += 1;
			if (reverseTimerRef.current) {
				clearTimeout(reverseTimerRef.current);
				reverseTimerRef.current = null;
			}
		};
		const unsubscribeReset =
			reconciler?.subscribeProjectScopeReset(fenceContinuations);
		return () => {
			unsubscribeReset?.();
			fenceContinuations();
		};
	}, [reconciler]);
	useEffect(() => {
		/* The reset signal precedes the authoritative GET, so it invalidates
		 * unabortable source continuations without proving the field belongs to
		 * a different Project. A same-Project snapshot re-arms this mounted
		 * control; a confirmed Project change remounts FormScreen's fieldset. */
		if (accessPhase === "authorized") ownsContinuationRef.current = true;
	}, [accessPhase]);

	const reverseGeocode = useCallback((p: GeoPoint) => {
		if (reverseTimerRef.current) clearTimeout(reverseTimerRef.current);
		reverseTimerRef.current = setTimeout(async () => {
			const reqId = ++reverseReqRef.current;
			try {
				const { Geocoder } = await loadGeocoding();
				if (!ownsContinuationRef.current || reqId !== reverseReqRef.current)
					return;
				const { results } = await new Geocoder().geocode({
					location: { lat: p.lat, lng: p.lon },
				});
				if (!ownsContinuationRef.current || reqId !== reverseReqRef.current)
					return; // superseded or Project reset
				setAddress(results[0]?.formatted_address ?? "");
			} catch {
				/* reverse lookup is best-effort: leave the address as-is */
			}
		}, REVERSE_DEBOUNCE_MS);
	}, []);

	/** Commit a coordinate to the engine. `recenter` pans the map (for
	 *  off-map picks: address / manual); map-origin picks leave
	 *  the camera where the user already positioned it. */
	const commit = useCallback(
		(p: GeoPoint, opts: { recenter?: boolean; label?: string } = {}) => {
			if (!ownsContinuationRef.current) return;
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

	// User positioned via the map (drag settle or click): coordinates are
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

	const handleClear = useCallback(() => {
		if (!ownsContinuationRef.current) return;
		onChange("");
		onBlur();
		setAddress("");
	}, [onChange, onBlur]);

	return (
		<fieldset
			aria-labelledby={labelledBy}
			// `min-w-0`: a fieldset's UA default is `min-width: min-content`,
			// so without it this refuses to shrink below the address input and
			// the lat/lon row, and a narrow preview column overflows sideways.
			className="m-0 min-w-0 space-y-2 border-none p-0"
		>
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
							// Lightweight stand-in until the field scrolls into view:
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

						{!point && (
							<div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-pv-bg/90 to-transparent px-3 py-2 text-center text-xs text-nova-text-muted">
								{runtimeMessage(language, "locationGuidance")}
							</div>
						)}
					</div>
				</>
			) : (
				<div className="rounded-lg border border-dashed border-pv-input-border bg-pv-surface px-4 py-3 text-sm text-nova-text-muted">
					{runtimeMessage(language, "mapUnavailable")}
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
						aria-label={runtimeMessage(language, "clearLocation")}
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
		</fieldset>
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
	const { language } = useBuilderLanguage();
	const [lat, setLat] = useState(point ? String(point.lat) : "");
	const [lon, setLon] = useState(point ? String(point.lon) : "");

	// Re-seed the inputs whenever the committed point changes from outside
	// (map move, address select, clear).
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
				{runtimeMessage(language, "manualCoordinates")}
			</button>

			{open && (
				<div className="mt-2 grid grid-cols-2 gap-2">
					<label className="flex flex-col gap-1 text-xs text-nova-text-muted">
						{runtimeMessage(language, "latitude")}
						<input
							type="number"
							inputMode="decimal"
							step="any"
							value={lat}
							onChange={(e) => setLat(e.target.value)}
							onBlur={tryCommit}
							onKeyDown={(e) => e.key === "Enter" && tryCommit()}
							aria-label={runtimeMessage(language, "latitude")}
							className={`w-full rounded-md border bg-pv-input-bg px-2 py-1.5 text-sm text-nova-text outline-none transition-colors focus:border-pv-input-focus ${
								lat.trim() !== "" && !latOk
									? "border-nova-rose/60"
									: "border-pv-input-border"
							}`}
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-nova-text-muted">
						{runtimeMessage(language, "longitude")}
						<input
							type="number"
							inputMode="decimal"
							step="any"
							value={lon}
							onChange={(e) => setLon(e.target.value)}
							onBlur={tryCommit}
							onKeyDown={(e) => e.key === "Enter" && tryCommit()}
							aria-label={runtimeMessage(language, "longitude")}
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
