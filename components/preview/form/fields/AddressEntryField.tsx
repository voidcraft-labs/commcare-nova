// components/preview/form/fields/AddressEntryField.tsx
//
// Web Apps' address search on a text, password or barcode question
// (`cloudcare/js/form_entry/entries.js::AddressEntry`): the worker types,
// chooses one of the places the geocoder offers, and the question saves the
// JSON of that address's parts and sends the same parts to its channels.
// Typing after a choice lets the answer go until the worker chooses again,
// and the clear button empties the answer and tells the channels so.
//
// Preview searches with Google's Places API (`geopoint/googleMaps.ts`).
// Where no key is set up, nothing searches, and Preview makes up no answer:
// the box stays read-only and says why. Web Apps searches only on a project
// space with advanced case search and the Geocoder plan feature
// (`lib/domain/questionDisplayPlatforms.ts`, `address-lookup`'s target
// condition); a line names that condition unless Preview is bound to a
// project space where a person confirmed the plan feature.

"use client";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Icon } from "@iconify/react/offline";
import tablerLoader from "@iconify-icons/tabler/loader-2";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useRef, useState } from "react";
import {
	useDeploymentProjectSpace,
	useDeploymentTargetFacts,
} from "@/components/builder/DeploymentTargetProvider";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { usePortaledContentDirection } from "@/components/shadcn/portaled-content-direction";
import type { Field as FieldEntity } from "@/lib/domain";
import { targetConditionOf } from "@/lib/domain";
import {
	addressAnswerLine,
	addressMessage,
	type FoundAddress,
} from "@/lib/preview/addressMessage";
import type { QuestionMessage } from "@/lib/preview/displayMessages";
import type { FieldState } from "@/lib/preview/engine/types";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import {
	FLOATING_LAYER_CLS,
	MENU_ITEM_BASE,
	MENU_POPUP_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";
import { googleMapsConfigured, loadPlaces } from "./geopoint/googleMaps";
import { ValidationError } from "./ValidationError";

const DEBOUNCE_MS = 250;
const MIN_QUERY = 3;
const CONDITION = targetConditionOf("address-lookup");

interface Suggestion {
	readonly id: string;
	readonly label: string;
	readonly prediction: google.maps.places.PlacePrediction;
}

interface AddressEntryFieldProps {
	field: Pick<FieldEntity, "uuid">;
	state: Pick<FieldState, "value" | "touched" | "valid" | "errorMessage">;
	labelledBy?: string;
	onCommit: (value: string, message?: QuestionMessage) => Promise<boolean>;
	onBlur?: () => void;
	context?: "form" | "search";
}

/** The line Preview shows the author about what Web Apps needs of the project space. */
export function addressConditionNote(
	projectSpace: string | null,
	geocoderConfirmed: boolean,
): string | null {
	if (geocoderConfirmed) return null;
	const reason = CONDITION?.reason ?? "";
	return projectSpace === null
		? `${reason} Publishing checks the project space and asks you to confirm the plan feature.`
		: `${reason} Nobody has confirmed the Geocoder plan feature for “${projectSpace}” yet, and publishing there asks for it.`;
}

export function AddressEntryField({
	field,
	state,
	labelledBy,
	onCommit,
	onBlur,
	context = "form",
}: AddressEntryFieldProps) {
	const { language } = useBuilderLanguage();
	const direction = usePortaledContentDirection();
	const projectSpace = useDeploymentProjectSpace();
	const geocoderConfirmed =
		useDeploymentTargetFacts()?.geocoderConfirmed === true;
	const note = addressConditionNote(projectSpace, geocoderConfirmed);
	const searches = googleMapsConfigured();

	const answerLine = addressAnswerLine(state.value);
	// A typed query belongs to the worker. A committed address is drawn
	// from the engine, including when an attempted change is refused.
	const [draft, setDraft] = useState<string | null>(null);
	const query = draft ?? answerLine;
	const [choiceNeeded, setChoiceNeeded] = useState(false);

	const [results, setResults] = useState<Suggestion[]>([]);
	const [loading, setLoading] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(
		null,
	);
	const reqRef = useRef(0);
	const detailsReqRef = useRef(0);
	const pendingChoice = useRef<number | null>(null);
	useEffect(
		() => () => {
			reqRef.current += 1;
			detailsReqRef.current += 1;
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	function runSearch(input: string) {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		const reqId = ++reqRef.current;
		const trimmed = input.trim();
		if (trimmed.length < MIN_QUERY) {
			setResults([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		debounceRef.current = setTimeout(async () => {
			try {
				const { AutocompleteSuggestion, AutocompleteSessionToken } =
					await loadPlaces();
				if (reqId !== reqRef.current) return;
				tokenRef.current ??= new AutocompleteSessionToken();
				const { suggestions } =
					await AutocompleteSuggestion.fetchAutocompleteSuggestions({
						input: trimmed,
						sessionToken: tokenRef.current,
					});
				if (reqId !== reqRef.current) return;
				setResults(
					suggestions.flatMap((suggestion) => {
						const prediction = suggestion.placePrediction;
						return prediction
							? [
									{
										id: prediction.placeId,
										label: prediction.text.text,
										prediction,
									},
								]
							: [];
					}),
				);
			} catch {
				if (reqId === reqRef.current) setResults([]);
			} finally {
				if (reqId === reqRef.current) setLoading(false);
			}
		}, DEBOUNCE_MS);
	}

	async function choose(suggestion: Suggestion) {
		const reqId = ++detailsReqRef.current;
		reqRef.current += 1;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		setLoading(false);
		// The selected prediction already owns this session token. New input
		// needs a separate token even while this selection waits for details.
		tokenRef.current = null;
		try {
			const place = suggestion.prediction.toPlace();
			await place.fetchFields({
				fields: ["formattedAddress", "location", "addressComponents"],
			});
			if (reqId !== detailsReqRef.current) return;
			const location = place.location;
			if (!location) return;
			const found: FoundAddress = {
				full: place.formattedAddress ?? suggestion.label,
				latitude: location.lat(),
				longitude: location.lng(),
				parts: (place.addressComponents ?? []).map((component) => ({
					longText: component.longText,
					shortText: component.shortText,
					types: component.types,
				})),
			};
			const message = addressMessage(found);
			pendingChoice.current = reqId;
			const applied = await onCommit(JSON.stringify(message), message);
			if (reqId !== detailsReqRef.current) return;
			if (applied === false) {
				setChoiceNeeded(true);
				return;
			}
			setDraft(null);
			setChoiceNeeded(false);
		} catch {
			if (reqId === detailsReqRef.current) setChoiceNeeded(true);
		} finally {
			if (pendingChoice.current === reqId) pendingChoice.current = null;
		}
	}

	async function clear() {
		reqRef.current += 1;
		const reqId = ++detailsReqRef.current;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		tokenRef.current = null;
		setLoading(false);
		pendingChoice.current = null;
		setResults([]);
		const applied = await onCommit("", null);
		if (reqId !== detailsReqRef.current || applied === false) return;
		setDraft(null);
		setChoiceNeeded(false);
	}

	async function search(next: string) {
		const reqId = ++detailsReqRef.current;
		const replaceAddress = answerLine !== "" || pendingChoice.current !== null;
		pendingChoice.current = null;
		setDraft(next);
		runSearch(next);
		if (!replaceAddress) return;
		// Typing over a chosen address clears the sender and broadcasts nothing.
		setChoiceNeeded(true);
		const applied = await onCommit("");
		if (reqId !== detailsReqRef.current || applied !== false) return;
		reqRef.current += 1;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		setLoading(false);
		setResults([]);
		setDraft(null);
		setChoiceNeeded(false);
	}

	const showError = state.touched && !state.valid;
	const inputClass = `nova-focusable w-full h-11 rounded-lg border bg-pv-input-bg py-2 pl-8 pr-9 text-sm text-nova-text outline-none transition-colors placeholder:text-nova-text-muted ${
		showError || choiceNeeded
			? "border-nova-rose/50"
			: "border-pv-input-border focus:border-pv-input-focus"
	}`;

	return (
		<div data-address-search={field.uuid}>
			{searches ? (
				<Autocomplete.Root
					items={results}
					mode="none"
					value={query}
					itemToStringValue={(item: Suggestion) => item.label}
					onValueChange={(next, details) => {
						if (details.reason === "item-press") {
							const picked = results.find((result) => result.label === next);
							setResults([]);
							if (picked) void choose(picked);
							return;
						}
						void search(next);
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
							placeholder={runtimeMessage(language, "addressSearchPlaceholder")}
							autoComplete="off"
							data-1p-ignore
							aria-labelledby={labelledBy}
							aria-invalid={showError || choiceNeeded || undefined}
							onBlur={onBlur}
							className={inputClass}
						/>
						{query !== "" && (
							<button
								type="button"
								onClick={() => void clear()}
								aria-label={runtimeMessage(language, "clearAddress")}
								className="nova-focusable absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-nova-text-muted hover:text-nova-text"
							>
								<Icon icon={tablerX} width="14" height="14" aria-hidden />
							</button>
						)}
					</Autocomplete.InputGroup>
					<Autocomplete.Portal>
						<Autocomplete.Positioner
							dir={direction}
							side="bottom"
							align="start"
							sideOffset={4}
							className={`${FLOATING_LAYER_CLS} ${MENU_SUBMENU_POSITIONER_CLS}`}
							style={{ minWidth: "var(--anchor-width)", maxWidth: 420 }}
						>
							<Autocomplete.Popup className={`${MENU_POPUP_CLS} w-full`}>
								<Autocomplete.Empty>
									<div className="px-3 py-2 text-xs text-nova-text-muted">
										{loading
											? runtimeMessage(language, "addressSearching")
											: query.trim().length < MIN_QUERY
												? runtimeMessage(language, "addressSearchMinimum", {
														count: MIN_QUERY,
													})
												: runtimeMessage(language, "addressNoResults")}
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
			) : (
				<input
					type="text"
					readOnly
					value={answerLine}
					aria-labelledby={labelledBy}
					placeholder={runtimeMessage(language, "addressSearchPlaceholder")}
					className="w-full h-11 rounded-lg border border-pv-input-border bg-pv-input-bg px-3 text-sm text-nova-text-muted outline-none"
				/>
			)}
			{choiceNeeded && (
				<ValidationError
					message={runtimeMessage(language, "addressChooseFromList")}
				/>
			)}
			{showError && !choiceNeeded && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
			{!searches && (
				<p className="mt-1 text-xs text-nova-text-muted">
					{context === "search"
						? "Preview can search for addresses once a map provider is set up."
						: "Preview can search for addresses once a map provider is set up. In Web Apps the worker searches and chooses an address."}
				</p>
			)}
			{note !== null && (
				<p className="mt-1 text-xs text-nova-text-muted">{note}</p>
			)}
		</div>
	);
}
