import { z } from "zod";

// Only Google's external SDK is replaced. Nova's loader, geolocation adapter,
// continuation owners, Base UI controls, and engine all run unchanged.
export function setOptions() {}
const calls = new Set<Promise<unknown>>();
async function request(path: string) {
	const call = fetch(`/geopoint-peer/${path}`).then(async (response) => {
		if (!response.ok)
			throw new Error(`Google peer returned ${response.status}`);
		return response.json();
	});
	calls.add(call);
	try {
		return await call;
	} finally {
		calls.delete(call);
	}
}
export async function settleGooglePeer() {
	await Promise.allSettled([...calls]);
}
const suggestionSchema = z.array(
	z.object({ id: z.string(), label: z.string() }),
);
const detailSchema = z.object({
	lat: z.number(),
	lng: z.number(),
	label: z.string(),
});
class Place {
	location?: { lat(): number; lng(): number };
	formattedAddress?: string;
	constructor(private id: string) {}
	async fetchFields() {
		const detail = detailSchema.parse(
			await request(`details?place=${this.id}`),
		);
		this.location = { lat: () => detail.lat, lng: () => detail.lng };
		this.formattedAddress = detail.label;
	}
}
export async function importLibrary(name: string) {
	if (name === "places")
		return {
			AutocompleteSessionToken: class {},
			AutocompleteSuggestion: {
				async fetchAutocompleteSuggestions({ input }: { input: string }) {
					const rows = suggestionSchema.parse(
						await request(`suggestions?query=${encodeURIComponent(input)}`),
					);
					return {
						suggestions: rows.map((row) => ({
							placePrediction: {
								placeId: row.id,
								text: { text: row.label },
								toPlace: () => new Place(row.id),
							},
						})),
					};
				},
			},
		};
	if (name === "geocoding")
		return {
			Geocoder: class {
				async geocode({
					location,
				}: {
					location: { lat: number; lng: number };
				}) {
					return {
						results: z
							.array(z.object({ formatted_address: z.string() }))
							.parse(await request(`reverse?lat=${location.lat}`)),
					};
				}
			},
		};
	// Tile rendering and gestures are outside this continuation-owner proof.
	throw new Error(`Google ${name} unavailable in external peer`);
}
