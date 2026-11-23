/**
 * What Preview's address search saves and sends (`addressMessage.ts`).
 *
 * Contract: the object holds the keys Web Apps'
 * `form_entry/utils.js::getAddressBroadcastObject` writes for the same rank
 * of address part, in its order, since the saved answer is that object's
 * JSON and a receiver reads one key of it. The plausible failures are a key
 * spelled differently from Web Apps' (a receiver set to `zipcode` would then
 * read nothing), a part read from the wrong rank, a US-only key written for
 * another country, and a key written empty where Web Apps leaves it out.
 */

import { describe, expect, it } from "vitest";
import {
	addressAnswerLine,
	addressMessage,
	type FoundAddress,
} from "../addressMessage";

const part = (longText: string, shortText: string, ...types: string[]) => ({
	longText,
	shortText,
	types,
});

const SPRINGFIELD: FoundAddress = {
	full: "742 Evergreen Terrace, Springfield, IL 62704, USA",
	latitude: 39.78,
	longitude: -89.65,
	parts: [
		part("742", "742", "street_number"),
		part("Evergreen Terrace", "Evergreen Terrace", "route"),
		part("Springfield", "Springfield", "locality", "political"),
		part(
			"Sangamon County",
			"Sangamon County",
			"administrative_area_level_2",
			"political",
		),
		part("Illinois", "IL", "administrative_area_level_1", "political"),
		part("United States", "US", "country", "political"),
		part("62704", "62704", "postal_code"),
	],
};

describe("addressMessage", () => {
	it("writes Web Apps' keys in Web Apps' order for a US street address", () => {
		const message = addressMessage(SPRINGFIELD);
		expect(Object.entries(message)).toEqual([
			["full", "742 Evergreen Terrace, Springfield, IL 62704, USA"],
			["geopoint", "39.78 -89.65"],
			["zipcode", "62704"],
			["postcode", "62704"],
			["city", "Springfield"],
			["county", "Sangamon County"],
			["district", "Sangamon County"],
			["region", "Illinois"],
			["state_long", "Illinois"],
			["state_short", "IL"],
			["us_state", "Illinois"],
			["us_state_short", "IL"],
			["country", "United States"],
			["country_short", "us"],
			["street", "742 Evergreen Terrace"],
		]);
	});

	it("names no US state outside the US, takes a postal town for a city, and leaves out what the place lacks", () => {
		const message = addressMessage({
			full: "Kendal, UK",
			latitude: 54.33,
			longitude: -2.75,
			parts: [
				part("Kendal", "Kendal", "postal_town"),
				part("England", "England", "administrative_area_level_1"),
				part("United Kingdom", "GB", "country"),
			],
		});
		expect(message).toEqual({
			full: "Kendal, UK",
			geopoint: "54.33 -2.75",
			city: "Kendal",
			region: "England",
			state_long: "England",
			state_short: "England",
			country: "United Kingdom",
			country_short: "gb",
		});
	});

	it("saves the JSON whose line the box shows again", () => {
		const answer = JSON.stringify(addressMessage(SPRINGFIELD));
		expect(addressAnswerLine(answer)).toBe(SPRINGFIELD.full);
		expect(addressAnswerLine("")).toBe("");
		expect(addressAnswerLine("typed by hand")).toBe("typed by hand");
	});
});
