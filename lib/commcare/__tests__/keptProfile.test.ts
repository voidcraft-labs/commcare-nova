/**
 * `targetProfileProperties`: the profile settings a `.ccz` made for one
 * project space writes. The failures it catches: a seeded setting written at
 * Nova's seed over the value the project space holds (the archive and HQ's
 * build there then disagree), a `force` lost on the way, one of the two
 * settings Nova owns taken from the project space, the detail-view log
 * setting written where nothing holds it, and a deployment Nova brought in
 * given Nova's seeds.
 */

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	appProfileProperties,
	OWNED_PROFILE_PROPERTY_KEYS,
	SEEDED_PROFILE_PROPERTIES,
} from "../appProfileSettings";
import { targetProfileProperties } from "../keptProfile";
import { KEPT_PROFILE_PROPERTY_KEYS } from "../targetFacts";

const DOC = buildDoc({
	appName: "Clinic",
	appSettings: { showSavedForms: true, showIncompleteForms: false },
});

/** A choice of each seeded setting other than Nova's seed (`commcare-profile-settings.yml`). */
const OTHER_CHOICES: Readonly<Record<string, string>> = {
	"cc-fuzzy-search-enabled": "yes",
	"cc-gps-auto-capture-accuracy": "20",
	"cc-content-valid": "yes",
	"cc-autoup-freq": "freq-daily",
	"cc-enable-tts": "yes",
	"cc-autosync-freq": "freq-weekly",
	"cc-days-form-retain": "31",
	"cc-inflation-target-density": "240",
	"cc-label-required-questions-with-asterisk": "yes",
	"cc-login-duration-seconds": "3600",
	"cc-maps-default-layer": "satellite",
	"cc-resize-images": "half",
	logenabled: "Disabled",
	"unsent-number-limit": "20",
	"unsent-time-limit": "14",
};

function facts(
	profileProperties: Readonly<Record<string, string>>,
	seeds: "nova" | "target" = "nova",
) {
	return { profileProperties, seeds };
}

describe("targetProfileProperties", () => {
	it("writes Nova's own seventeen where no project space was read", () => {
		expect(targetProfileProperties(DOC, null)).toEqual(
			appProfileProperties(DOC),
		);
	});

	it("writes each seeded setting at the project space's value, with its own force", () => {
		const written = targetProfileProperties(DOC, facts(OTHER_CHOICES));
		expect(written).toEqual(
			appProfileProperties(DOC).map((property) => ({
				...property,
				value: OTHER_CHOICES[property.key] ?? property.value,
			})),
		);
		/* The map layer is the one setting HQ writes without `force`. */
		expect(written.find(({ key }) => key === "cc-maps-default-layer")).toEqual({
			key: "cc-maps-default-layer",
			value: "satellite",
			force: false,
		});
	});

	it("writes Nova's seed for a setting the project space holds no value for", () => {
		const written = targetProfileProperties(
			DOC,
			facts({ "cc-autoup-freq": "freq-daily" }),
		);
		expect(written).toEqual(
			appProfileProperties(DOC).map((property) =>
				property.key === "cc-autoup-freq"
					? { ...property, value: "freq-daily" }
					: property,
			),
		);
	});

	it("never takes the two settings Nova owns from the project space", () => {
		const written = targetProfileProperties(
			DOC,
			facts({ "cc-show-saved": "no", "cc-show-incomplete": "yes" }),
		);
		const owned = Object.fromEntries(
			written
				.filter(({ key }) =>
					(OWNED_PROFILE_PROPERTY_KEYS as readonly string[]).includes(key),
				)
				.map(({ key, value }) => [key, value]),
		);
		expect(owned).toEqual({
			"cc-show-saved": "yes",
			"cc-show-incomplete": "no",
		});
	});

	it("writes the detail-view log setting, forced and last, only where the project space holds it", () => {
		expect(
			targetProfileProperties(DOC, facts({})).map(({ key }) => key),
		).not.toContain("cc-log-entity-detail-enabled");
		expect(
			targetProfileProperties(
				DOC,
				facts({ "cc-log-entity-detail-enabled": "True" }),
			).at(-1),
		).toEqual({
			key: "cc-log-entity-detail-enabled",
			value: "True",
			force: true,
		});
	});

	it("leaves out a seeded setting a project space Nova brought in holds no value for", () => {
		const written = targetProfileProperties(
			DOC,
			facts({ "cc-fuzzy-search-enabled": "yes" }, "target"),
		);
		expect(written.map(({ key, value }) => [key, value])).toEqual([
			["cc-fuzzy-search-enabled", "yes"],
			["cc-show-saved", "yes"],
			["cc-show-incomplete", "no"],
		]);
	});

	it("reads no inherited key as a value the project space holds", () => {
		expect(
			targetProfileProperties(
				DOC,
				facts(Object.create({ logenabled: "Disabled" })),
			),
		).toEqual(appProfileProperties(DOC));
	});

	it("keeps the fifteen seeded settings first among the kept keys, in profile order", () => {
		expect(KEPT_PROFILE_PROPERTY_KEYS.slice(0, 15)).toEqual(
			SEEDED_PROFILE_PROPERTIES.map(({ key }) => key),
		);
	});
});
