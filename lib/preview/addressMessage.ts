/**
 * What Web Apps' address search saves and sends for a chosen address, from
 * the place Preview's geocoder found.
 *
 * Web Apps' `AddressEntry` answers the question with the JSON of the object
 * `form_entry/utils.js::getAddressBroadcastObject` builds from its Mapbox
 * result, and sends that same object to the question's channels. Preview
 * searches with Google's Places API, so each part comes from the address
 * component of the same rank: Mapbox's `postcode` is Google's `postal_code`,
 * its `place` the `locality` (or `postal_town` where a country has no
 * locality), its `district` the second administrative level, its `region`
 * the first and its `country` the country. Keys follow Web Apps' order:
 * `full` and `geopoint`, then each part as Mapbox lists its context, from
 * the postcode up to the country, then `street`. The places and their
 * spellings come from a different provider, so they can differ from the
 * ones Web Apps offers; the keys a receiver reads are the same.
 */

/** One part of a found address, as Google's Places API gives it. */
export interface FoundAddressPart {
	readonly longText: string | null;
	readonly shortText: string | null;
	readonly types: readonly string[];
}

/** A place Preview's geocoder found. */
export interface FoundAddress {
	/** The whole address as one line. */
	readonly full: string;
	readonly latitude: number;
	readonly longitude: number;
	readonly parts: readonly FoundAddressPart[];
}

function part(
	found: FoundAddress,
	...types: readonly string[]
): FoundAddressPart | undefined {
	for (const type of types) {
		const match = found.parts.find(
			(candidate) =>
				candidate.types.includes(type) && (candidate.longText ?? "").length > 0,
		);
		if (match !== undefined) return match;
	}
	return undefined;
}

/** The object Web Apps saves as the answer and sends to the question's channels. */
export function addressMessage(
	found: FoundAddress,
): Readonly<Record<string, string>> {
	const message: Record<string, string> = {
		full: found.full,
		geopoint: `${found.latitude} ${found.longitude}`,
	};
	const postcode = part(found, "postal_code");
	if (postcode?.longText) {
		message.zipcode = postcode.longText;
		message.postcode = postcode.longText;
	}
	const city = part(found, "locality", "postal_town");
	if (city?.longText) message.city = city.longText;
	const district = part(found, "administrative_area_level_2");
	if (district?.longText) {
		message.county = district.longText;
		message.district = district.longText;
	}
	const country = part(found, "country");
	const region = part(found, "administrative_area_level_1");
	if (region?.longText) {
		message.region = region.longText;
		message.state_long = region.longText;
		if (region.shortText) message.state_short = region.shortText;
		/* Web Apps names a region a US state where Mapbox's code starts `US-`. */
		if (country?.shortText === "US" && region.shortText) {
			message.us_state = region.longText;
			message.us_state_short = region.shortText;
		}
	}
	if (country?.longText) {
		message.country = country.longText;
		/* Mapbox writes a country's code in lower case. */
		if (country.shortText)
			message.country_short = country.shortText.toLowerCase();
	}
	const number = part(found, "street_number")?.longText ?? "";
	const street = part(found, "route")?.longText ?? "";
	/* Web Apps writes `street` even where both halves are missing, as
	 * undefined, which its JSON leaves out. */
	const line = number && street ? `${number} ${street}` : number || street;
	if (line) message.street = line;
	return message;
}

/** The address line a saved answer shows, or the empty string for none. */
export function addressAnswerLine(answer: string): string {
	if (answer === "") return "";
	try {
		const parsed: unknown = JSON.parse(answer);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { full?: unknown }).full === "string"
		)
			return (parsed as { full: string }).full;
	} catch {
		/* A value written some other way shows as it is. */
	}
	return answer;
}
