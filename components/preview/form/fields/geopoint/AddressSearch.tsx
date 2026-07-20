// components/preview/form/fields/geopoint/AddressSearch.tsx
//
// Address autocomplete for the GPS picker, built on Base UI's Autocomplete
// (same primitive as components/ui/FieldPicker.tsx) and driven by Google's
// Places API (New): `AutocompleteSuggestion.fetchAutocompleteSuggestions`
// with a session token (cheaper per-session billing), then `toPlace()` +
// `fetchFields(['location','formattedAddress'])` on selection to resolve
// coordinates. `mode="none"` — the list is server-driven, not locally
// filtered. Free-typed text that matches nothing is harmless (the user can
// still position the map).

"use client";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Icon } from "@iconify/react/offline";
import tablerLoader from "@iconify-icons/tabler/loader-2";
import tablerSearch from "@iconify-icons/tabler/search";
import { useEffect, useRef, useState } from "react";
import {
	MENU_ITEM_BASE,
	MENU_POPUP_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";
import { loadPlaces } from "./googleMaps";

const DEBOUNCE_MS = 250;
const MIN_QUERY = 3;

/** A resolved place handed up on selection. `lng` is Google's order. */
export interface PlacePick {
	readonly lat: number;
	readonly lng: number;
	readonly label: string;
}

interface Suggestion {
	readonly id: string;
	readonly label: string;
	readonly prediction: google.maps.places.PlacePrediction;
}

interface AddressSearchProps {
	/** Resolved address label to display (set by the picker after a map move
	 *  reverse-geocodes, or after a selection). Synced into the input. */
	readonly value: string;
	/** Fired when the user selects a suggestion — carries coordinates. */
	readonly onSelect: (pick: PlacePick) => void;
}

export function AddressSearch({ value, onSelect }: AddressSearchProps) {
	// Local input text, seeded from `value` and re-synced when the picker
	// pushes a new resolved label (mirrors SearchInputForm's pattern).
	const [query, setQuery] = useState(value);
	const lastValueRef = useRef(value);
	useEffect(() => {
		if (value !== lastValueRef.current) {
			lastValueRef.current = value;
			setQuery(value);
		}
	}, [value]);

	const [results, setResults] = useState<Suggestion[]>([]);
	const [loading, setLoading] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Session token groups one search's keystrokes + the final details fetch
	// into a single billable session; reset after a selection concludes it.
	const tokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(
		null,
	);
	// Monotonic id so a slow response can't overwrite a newer query's results.
	const reqRef = useRef(0);

	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, []);

	function runSearch(input: string) {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		const trimmed = input.trim();
		if (trimmed.length < MIN_QUERY) {
			setResults([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		debounceRef.current = setTimeout(async () => {
			const reqId = ++reqRef.current;
			try {
				const { AutocompleteSuggestion, AutocompleteSessionToken } =
					await loadPlaces();
				if (!tokenRef.current) {
					tokenRef.current = new AutocompleteSessionToken();
				}
				const { suggestions } =
					await AutocompleteSuggestion.fetchAutocompleteSuggestions({
						input: trimmed,
						sessionToken: tokenRef.current,
					});
				if (reqId !== reqRef.current) return; // a newer query superseded this
				const mapped: Suggestion[] = [];
				for (const s of suggestions) {
					const p = s.placePrediction;
					if (p) {
						mapped.push({ id: p.placeId, label: p.text.text, prediction: p });
					}
				}
				setResults(mapped);
			} catch {
				if (reqId === reqRef.current) setResults([]);
			} finally {
				if (reqId === reqRef.current) setLoading(false);
			}
		}, DEBOUNCE_MS);
	}

	async function resolveAndEmit(suggestion: Suggestion) {
		try {
			const place = suggestion.prediction.toPlace();
			await place.fetchFields({ fields: ["location", "formattedAddress"] });
			tokenRef.current = null; // fetchFields concludes the billing session
			const loc = place.location;
			if (!loc) return;
			onSelect({
				lat: loc.lat(),
				lng: loc.lng(),
				label: place.formattedAddress ?? suggestion.label,
			});
		} catch {
			/* details fetch failed — leave the map as-is */
		}
	}

	return (
		<Autocomplete.Root
			items={results}
			mode="none"
			value={query}
			itemToStringValue={(item: Suggestion) => item.label}
			openOnInputClick
			onValueChange={(next, details) => {
				if (details.reason === "item-press") {
					const picked = results.find((r) => r.label === next);
					setQuery(next);
					setResults([]);
					if (picked) void resolveAndEmit(picked);
					return;
				}
				setQuery(next);
				runSearch(next);
			}}
		>
			<Autocomplete.InputGroup className="relative">
				<Icon
					icon={loading ? tablerLoader : tablerSearch}
					width="16"
					height="16"
					aria-hidden="true"
					className={`pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-nova-text-muted ${
						loading ? "animate-spin" : ""
					}`}
				/>
				<Autocomplete.Input
					placeholder="Search for an address or place…"
					autoComplete="off"
					data-1p-ignore
					aria-label="Search for an address"
					className="w-full rounded-lg border border-pv-input-border bg-pv-input-bg py-2 pl-8 pr-3 text-sm text-nova-text outline-none transition-colors placeholder:text-nova-text-muted focus:border-pv-input-focus"
				/>
			</Autocomplete.InputGroup>

			<Autocomplete.Portal>
				<Autocomplete.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					className={MENU_SUBMENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)", maxWidth: 420 }}
				>
					<Autocomplete.Popup className={`${MENU_POPUP_CLS} w-full`}>
						<Autocomplete.Empty>
							<div className="px-3 py-2 text-xs text-nova-text-muted">
								{loading
									? "Searching…"
									: query.trim().length < MIN_QUERY
										? "Type at least 3 characters"
										: "No matching places"}
							</div>
						</Autocomplete.Empty>
						<Autocomplete.List className="max-h-56 w-full overflow-y-auto">
							<Autocomplete.Collection>
								{(item: Suggestion) => (
									<Autocomplete.Item
										key={item.id}
										value={item}
										className={`${MENU_ITEM_BASE} cursor-pointer text-nova-text first:rounded-t-xl last:rounded-b-xl data-[highlighted]:bg-white/[0.06]`}
									>
										<Icon
											icon={tablerSearch}
											width="14"
											height="14"
											aria-hidden="true"
											className="shrink-0 text-nova-text-muted"
										/>
										<span className="truncate text-xs text-nova-text">
											{item.label}
										</span>
									</Autocomplete.Item>
								)}
							</Autocomplete.Collection>
						</Autocomplete.List>
					</Autocomplete.Popup>
				</Autocomplete.Positioner>
			</Autocomplete.Portal>
		</Autocomplete.Root>
	);
}
