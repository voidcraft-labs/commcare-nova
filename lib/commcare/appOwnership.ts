/**
 * What one import body writes inside the keys HQ holds beside Nova's own:
 * the add-on slugs it sets, the `profile.properties` and
 * `profile.custom_properties` keys it carries, and whether it writes
 * `auto_gps_capture`.
 *
 * The drift baseline records this descriptor with HQ's read after the body
 * landed, and the next comparison projects both reads onto it, so only what
 * the body wrote is compared there. It is read from the body's own bytes, so
 * it never names a key the body does not hold.
 */

import type { HqApplication } from "./types";

/** The overlay keys one body writes. Structurally `lib/deployment/types.ts::AppOwnership`. */
export interface AppOwnershipDescriptor {
	readonly addOns: readonly string[];
	readonly profileProperties: readonly string[];
	readonly profileCustomProperties: readonly string[];
	readonly autoGpsCapture: boolean;
}

function recordKeys(value: unknown): readonly string[] {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.keys(value).sort()
		: [];
}

/** The descriptor of one import body, the empty shell's or an update's. */
export function appOwnershipOf(
	appJson: Pick<HqApplication, "auto_gps_capture" | "add_ons"> &
		Partial<Pick<HqApplication, "profile">>,
): AppOwnershipDescriptor {
	const profile = appJson.profile;
	return {
		addOns: recordKeys(appJson.add_ons),
		profileProperties: recordKeys(profile?.properties),
		profileCustomProperties: recordKeys(profile?.custom_properties),
		autoGpsCapture: Object.hasOwn(appJson, "auto_gps_capture"),
	};
}

function pickKeys(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const source = value as Record<string, unknown>;
	const picked: Record<string, unknown> = {};
	for (const key of keys) {
		if (Object.hasOwn(source, key)) picked[key] = source[key];
	}
	return picked;
}

/**
 * The part of a read's `profile` one body owns: its `properties` and
 * `custom_properties` narrowed to the keys the descriptor names.
 */
export function ownedProfile(
	profile: unknown,
	ownership: Pick<
		AppOwnershipDescriptor,
		"profileProperties" | "profileCustomProperties"
	>,
): Record<string, unknown> {
	const source =
		typeof profile === "object" && profile !== null && !Array.isArray(profile)
			? (profile as Record<string, unknown>)
			: {};
	return {
		properties: pickKeys(source.properties, ownership.profileProperties),
		custom_properties: pickKeys(
			source.custom_properties,
			ownership.profileCustomProperties,
		),
	};
}
